# Copyright (C) CVAT.ai Corporation
#
# SPDX-License-Identifier: MIT

import base64
import csv
import json
import os
import uuid
from datetime import datetime, timedelta

import clickhouse_connect
from dateutil import parser
from django.conf import settings
from django.utils import timezone
from rest_framework import serializers, status
from rest_framework.response import Response
from rest_framework.reverse import reverse

from cvat.apps.dataset_manager.util import ExportCacheManager
from cvat.apps.dataset_manager.views import log_exception
from cvat.apps.engine.log import ServerLogManager
from cvat.apps.engine.models import RequestAction
from cvat.apps.engine.rq import ExportRequestId, RQMetaWithFailureInfo
from cvat.apps.engine.types import ExtendedRequest
from cvat.apps.engine.utils import sendfile
from cvat.apps.engine.view_utils import deprecate_response
from cvat.apps.events.permissions import EventsPermission
from cvat.apps.events.utils import find_minimal_date_for_filter
from cvat.apps.redis_handler.background import AbstractExporter

slogger = ServerLogManager(__name__)

DEFAULT_CACHE_TTL = timedelta(hours=1)
TARGET = "events"
EVENT_RESOURCE_FILTERS = ("org_id", "project_id", "task_id", "job_id", "user_id")
EVENT_DATETIME_FILTERS = ("from", "to")
EVENT_BASE_CONDITIONS = ("source in ('server', 'client')", "scope != 'send:exception'")
EVENT_COLUMNS = (
    "scope",
    "timestamp",
    "obj_name",
    "obj_id",
    "obj_val",
    "source",
    "count",
    "duration",
    "project_id",
    "task_id",
    "job_id",
    "user_id",
    "user_name",
    "user_email",
    "org_id",
    "org_slug",
    "payload",
)
# Use more than timestamp in the cursor so pages do not skip or repeat rows
# when many events share the same timestamp.
EVENT_CURSOR_FIELDS = (
    ("timestamp", "timestamp", "DateTime64", None, None),
    ("scope", "scope", "String", "", None),
    ("obj_name", "ifNull(obj_name, '')", "String", "", None),
    ("obj_id", "ifNull(obj_id, 0)", "UInt64", 0, None),
    ("obj_val", "ifNull(obj_val, '')", "String", "", None),
    ("source", "source", "String", "", None),
    ("count", "ifNull(count, 0)", "Int64", 0, None),
    ("duration", "ifNull(duration, 0)", "Int64", 0, None),
    ("project_id", "ifNull(project_id, 0)", "UInt64", 0, None),
    ("task_id", "ifNull(task_id, 0)", "UInt64", 0, None),
    ("job_id", "ifNull(job_id, 0)", "UInt64", 0, None),
    ("user_id", "ifNull(user_id, 0)", "UInt64", 0, None),
    ("org_id", "ifNull(org_id, 0)", "UInt64", 0, None),
    (
        "access_token_id",
        "ifNull(access_token_id, 0)",
        "UInt64",
        0,
        "ifNull(access_token_id, 0) AS access_token_id",
    ),
    (
        "payload_signature",
        "hex(SHA256(ifNull(payload, '')))",
        "String",
        "",
        "hex(SHA256(ifNull(payload, ''))) AS payload_signature",
    ),
)


def _encode_event_cursor(row: dict) -> str:
    cursor_payload = {}
    for (
        field_name,
        _,
        _,
        default_value,
        _,
    ) in EVENT_CURSOR_FIELDS:
        value = row.get(field_name, default_value)
        if field_name == "timestamp":
            cursor_payload[field_name] = (
                value.isoformat() if isinstance(value, datetime) else str(value)
            )
        else:
            cursor_payload[field_name] = default_value if value is None else value

    return base64.urlsafe_b64encode(json.dumps(cursor_payload).encode("utf-8")).decode("ascii")


