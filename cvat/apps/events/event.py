# Copyright (C) CVAT.ai Corporation
#
# SPDX-License-Identifier: MIT

from collections.abc import Mapping
from datetime import datetime, timezone

import clickhouse_connect
from django.conf import settings
from django.db import transaction
from rest_framework.renderers import JSONRenderer

from cvat.apps.engine.log import vlogger


def event_scope(action, resource):
    return f"{action}:{resource}"


class EventScopes:
    RESOURCES = {
        "accesstoken": ["create", "update", "delete"],
        "project": ["create", "update", "delete"],
        "task": ["create", "update", "delete"],
        "job": ["create", "update", "delete"],
        "organization": ["create", "update", "delete"],
        "membership": ["create", "update", "delete"],
        "invitation": ["create", "delete"],
        "user": ["create", "update", "delete"],
        "cloudstorage": ["create", "update", "delete"],
        "issue": ["create", "update", "delete"],
        "comment": ["create", "update", "delete"],
        "annotations": ["create", "update", "delete"],
        "label": ["create", "update", "delete"],
        "dataset": ["export", "import"],
        "function": ["call"],
        "webhook": ["create", "update", "delete"],
    }

    @classmethod
    def select(cls, resources):
        return [
            f"{event_scope(action, resource)}"
            for resource in resources
            for action in cls.RESOURCES.get(resource, [])
        ]


EVENT_INSERT_COLUMNS = (
    "scope",
    "obj_name",
    "obj_id",
    "obj_val",
    "source",
    "timestamp",
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
    "access_token_id",
)

def _get_clickhouse_client():
    clickhouse_settings = settings.CLICKHOUSE["events"]
    return clickhouse_connect.get_client(
        host=clickhouse_settings["HOST"],
        database=clickhouse_settings["NAME"],
        port=clickhouse_settings["PORT"],
        username=clickhouse_settings["USER"],
        password=clickhouse_settings["PASSWORD"],
    )


def _insert_events_directly(data_batch: list[dict]) -> bool:
    rows = [
        [data.get(column) for column in EVENT_INSERT_COLUMNS]
        for data in data_batch
    ]

    try:
        with _get_clickhouse_client() as client:
            client.insert("events", rows, column_names=EVENT_INSERT_COLUMNS)
        return True
    except Exception:
        return False


def _insert_event_directly(data: dict) -> bool:
    return _insert_events_directly([data])


def _emit_server_event_to_logger(logger_data: dict) -> None:
    vlogger.info(JSONRenderer().render(logger_data).decode("UTF-8"))


def _emit_server_event(clickhouse_data: dict, logger_data: dict) -> None:
    if not _insert_event_directly(clickhouse_data):
        _emit_server_event_to_logger(logger_data)

def record_server_event(
    *,
    scope: str,
    request_info: Mapping[str, str | int | None],
    payload: dict | None = None,
    on_commit: bool = False,
    **kwargs,
) -> None:
    payload = payload or {}
    event_timestamp = datetime.now(timezone.utc)
    request_metadata = dict(request_info)

    access_token_id = request_metadata.pop("access_token_id", None)
    if access_token_id is not None:
        kwargs.setdefault("access_token_id", access_token_id)

    payload_with_request_info = {
        **payload,
        "request": {
            **payload.get("request", {}),
            **request_metadata,
        },
    }

    clickhouse_data = {
        "scope": scope,
        "timestamp": event_timestamp,
        "source": "server",
        "count": kwargs.get("count"),
        "duration": kwargs.get("duration", 0),
        "payload": JSONRenderer().render(payload_with_request_info).decode("UTF-8"),
        **kwargs,
    }
    logger_data = {
        **clickhouse_data,
        "timestamp": str(event_timestamp.timestamp()),
    }
    dispatch = lambda: _emit_server_event(clickhouse_data, logger_data)

    if on_commit:
        transaction.on_commit(dispatch, robust=True)
    else:
        dispatch()


class EventScopeChoice:
    @classmethod
    def choices(cls):
        return sorted((val, val.upper()) for val in AllEvents.events)


class AllEvents:
    events = list(
        event_scope(action, resource)
        for resource, actions in EventScopes.RESOURCES.items()
        for action in actions
    )
