"""
    cd pi && uv run --python 3.11 --with influxdb-client --with httpx --with paho-mqtt python -m unittest test_collector_v2 -v
"""
import os
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from unittest import mock

# test_attribution.py / test_bath_detector.py (run alongside this module in the
# combined suite) install a MagicMock stub for "influxdb_client" when it isn't
# imported yet. These tests assert on real line protocol, so drop the stub (and
# any collector_v2 bound to it) to get the real package, which is installed.
if "influxdb_client" in sys.modules and not hasattr(sys.modules["influxdb_client"], "__file__"):
    for name in [m for m in sys.modules if m.startswith("influxdb_client")] + ["collector_v2"]:
        sys.modules.pop(name, None)

import collector_v2

TS = datetime(2026, 10, 28, 3, 31, 22, tzinfo=timezone.utc)


class PointsTest(unittest.TestCase):
    def test_to_points_suffix(self):
        rows = [{"measurement": "panel", "tags": {}, "fields": {"grid_power_w": 1148.0}}]
        [point] = collector_v2.to_points(rows, "_v2", TS)
        self.assertTrue(point.to_line_protocol().startswith("panel_v2 "))

    def test_to_points_circuit_tags(self):
        rows = [{"measurement": "circuit", "tags": {"circuit_id": "c1", "name": "Heat pump (HP)"},
                 "fields": {"power_w": -29.3, "relay_state": 1}}]
        line = collector_v2.to_points(rows, "", TS)[0].to_line_protocol()
        self.assertTrue(line.startswith("circuit,circuit_id=c1,name=Heat\\ pump\\ (HP) "))
        self.assertIn("power_w=-29.3", line)
        self.assertIn("relay_state=1i", line)

    def test_poll_point_fields(self):
        line = collector_v2.poll_point("ok", "none", 22, 0.8, "", TS).to_line_protocol()
        self.assertTrue(line.startswith("collector_poll,"))
        for part in ("host=phrpi", "result=ok", "error=none", "points=22i", "panel_age_ms=800i"):
            self.assertIn(part, line)

    def test_poll_point_no_age(self):
        line = collector_v2.poll_point("both_fail", "stale", 0, None, "_v2", TS).to_line_protocol()
        self.assertTrue(line.startswith("collector_poll_v2,"))
        self.assertNotIn("panel_age_ms", line)

    def test_lifecycle_point(self):
        line = collector_v2.lifecycle_point({"state": "init", "firmware": None}, "", TS).to_line_protocol()
        self.assertTrue(line.startswith("panel_lifecycle "))
        self.assertIn('state="init"', line)
        self.assertNotIn("firmware", line)


class EnvSecretTest(unittest.TestCase):
    def test_env_secret_prefers_file(self):
        with tempfile.NamedTemporaryFile("w", delete=False) as f:
            f.write("from-file\n")
        self.addCleanup(os.unlink, f.name)
        with mock.patch.dict(os.environ, {"X_SECRET": "from-env", "X_SECRET_FILE": f.name}, clear=False):
            self.assertEqual(collector_v2.env_secret("X_SECRET"), "from-file")
        with mock.patch.dict(os.environ, {"X_SECRET": "from-env"}, clear=False):
            os.environ.pop("X_SECRET_FILE", None)
            self.assertEqual(collector_v2.env_secret("X_SECRET"), "from-env")
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("X_SECRET", None)
            os.environ.pop("X_SECRET_FILE", None)
            self.assertIsNone(collector_v2.env_secret("X_SECRET"))


if __name__ == "__main__":
    unittest.main()