def _decode_event_cursor(cursor: str) -> dict:
    try:
        padding = "=" * (-len(cursor) % 4)
        decoded_cursor = base64.urlsafe_b64decode(f"{cursor}{padding}".encode("ascii")).decode(
            "utf-8"
        )
        cursor_payload = json.loads(decoded_cursor)
    except Exception as ex:
        raise serializers.ValidationError("Cannot parse events cursor") from ex

    if not isinstance(cursor_payload, dict):
        raise serializers.ValidationError("Events cursor payload is invalid")

    decoded = {}
    for (
        field_name,
        _,
        _,
        default_value,
        _,
    ) in EVENT_CURSOR_FIELDS:
        value = cursor_payload.get(field_name, default_value)
        if field_name == "timestamp":
            if not value:
                raise serializers.ValidationError("Events cursor is missing timestamp")
            try:
                decoded[field_name] = parser.isoparse(value)
            except (TypeError, ValueError) as ex:
                raise serializers.ValidationError("Events cursor timestamp is invalid") from ex
        elif isinstance(default_value, int):
            try:
                decoded[field_name] = int(value)
            except (TypeError, ValueError) as ex:
                raise serializers.ValidationError(
                    f"Events cursor field {field_name!r} is invalid"
                ) from ex
        else:
            decoded[field_name] = default_value if value is None else str(value)

    return decoded


def _get_clickhouse_client():
    clickhouse_settings = settings.CLICKHOUSE["events"]
    return clickhouse_connect.get_client(
        host=clickhouse_settings["HOST"],
        database=clickhouse_settings["NAME"],
        port=clickhouse_settings["PORT"],
        username=clickhouse_settings["USER"],
        password=clickhouse_settings["PASSWORD"],
    )


def _normalize_event_query_params(query_params: dict) -> dict:
    normalized = {**query_params}

    for datetime_filter in EVENT_DATETIME_FILTERS:
        value = normalized.get(datetime_filter)
        if not value:
            normalized[datetime_filter] = None
            continue

        if isinstance(value, datetime):
            normalized[datetime_filter] = value
            continue

        try:
            normalized[datetime_filter] = parser.isoparse(value)
        except (TypeError, parser.ParserError):
            raise serializers.ValidationError(
                f"Cannot parse {datetime_filter!r} datetime parameter: {value}"
            )

    if normalized["from"] and normalized["to"] and normalized["from"] > normalized["to"]:
        raise serializers.ValidationError("'from' must be before than 'to'")

    if not normalized["from"]:
        normalized["from"] = find_minimal_date_for_filter(
            job_id=normalized.get("job_id"),
            task_id=normalized.get("task_id"),
            project_id=normalized.get("project_id"),
            org_id=normalized.get("org_id"),
        )

    if not normalized["to"]:
        normalized["to"] = datetime.now(timezone.utc)

    cursor = normalized.get("cursor")
    normalized["cursor_data"] = _decode_event_cursor(cursor) if cursor else None

    return normalized


def _get_events_list_columns() -> str:
    columns = list(EVENT_COLUMNS)
    for (
        field_name,
        _,
        _,
        _,
        select_expression,
    ) in EVENT_CURSOR_FIELDS:
        if select_expression and field_name not in EVENT_COLUMNS:
            columns.append(select_expression)

    return ", ".join(columns)


def _validate_events_select_clause(columns: str) -> str:
    if columns not in {_get_events_list_columns(), "count()", "*"}:
        raise ValueError("Unsupported events query columns")

    return columns


def _validate_events_sort_order(order: str) -> str:
    if order not in {"ASC", "DESC", ""}:
        raise ValueError("Unsupported events query order")

    return order


