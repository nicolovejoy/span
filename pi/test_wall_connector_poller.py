"""Tests for wall_connector_poller.py — Tesla Wall Connector Gen 3 local API into InfluxDB.

    cd pi && python3 test_wall_connector_poller.py

Nothing here touches the network or a real InfluxDB.
"""
import sys
import types
import unittest
from datetime import datetime, timezone
from unittest import mock

if "influxdb_client" not in sys.modules:
    _ic = types.ModuleType("influxdb_client")
    _ic.InfluxDBClient = object
    # Lambda factory so `Point("wall_connector")` returns a fresh, unrestricted
    # mock (see test_weather_poller.py for why the class itself won't do).
    _ic.Point = lambda *a, **k: mock.MagicMock()
    sys.modules["influxdb_client"] = _ic
    _wa = types.ModuleType("influxdb_client.client.write_api")
    _wa.SYNCHRONOUS = "sync"
    sys.modules["influxdb_client.client.write_api"] = _wa

sys.path.insert(0, str(__import__("pathlib").Path(__file__).parent))
import wall_connector_poller as wc   # noqa: E402

UTC = timezone.utc

LIFETIME = {
    "contactor_cycles": 1501, "contactor_cycles_loaded": 330, "alert_count": 63,
    "thermal_foldbacks": 8, "avg_startup_temp": 24.7, "charge_starts": 1501,
    "energy_wh": 19969134, "connector_cycles": 880, "uptime_s": 114233013,
    "charging_time_s": 4212822,
}
VITALS = {
    "contactor_closed": True, "vehicle_connected": True, "session_s": 600,
    "grid_v": 242.2, "session_energy_wh": 1234.5, "evse_state": 11,
}


class BuildFieldsTest(unittest.TestCase):
    def test_merges_lifetime_and_vitals_into_float_fields(self):
        fields = wc.build_fields(LIFETIME, VITALS)
        self.assertEqual(fields["energy_wh"], 19969134.0)
        self.assertEqual(fields["charge_starts"], 1501.0)
        self.assertEqual(fields["charging_time_s"], 4212822.0)
        self.assertEqual(fields["session_energy_wh"], 1234.5)

    def test_every_field_is_a_float(self):
        # InfluxDB fixes a field's type at first write; an int sneaking in
        # later is a silent 422.
        for v in wc.build_fields(LIFETIME, VITALS).values():
            self.assertIsInstance(v, float)

    def test_booleans_become_zero_or_one(self):
        fields = wc.build_fields(LIFETIME, {**VITALS, "contactor_closed": False})
        self.assertEqual(fields["vehicle_connected"], 1.0)
        self.assertEqual(fields["contactor_closed"], 0.0)

    def test_lifetime_alone_still_yields_fields(self):
        fields = wc.build_fields(LIFETIME, None)
        self.assertEqual(fields["energy_wh"], 19969134.0)
        self.assertNotIn("session_energy_wh", fields)

    def test_vitals_alone_still_yields_fields(self):
        fields = wc.build_fields(None, VITALS)
        self.assertEqual(fields["session_energy_wh"], 1234.5)
        self.assertNotIn("energy_wh", fields)

    def test_neither_yields_empty(self):
        self.assertEqual(wc.build_fields(None, None), {})

    def test_missing_keys_are_skipped_not_zeroed(self):
        fields = wc.build_fields({"energy_wh": 5}, {})
        self.assertEqual(fields, {"energy_wh": 5.0})


class FetchTest(unittest.TestCase):
    def test_returns_none_when_the_charger_is_unreachable(self):
        http = mock.MagicMock()
        http.get.side_effect = OSError("no route")
        self.assertIsNone(wc.fetch_json(http, "lifetime"))

    def test_returns_none_on_http_error(self):
        resp = mock.MagicMock()
        resp.raise_for_status.side_effect = RuntimeError("503")
        http = mock.MagicMock()
        http.get.return_value = resp
        self.assertIsNone(wc.fetch_json(http, "vitals"))

    def test_returns_parsed_json_on_success(self):
        resp = mock.MagicMock()
        resp.json.return_value = {"a": 1}
        http = mock.MagicMock()
        http.get.return_value = resp
        self.assertEqual(wc.fetch_json(http, "lifetime"), {"a": 1})
        self.assertTrue(http.get.call_args[0][0].endswith("/api/1/lifetime"))


class PollOnceTest(unittest.TestCase):
    def test_writes_one_point_when_data_arrives(self):
        write_api = mock.MagicMock()
        with mock.patch.object(wc, "fetch_json", side_effect=[LIFETIME, VITALS]):
            ok = wc.poll_once(mock.MagicMock(), write_api)
        self.assertTrue(ok)
        write_api.write.assert_called_once()
        self.assertEqual(write_api.write.call_args.kwargs["bucket"], wc.INFLUXDB_BUCKET)

    def test_writes_nothing_when_both_endpoints_fail(self):
        write_api = mock.MagicMock()
        with mock.patch.object(wc, "fetch_json", return_value=None):
            ok = wc.poll_once(mock.MagicMock(), write_api)
        self.assertFalse(ok)
        write_api.write.assert_not_called()


if __name__ == "__main__":
    unittest.main()
