# Copyright (C) CVAT.ai Corporation
#
# SPDX-License-Identifier: MIT

import json
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch

from django.test import RequestFactory
from health_check.conf import HEALTH_CHECK
from health_check.contrib.psutil.backends import DiskUsage
from health_check.db.backends import DatabaseBackend
from health_check.exceptions import ServiceUnavailable
from health_check.plugins import plugin_dir
from health_check.views import MainView


class CapacityWarningTests(TestCase):
    def response(self, *, database_failure=False):
        # Exercise the real health view and disk check without touching live services.
        with (
            patch.object(plugin_dir, "_registry", [(DiskUsage, {}), (DatabaseBackend, {})]),
            patch("health_check.contrib.psutil.backends.DISK_USAGE_MAX", 90),
            patch(
                "health_check.contrib.psutil.backends.psutil.disk_usage",
                return_value=SimpleNamespace(percent=95),
            ),
            patch.object(
                DatabaseBackend,
                "check_status",
                side_effect=ServiceUnavailable("database unavailable") if database_failure else None,
            ),
        ):
            return MainView.as_view()(RequestFactory().get("/api/server/health/?format=json"))

    def test_disk_warning_does_not_block_ui(self):
        self.assertFalse(HEALTH_CHECK["WARNINGS_AS_ERRORS"])
        response = self.response()
        self.assertEqual(response.status_code, 200)
        self.assertIn("95% disk usage", json.loads(response.content)["DiskUsage"])

    def test_database_failure_still_returns_500(self):
        response = self.response(database_failure=True)
        self.assertEqual(response.status_code, 500)
        self.assertIn("database unavailable", json.loads(response.content)["DatabaseBackend"])

    def test_strict_monitoring_can_be_enabled(self):
        with patch.dict(HEALTH_CHECK, WARNINGS_AS_ERRORS=True):
            self.assertEqual(self.response().status_code, 500)
