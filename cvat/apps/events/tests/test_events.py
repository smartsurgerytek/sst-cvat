# Copyright (C) CVAT.ai Corporation
#
# SPDX-License-Identifier: MIT

import base64
import json
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

from django.contrib.auth import get_user_model
from django.test import RequestFactory
from rest_framework import status
from rest_framework.test import APIRequestFactory

from cvat.apps.events.const import MAX_EVENT_DURATION, WORKING_TIME_RESOLUTION
from cvat.apps.events.event import record_server_event
from cvat.apps.events.export import _build_events_query, list_events
from cvat.apps.events.serializers import ClientEventsSerializer
from cvat.apps.events.utils import compute_working_time_per_ids, is_contained
from cvat.apps.events.views import EventsViewSet
from cvat.apps.organizations.models import Organization


class WorkingTimeTestCase(unittest.TestCase):
    _START_TIMESTAMP = datetime(2024, 1, 1, 12)
    _SHORT_GAP = MAX_EVENT_DURATION - timedelta(milliseconds=1)
    _SHORT_GAP_INT = _SHORT_GAP / WORKING_TIME_RESOLUTION
    _LONG_GAP = MAX_EVENT_DURATION
    _LONG_GAP_INT = _LONG_GAP / WORKING_TIME_RESOLUTION

    @staticmethod
    def _instant_event(timestamp: datetime) -> dict:
        return {
            "scope": "click:element",
            "timestamp": timestamp.isoformat(),
            "duration": 123,
        }

    @staticmethod
    def _compressed_event(timestamp: datetime, duration: timedelta) -> dict:
        return {
            "scope": "change:frame",
            "timestamp": timestamp.isoformat(),
            "duration": duration // WORKING_TIME_RESOLUTION,
        }

    @staticmethod
    def _get_actual_working_times(data: dict) -> list[int]:
        data_copy = data.copy()
        working_times = []
        for event in data["events"]:
            data_copy["events"] = [event]
            event_working_time = compute_working_time_per_ids(data_copy)
            for working_time in event_working_time.values():
                working_times.append(working_time["value"] // WORKING_TIME_RESOLUTION)
            if data_copy["previous_event"] and is_contained(event, data_copy["previous_event"]):
                continue
            data_copy["previous_event"] = event
        return working_times

    @staticmethod
    def _deserialize(events: list[dict], previous_event: dict | None = None) -> dict:
        request = RequestFactory().post("/api/events")
        request.user = get_user_model()(id=100, username="testuser", email="testuser@example.org")
        request.iam_context = {
            "organization": Organization(id=101, slug="testorg", name="Test Organization"),
        }

        s = ClientEventsSerializer(
            data={
                "events": events,
                "previous_event": previous_event,
                "timestamp": datetime.now(timezone.utc),
            },
            context={"request": request},
        )

        s.is_valid(raise_exception=True)

        return s.validated_data

    def test_instant(self):
        data = self._deserialize(
            [
                self._instant_event(self._START_TIMESTAMP),
            ]
        )
        event_times = self._get_actual_working_times(data)
        self.assertEqual(event_times[0], 0)

    def test_compressed(self):
        data = self._deserialize(
            [
                self._compressed_event(self._START_TIMESTAMP, self._LONG_GAP),
            ]
        )
        event_times = self._get_actual_working_times(data)
        self.assertEqual(event_times[0], self._LONG_GAP_INT)

    def test_instants_with_short_gap(self):
        data = self._deserialize(
            [
                self._instant_event(self._START_TIMESTAMP),
                self._instant_event(self._START_TIMESTAMP + self._SHORT_GAP),
            ]
        )
        event_times = self._get_actual_working_times(data)
        self.assertEqual(event_times[0], 0)
        self.assertEqual(event_times[1], self._SHORT_GAP_INT)

    def test_instants_with_long_gap(self):
        data = self._deserialize(
            [
                self._instant_event(self._START_TIMESTAMP),
                self._instant_event(self._START_TIMESTAMP + self._LONG_GAP),
            ]
        )

        event_times = self._get_actual_working_times(data)
        self.assertEqual(event_times[0], 0)
        self.assertEqual(event_times[1], 0)

    def test_compressed_with_short_gap(self):
        data = self._deserialize(
            [
                self._compressed_event(self._START_TIMESTAMP, timedelta(seconds=1)),
                self._compressed_event(
                    self._START_TIMESTAMP + timedelta(seconds=1) + self._SHORT_GAP,
                    timedelta(seconds=5),
                ),
            ]
        )

        event_times = self._get_actual_working_times(data)
        self.assertEqual(event_times[0], 1000)
        self.assertEqual(event_times[1], self._SHORT_GAP_INT + 5000)

    def test_compressed_with_long_gap(self):
        data = self._deserialize(
            [
                self._compressed_event(self._START_TIMESTAMP, timedelta(seconds=1)),
                self._compressed_event(
                    self._START_TIMESTAMP + timedelta(seconds=1) + self._LONG_GAP,
                    timedelta(seconds=5),
                ),
            ]
        )

        event_times = self._get_actual_working_times(data)
        self.assertEqual(event_times[0], 1000)
        self.assertEqual(event_times[1], 5000)

    def test_compressed_contained(self):
        data = self._deserialize(
            [
                self._compressed_event(self._START_TIMESTAMP, timedelta(seconds=5)),
                self._compressed_event(
                    self._START_TIMESTAMP + timedelta(seconds=3), timedelta(seconds=1)
                ),
            ]
        )

        event_times = self._get_actual_working_times(data)
        self.assertEqual(event_times[0], 5000)
        self.assertEqual(event_times[1], 0)

    def test_compressed_overlapping(self):
        data = self._deserialize(
            [
                self._compressed_event(self._START_TIMESTAMP, timedelta(seconds=5)),
                self._compressed_event(
                    self._START_TIMESTAMP + timedelta(seconds=3), timedelta(seconds=6)
                ),
            ]
        )

        event_times = self._get_actual_working_times(data)
        self.assertEqual(event_times[0], 5000)
        self.assertEqual(event_times[1], 4000)

    def test_instant_inside_compressed(self):
        data = self._deserialize(
            [
                self._compressed_event(self._START_TIMESTAMP, timedelta(seconds=5)),
                self._instant_event(self._START_TIMESTAMP + timedelta(seconds=3)),
                self._instant_event(self._START_TIMESTAMP + timedelta(seconds=6)),
            ]
        )

        event_times = self._get_actual_working_times(data)
        self.assertEqual(event_times[0], 5000)
        self.assertEqual(event_times[1], 0)
        self.assertEqual(event_times[2], 1000)

    def test_previous_instant_short_gap(self):
        data = self._deserialize(
            [self._instant_event(self._START_TIMESTAMP + self._SHORT_GAP)],
            previous_event=self._instant_event(self._START_TIMESTAMP),
        )
        event_times = self._get_actual_working_times(data)
        self.assertEqual(event_times[0], self._SHORT_GAP_INT)

    def test_previous_instant_long_gap(self):
        data = self._deserialize(
            [self._instant_event(self._START_TIMESTAMP + self._LONG_GAP)],
            previous_event=self._instant_event(self._START_TIMESTAMP),
        )
        event_times = self._get_actual_working_times(data)
        self.assertEqual(event_times[0], 0)

    def test_previous_compressed_short_gap(self):
        data = self._deserialize(
            [self._instant_event(self._START_TIMESTAMP + timedelta(seconds=1) + self._SHORT_GAP)],
            previous_event=self._compressed_event(self._START_TIMESTAMP, timedelta(seconds=1)),
        )
        event_times = self._get_actual_working_times(data)
        self.assertEqual(event_times[0], self._SHORT_GAP_INT)

    def test_previous_compressed_long_gap(self):
        data = self._deserialize(
            [self._instant_event(self._START_TIMESTAMP + timedelta(seconds=1) + self._LONG_GAP)],
            previous_event=self._compressed_event(self._START_TIMESTAMP, timedelta(seconds=1)),
        )
        event_times = self._get_actual_working_times(data)
        self.assertEqual(event_times[0], 0)


class EventsEntriesViewTestCase(unittest.TestCase):
    def setUp(self):
        self.factory = APIRequestFactory()

    @mock.patch("cvat.apps.events.views.list_events")
    @mock.patch("cvat.apps.events.views.EventsPermission.create_scope_list")
    def test_entries_accepts_from_query_parameter(self, mock_create_scope_list, mock_list_events):
        mock_create_scope_list.return_value.filter.side_effect = lambda params: params
        mock_list_events.return_value = {
            "count": 0,
            "page": 2,
            "page_size": 10,
            "has_more": False,
            "results": [],
        }

        request = self.factory.get(
            "/api/events/entries",
            {
                "from": "2024-01-01T00:00:00Z",
                "to": "2024-01-02T00:00:00Z",
                "job_id": 33,
                "page": 2,
                "page_size": 10,
                "scope": "update:job",
                "obj_name": "assignee,stage,state",
            },
        )

        view = EventsViewSet.as_view({"get": "entries"})
        with mock.patch.object(EventsViewSet, "check_permissions", return_value=None):
            response = view(request)

        self.assertEqual(response.status_code, status.HTTP_200_OK)

        filtered_query = mock_create_scope_list.return_value.filter.call_args.args[0]
        self.assertEqual(filtered_query["job_id"], 33)
        self.assertEqual(filtered_query["scope"], "update:job")
        self.assertEqual(filtered_query["obj_name"], "assignee,stage,state")
        self.assertEqual(filtered_query["from"], datetime(2024, 1, 1, tzinfo=timezone.utc))
        self.assertEqual(filtered_query["to"], datetime(2024, 1, 2, tzinfo=timezone.utc))

        self.assertEqual(mock_list_events.call_args.args[0], filtered_query)
        self.assertEqual(mock_list_events.call_args.kwargs["page"], 2)
        self.assertEqual(mock_list_events.call_args.kwargs["page_size"], 10)
        self.assertTrue(mock_list_events.call_args.kwargs["include_count"])

    @mock.patch("cvat.apps.events.views.list_events")
    @mock.patch("cvat.apps.events.views.EventsPermission.create_scope_list")
    def test_entries_can_skip_exact_count(self, mock_create_scope_list, mock_list_events):
        mock_create_scope_list.return_value.filter.side_effect = lambda params: params
        mock_list_events.return_value = {
            "count": 11,
            "page": 1,
            "page_size": 10,
            "has_more": True,
            "next_cursor": "cursor-1",
            "results": [],
        }

        request = self.factory.get(
            "/api/events/entries",
            {
                "job_id": 33,
                "include_count": "false",
            },
        )

        view = EventsViewSet.as_view({"get": "entries"})
        with mock.patch.object(EventsViewSet, "check_permissions", return_value=None):
            response = view(request)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertFalse(mock_list_events.call_args.kwargs["include_count"])

    @mock.patch("cvat.apps.events.views.list_events")
    @mock.patch("cvat.apps.events.views.EventsPermission.create_scope_list")
    def test_entries_accepts_cursor_parameter(self, mock_create_scope_list, mock_list_events):
        mock_create_scope_list.return_value.filter.side_effect = lambda params: params
        mock_list_events.return_value = {
            "count": 1,
            "page": 1,
            "page_size": 10,
            "has_more": False,
            "next_cursor": None,
            "results": [],
        }

        request = self.factory.get(
            "/api/events/entries",
            {
                "job_id": 33,
                "cursor": "cursor-token",
            },
        )

        view = EventsViewSet.as_view({"get": "entries"})
        with mock.patch.object(EventsViewSet, "check_permissions", return_value=None):
            response = view(request)

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        filtered_query = mock_create_scope_list.return_value.filter.call_args.args[0]
        self.assertEqual(filtered_query["cursor"], "cursor-token")

    @mock.patch("cvat.apps.events.views.list_events")
    @mock.patch("cvat.apps.events.views.EventsPermission.create_scope_list")
    def test_entries_rejects_invalid_date_range(self, mock_create_scope_list, mock_list_events):
        mock_create_scope_list.return_value.filter.side_effect = lambda params: params

        request = self.factory.get(
            "/api/events/entries",
            {
                "from": "2024-01-02T00:00:00Z",
                "to": "2024-01-01T00:00:00Z",
            },
        )

        view = EventsViewSet.as_view({"get": "entries"})
        with mock.patch.object(EventsViewSet, "check_permissions", return_value=None):
            response = view(request)

        self.assertEqual(response.status_code, status.HTTP_400_BAD_REQUEST)
        mock_list_events.assert_not_called()


class ListEventsTestCase(unittest.TestCase):
    def test_build_events_query_rejects_unapproved_select_clause(self):
        with self.assertRaisesRegex(ValueError, "Unsupported events query columns"):
            _build_events_query({}, columns="scope FROM events; DROP TABLE events", order="DESC")

    def test_build_events_query_rejects_unapproved_order(self):
        with self.assertRaisesRegex(ValueError, "Unsupported events query order"):
            _build_events_query({}, columns="count()", order="DESC; DROP TABLE events")

    @mock.patch(
        "cvat.apps.events.export._normalize_event_query_params", side_effect=lambda params: params
    )
    @mock.patch("cvat.apps.events.export._get_clickhouse_client")
    def test_list_events_skips_count_query_when_include_count_is_false(
        self, mock_get_clickhouse_client, _mock_normalize_query_params
    ):
        client = mock.MagicMock()
        mock_get_clickhouse_client.return_value.__enter__.return_value = client
        client.query.return_value = mock.Mock(
            column_names=["scope", "timestamp", "payload"],
            result_rows=[
                ("update:job", "2024-01-01T00:00:00Z", '{"old_value": "annotation"}'),
                ("update:job", "2024-01-01T00:00:01Z", '{"old_value": "validation"}'),
            ],
        )

        result = list_events(
            {"job_id": 33},
            page=1,
            page_size=1,
            include_count=False,
        )

        self.assertEqual(client.query.call_count, 1)
        self.assertEqual(result["count"], 2)
        self.assertTrue(result["has_more"])
        self.assertEqual(len(result["results"]), 1)
        self.assertIsNotNone(result["next_cursor"])

    @mock.patch(
        "cvat.apps.events.export._normalize_event_query_params", side_effect=lambda params: params
    )
    @mock.patch("cvat.apps.events.export._get_clickhouse_client")
    def test_list_events_uses_cursor_instead_of_offset(
        self, mock_get_clickhouse_client, _mock_normalize_query_params
    ):
        client = mock.MagicMock()
        mock_get_clickhouse_client.return_value.__enter__.return_value = client
        client.query.return_value = mock.Mock(
            column_names=["scope", "timestamp", "obj_name", "obj_id", "user_id", "payload"],
            result_rows=[
                (
                    "update:job",
                    datetime(2024, 1, 1, tzinfo=timezone.utc),
                    "state",
                    1,
                    7,
                    '{"request": {"id": "r1"}}',
                ),
                (
                    "update:job",
                    datetime(2023, 12, 31, tzinfo=timezone.utc),
                    "stage",
                    1,
                    7,
                    '{"request": {"id": "r2"}}',
                ),
            ],
        )

        result = list_events(
            {
                "job_id": 33,
                "cursor_data": {
                    "timestamp": datetime(2024, 1, 2, tzinfo=timezone.utc),
                    "scope": "update:job",
                    "obj_name": "state",
                    "obj_id": 2,
                    "obj_val": "completed",
                    "source": "server",
                    "count": 1,
                    "duration": 0,
                    "project_id": 11,
                    "task_id": 22,
                    "job_id": 33,
                    "user_id": 7,
                    "org_id": 44,
                    "access_token_id": 55,
                    "payload_signature": "payload-signature",
                },
            },
            page=1,
            page_size=1,
            include_count=False,
        )

        query = client.query.call_args.args[0]
        parameters = client.query.call_args.kwargs["parameters"]
        self.assertIn("cursor_timestamp", query)
        self.assertNotIn(" OFFSET ", query)
        self.assertIn("ifNull(obj_id, 0)", query)
        self.assertIn("ifNull(user_id, 0)", query)
        self.assertIn("ifNull(obj_val, '')", query)
        self.assertIn("ifNull(access_token_id, 0)", query)
        self.assertIn("hex(SHA256(ifNull(payload, '')))", query)
        self.assertEqual(parameters["cursor_obj_id"], 2)
        self.assertEqual(parameters["cursor_obj_val"], "completed")
        self.assertEqual(parameters["cursor_access_token_id"], 55)
        self.assertEqual(parameters["cursor_payload_signature"], "payload-signature")
        self.assertTrue(result["has_more"])
        self.assertIsNotNone(result["next_cursor"])

    @mock.patch(
        "cvat.apps.events.export._normalize_event_query_params", side_effect=lambda params: params
    )
    @mock.patch("cvat.apps.events.export._get_clickhouse_client")
    def test_list_events_cursor_mode_with_exact_count_keeps_has_more_correct(
        self, mock_get_clickhouse_client, _mock_normalize_query_params
    ):
        client = mock.MagicMock()
        mock_get_clickhouse_client.return_value.__enter__.return_value = client
        client.query.side_effect = [
            mock.Mock(
                column_names=["scope", "timestamp", "payload"],
                result_rows=[
                    (
                        "update:job",
                        datetime(2024, 1, 1, tzinfo=timezone.utc),
                        '{"request": {"id": "r1"}}',
                    ),
                    (
                        "update:job",
                        datetime(2023, 12, 31, tzinfo=timezone.utc),
                        '{"request": {"id": "r2"}}',
                    ),
                ],
            ),
            mock.Mock(result_rows=[(2,)]),
        ]

        result = list_events(
            {
                "job_id": 33,
                "cursor_data": {
                    "timestamp": datetime(2024, 1, 2, tzinfo=timezone.utc),
                    "scope": "update:job",
                    "obj_name": "",
                    "obj_id": 0,
                    "obj_val": "",
                    "source": "server",
                    "count": 0,
                    "duration": 0,
                    "project_id": 0,
                    "task_id": 0,
                    "job_id": 33,
                    "user_id": 0,
                    "org_id": 0,
                    "access_token_id": 0,
                    "payload_signature": "",
                },
            },
            page=1,
            page_size=1,
            include_count=True,
        )

        self.assertEqual(client.query.call_count, 2)
        self.assertEqual(result["count"], 2)
        self.assertTrue(result["has_more"])
        self.assertEqual(len(result["results"]), 1)
        self.assertIsNotNone(result["next_cursor"])

    @mock.patch(
        "cvat.apps.events.export._normalize_event_query_params", side_effect=lambda params: params
    )
    @mock.patch("cvat.apps.events.export._get_clickhouse_client")
    def test_list_events_cursor_mode_exact_count_last_page_has_no_more(
        self, mock_get_clickhouse_client, _mock_normalize_query_params
    ):
        client = mock.MagicMock()
        mock_get_clickhouse_client.return_value.__enter__.return_value = client
        client.query.side_effect = [
            mock.Mock(
                column_names=["scope", "timestamp", "payload"],
                result_rows=[
                    (
                        "update:job",
                        datetime(2024, 1, 1, tzinfo=timezone.utc),
                        '{"request": {"id": "r1"}}',
                    ),
                ],
            ),
            mock.Mock(result_rows=[(2,)]),
        ]

        result = list_events(
            {
                "job_id": 33,
                "cursor_data": {
                    "timestamp": datetime(2024, 1, 2, tzinfo=timezone.utc),
                    "scope": "update:job",
                    "obj_name": "",
                    "obj_id": 0,
                    "obj_val": "",
                    "source": "server",
                    "count": 0,
                    "duration": 0,
                    "project_id": 0,
                    "task_id": 0,
                    "job_id": 33,
                    "user_id": 0,
                    "org_id": 0,
                    "access_token_id": 0,
                    "payload_signature": "",
                },
            },
            page=1,
            page_size=1,
            include_count=True,
        )

        self.assertEqual(client.query.call_count, 2)
        self.assertEqual(result["count"], 2)
        self.assertFalse(result["has_more"])
        self.assertEqual(len(result["results"]), 1)
        self.assertIsNone(result["next_cursor"])

    @mock.patch(
        "cvat.apps.events.export._normalize_event_query_params", side_effect=lambda params: params
    )
    @mock.patch("cvat.apps.events.export._get_clickhouse_client")
    def test_list_events_cursor_does_not_expose_pii_fields(
        self, mock_get_clickhouse_client, _mock_normalize_query_params
    ):
        client = mock.MagicMock()
        mock_get_clickhouse_client.return_value.__enter__.return_value = client
        client.query.return_value = mock.Mock(
            column_names=[
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
                "access_token_id",
                "payload_signature",
            ],
            result_rows=[
                (
                    "update:job",
                    datetime(2024, 1, 1, tzinfo=timezone.utc),
                    "state",
                    1,
                    "completed",
                    "server",
                    1,
                    0,
                    11,
                    22,
                    33,
                    7,
                    "tester",
                    "tester@example.com",
                    44,
                    "main-org",
                    '{"request": {"id": "r1"}}',
                    55,
                    "payload-signature",
                ),
                (
                    "update:job",
                    datetime(2023, 12, 31, tzinfo=timezone.utc),
                    "stage",
                    1,
                    "validation",
                    "server",
                    1,
                    0,
                    11,
                    22,
                    33,
                    7,
                    "tester",
                    "tester@example.com",
                    44,
                    "main-org",
                    '{"request": {"id": "r2"}}',
                    55,
                    "payload-signature-2",
                ),
            ],
        )

        result = list_events(
            {"job_id": 33},
            page=1,
            page_size=1,
            include_count=False,
        )

        self.assertIsNotNone(result["next_cursor"])
        padded_cursor = f"{result['next_cursor']}{'=' * (-len(result['next_cursor']) % 4)}"
        decoded_cursor = json.loads(
            base64.urlsafe_b64decode(padded_cursor.encode("ascii")).decode("utf-8")
        )
        self.assertNotIn("user_name", decoded_cursor)
        self.assertNotIn("user_email", decoded_cursor)
        self.assertNotIn("org_slug", decoded_cursor)
        self.assertEqual(decoded_cursor["payload_signature"], "payload-signature")


class RecordServerEventTestCase(unittest.TestCase):
    @mock.patch("cvat.apps.events.event._emit_server_event")
    def test_record_server_event_emits_event_dispatch(self, mock_emit_server_event):
        record_server_event(
            scope="update:job",
            request_info={},
            payload={"old_value": "new"},
            on_commit=False,
            job_id=2302,
            obj_name="state",
            obj_val="completed",
        )

        mock_emit_server_event.assert_called_once()
        inserted_event = mock_emit_server_event.call_args.args[0]
        self.assertEqual(inserted_event["scope"], "update:job")
        self.assertEqual(inserted_event["job_id"], 2302)
        self.assertEqual(inserted_event["obj_name"], "state")
        self.assertEqual(inserted_event["obj_val"], "completed")
        self.assertEqual(inserted_event["source"], "server")

    @mock.patch("cvat.apps.events.event._emit_server_event")
    def test_record_server_event_does_not_mutate_request_info(self, mock_emit_server_event):
        request_info = {"id": "request-1", "access_token_id": 42}

        record_server_event(
            scope="update:job",
            request_info=request_info,
            on_commit=False,
            job_id=2302,
        )

        self.assertEqual(request_info, {"id": "request-1", "access_token_id": 42})
        clickhouse_data, _ = mock_emit_server_event.call_args.args
        self.assertEqual(clickhouse_data["access_token_id"], 42)
        self.assertEqual(
            json.loads(clickhouse_data["payload"]),
            {"request": {"id": "request-1"}},
        )

    @mock.patch("cvat.apps.events.event.transaction.on_commit")
    @mock.patch("cvat.apps.events.event._emit_server_event")
    def test_record_server_event_uses_transaction_on_commit_for_deferred_dispatch(
        self, mock_emit_server_event, mock_on_commit
    ):
        captured_callbacks = []
        mock_on_commit.side_effect = lambda callback, robust: captured_callbacks.append(
            (callback, robust)
        )

        record_server_event(
            scope="update:job",
            request_info={},
            on_commit=True,
            job_id=2302,
        )

        mock_emit_server_event.assert_not_called()
        self.assertEqual(len(captured_callbacks), 1)
        callback, robust = captured_callbacks[0]
        self.assertTrue(robust)

        callback()
        mock_emit_server_event.assert_called_once()

    @mock.patch("cvat.apps.events.event.vlogger.info")
    @mock.patch("cvat.apps.events.event._insert_event_directly", return_value=False)
    def test_emit_server_event_falls_back_to_logger_when_direct_insert_fails(
        self, mock_insert_event, mock_vlogger_info
    ):
        from cvat.apps.events.event import _emit_server_event

        _emit_server_event(
            {"scope": "update:job", "job_id": 2302},
            {"scope": "update:job", "timestamp": "123", "job_id": 2302},
        )

        mock_insert_event.assert_called_once_with({"scope": "update:job", "job_id": 2302})
        mock_vlogger_info.assert_called_once()

    @mock.patch("cvat.apps.events.event.vlogger.info")
    @mock.patch("cvat.apps.events.event._insert_event_directly", return_value=True)
    def test_emit_server_event_skips_logger_when_direct_insert_succeeds(
        self, mock_insert_event, mock_vlogger_info
    ):
        from cvat.apps.events.event import _emit_server_event

        _emit_server_event(
            {"scope": "update:job", "job_id": 2302},
            {"scope": "update:job", "timestamp": "123", "job_id": 2302},
        )

        mock_insert_event.assert_called_once_with({"scope": "update:job", "job_id": 2302})
        mock_vlogger_info.assert_not_called()

    @mock.patch("cvat.apps.events.event._get_clickhouse_client")
    def test_insert_event_directly_uses_clickhouse_client_context_manager(self, mock_get_client):
        from cvat.apps.events import event as event_module

        client = mock.MagicMock()
        client_manager = mock.MagicMock()
        client_manager.__enter__.return_value = client
        mock_get_client.return_value = client_manager

        self.assertTrue(event_module._insert_event_directly({"scope": "update:job"}))
        self.assertTrue(event_module._insert_event_directly({"scope": "update:job"}))

        self.assertEqual(mock_get_client.call_count, 2)
        self.assertEqual(client.insert.call_count, 2)