def _build_events_query(
    query_params: dict,
    *,
    columns: str,
    order: str = "DESC",
    limit: int | None = None,
    offset: int | None = None,
) -> tuple[str, dict]:
    columns = _validate_events_select_clause(columns)
    order = _validate_events_sort_order(order)
    conditions = list(EVENT_BASE_CONDITIONS)
    parameters = {}

    if query_params.get("from"):
        conditions.append("timestamp >= {from:DateTime64}")
        parameters["from"] = query_params["from"]

    if query_params.get("to"):
        conditions.append("timestamp <= {to:DateTime64}")
        parameters["to"] = query_params["to"]

    for param in EVENT_RESOURCE_FILTERS:
        value = query_params.get(param)
        if value is not None:
            conditions.append(f"{param} = {{{param}:UInt64}}")
            parameters[param] = value

    cursor_data = query_params.get("cursor_data")
    if cursor_data:
        cursor_expressions = ", ".join(expression for _, expression, _, _, _ in EVENT_CURSOR_FIELDS)
        cursor_placeholders = ", ".join(
            f"{{cursor_{field_name}:{field_type}}}"
            for field_name, _, field_type, _, _ in EVENT_CURSOR_FIELDS
        )
        conditions.append(f"({cursor_expressions}) < ({cursor_placeholders})")
        for (
            field_name,
            _,
            _,
            _,
            _,
        ) in EVENT_CURSOR_FIELDS:
            parameters[f"cursor_{field_name}"] = cursor_data[field_name]

    obj_name = query_params.get("obj_name")
    if obj_name:
        obj_names = [name.strip() for name in obj_name.split(",") if name.strip()]
        placeholders = []
        for index, name in enumerate(obj_names):
            parameter_name = f"obj_name_{index}"
            placeholders.append(f"{{{parameter_name}:String}}")
            parameters[parameter_name] = name
        if placeholders:
            conditions.append(f"obj_name IN ({', '.join(placeholders)})")

    scope = query_params.get("scope")
    if scope:
        conditions.append("scope = {scope:String}")
        parameters["scope"] = scope

    # Bandit cannot infer that the select clause is constrained to internal constants.
    query = f"SELECT {columns} FROM events"  # nosec B608
    if conditions:
        query += " WHERE " + " AND ".join(conditions)

    if order:
        order_by = ", ".join(
            f"{expression} {order}" for _, expression, _, _, _ in EVENT_CURSOR_FIELDS
        )
        query += f" ORDER BY {order_by}"

    if limit is not None:
        query += " LIMIT {limit:UInt64}"
        parameters["limit"] = limit

    if offset:
        query += " OFFSET {offset:UInt64}"
        parameters["offset"] = offset

    return query, parameters


def _deserialize_event(row: dict) -> dict:
    payload = row.get("payload")
    if payload:
        try:
            row["payload"] = json.loads(payload)
        except json.JSONDecodeError:
            row["payload"] = None
    else:
        row["payload"] = None

    return row


def list_events(
    query_params: dict,
    *,
    page: int,
    page_size: int,
    include_count: bool = True,
) -> dict:
    try:
        normalized_query_params = _normalize_event_query_params(query_params)
        uses_cursor = bool(normalized_query_params.get("cursor_data"))
        offset = None if uses_cursor else (page - 1) * page_size
        # Read one extra row so we can tell the client whether another page exists.
        query_limit = page_size + 1 if uses_cursor or not include_count else page_size
        events_query, events_parameters = _build_events_query(
            normalized_query_params,
            columns=_get_events_list_columns(),
            limit=query_limit,
            offset=offset,
        )

        with _get_clickhouse_client() as client:
            events_result = client.query(events_query, parameters=events_parameters)
            if include_count:
                # Numbered pages need an exact count, but cursor browsing can skip
                # it to keep long history queries lighter.
                count_query, count_parameters = _build_events_query(
                    normalized_query_params,
                    columns="count()",
                    order="",
                )
                count_result = client.query(count_query, parameters=count_parameters)
            else:
                count_result = None

        result_rows = events_result.result_rows
        fetched_extra_row = len(result_rows) > page_size
        if fetched_extra_row:
            result_rows = result_rows[:page_size]

        has_more = False
        if include_count:
            total = (
                count_result.result_rows[0][0] if count_result and count_result.result_rows else 0
            )
            consumed_rows = len(result_rows) if uses_cursor else offset + len(result_rows)
            if uses_cursor:
                # Cursor-based pagination already fetches one extra row, so it can
                # determine whether another page exists without guessing how many
                # rows were consumed by previous cursors.
                has_more = fetched_extra_row
            else:
                has_more = total > consumed_rows
        else:
            has_more = fetched_extra_row
            total = (
                len(result_rows) + int(has_more)
                if uses_cursor
                else offset + len(result_rows) + int(has_more)
            )

        raw_results = [dict(zip(events_result.column_names, row)) for row in result_rows]
        next_cursor = _encode_event_cursor(raw_results[-1]) if has_more and raw_results else None
        results = [
            _deserialize_event({column: row.get(column) for column in EVENT_COLUMNS})
            for row in raw_results
        ]

        return {
            "count": total,
            "page": page,
            "page_size": page_size,
            "has_more": has_more,
            "next_cursor": next_cursor,
            "results": results,
        }
    except Exception:
        log_exception(slogger.glob)
        raise


def _create_csv(query_params: dict, output_filename: str):
    try:
        normalized_query_params = _normalize_event_query_params(query_params)
        query, parameters = _build_events_query(
            normalized_query_params,
            columns="*",
            order="ASC",
        )

        with _get_clickhouse_client() as client:
            result = client.query(query, parameters=parameters)

        with open(output_filename, "w", encoding="UTF8") as f:
            writer = csv.writer(f)
            writer.writerow(result.column_names)
            writer.writerows(result.result_rows)

        return output_filename
    except Exception:
        log_exception(slogger.glob)
        raise


class EventsExporter(AbstractExporter):

    def __init__(
        self,
        *,
        request: ExtendedRequest,
    ) -> None:
        super().__init__(request=request)

        # temporary arg
        if query_id := self.request.query_params.get("query_id"):
            self.query_id = uuid.UUID(query_id)
        else:
            self.query_id = uuid.uuid4()

    def build_request_id(self):
        return ExportRequestId(
            target=TARGET,
            id=self.query_id,
            user_id=self.user_id,
        ).render()

    def validate_request_id(self, request_id, /) -> None:
        parsed_request_id: ExportRequestId = ExportRequestId.parse_and_validate_queue(
            request_id,
            expected_queue=self.QUEUE_NAME,  # try_legacy_format is not set here since deprecated API accepts query_id, not the whole Request ID
        )

        if parsed_request_id.action != RequestAction.EXPORT or parsed_request_id.target != TARGET:
            raise ValueError("The provided request id does not match exported target")

    def init_request_args(self):
        super().init_request_args()
        perm = EventsPermission.create_scope_list(self.request)
        self.filter_query = perm.filter(self.request.query_params)

    def _init_callback_with_params(self):
        self.callback = _create_csv

        query_params = _normalize_event_query_params(
            {k: self.filter_query.get(k) for k in EVENT_RESOURCE_FILTERS + EVENT_DATETIME_FILTERS}
        )

        output_filename = ExportCacheManager.make_file_path(
            file_type="events", file_id=self.query_id, file_ext="csv"
        )
        self.callback_args = (query_params, output_filename)

    def get_result_endpoint_url(self) -> str:
        return reverse("events-download-file", request=self.request)

    def get_result_filename(self):
        if self.export_args.filename:
            return self.export_args.filename

        timestamp = self.get_file_timestamp()
        return f"logs_{timestamp}.csv"


# FUTURE-TODO: delete deprecated function after several releases
def export(request: ExtendedRequest):
    action = request.query_params.get("action")
    if action not in (None, "download"):
        raise serializers.ValidationError("Unexpected action specified for the request")

    filename = request.query_params.get("filename")
    manager = EventsExporter(request=request)
    request_id = manager.build_request_id()
    queue = manager.get_queue()

    response_data = {
        "query_id": manager.query_id,
    }
    deprecation_date = datetime(2025, 3, 17, tzinfo=timezone.utc)
    rq_job = queue.fetch_job(request_id)

    if rq_job:
        if rq_job.is_finished:
            file_path = rq_job.return_value()
            if action == "download" and os.path.exists(file_path):
                rq_job.delete()
                timestamp = datetime.strftime(datetime.now(), "%Y_%m_%d_%H_%M_%S")
                filename = filename or f"logs_{timestamp}.csv"

                return sendfile(request, file_path, attachment=True, attachment_filename=filename)
            else:
                if os.path.exists(file_path):
                    response = Response(status=status.HTTP_201_CREATED)
                    deprecate_response(response, deprecation_date=deprecation_date)
                    return response

        elif rq_job.is_failed:
            rq_job_meta = RQMetaWithFailureInfo.for_job(rq_job)
            exc_info = rq_job_meta.formatted_exception or str(rq_job.exc_info)
            rq_job.delete()
            response = Response(
                exc_info,
                status=status.HTTP_500_INTERNAL_SERVER_ERROR,
            )
            deprecate_response(response, deprecation_date=deprecation_date)
            return response
        else:
            response = Response(
                data=response_data,
                status=status.HTTP_202_ACCEPTED,
            )
            deprecate_response(response, deprecation_date=deprecation_date)
            return response

    manager.init_request_args()
    # request validation is missed here since exporting to a cloud_storage is disabled
    manager._set_default_callback_params()
    manager.init_callback_with_params()
    manager.setup_new_job(queue, request_id)

    response = Response(data=response_data, status=status.HTTP_202_ACCEPTED)
    deprecate_response(response, deprecation_date=deprecation_date)
    return response
