"""
    cd pi && python3 -m unittest test_span_v2 -v
"""
import json
import unittest

import span_v2
from span_v2 import PanelState, parse_topic

SERIAL = "ab-0000-00000"
UP = f"{SERIAL}-lugs-up"
DN = f"{SERIAL}-lugs-dn"
CIRCUIT_DESC = json.dumps({"type": "energy.ebus.device.circuit"})


def t(dev, prop):
    return f"ebus/5/{dev}/{prop}"


def state_from(messages, now=0.0):
    state = PanelState(SERIAL)
    for topic, payload in messages:
        state.apply(topic, payload, now)
    return state


def circuit_c1(*extra):
    return [(t("c1", "$description"), CIRCUIT_DESC), (t("c1", "info/name"), "Heat pump (HP)"), *extra]


def rows_by(state, measurement):
    return [r for r in state.rows() if r["measurement"] == measurement]


class ParseTopicTest(unittest.TestCase):
    def test_parse_topic(self):
        self.assertEqual(parse_topic("ebus/5/c1/meter/active-power"), ("c1", "meter/active-power"))
        self.assertEqual(parse_topic("ebus/5/c1/$state"), ("c1", "$state"))
        self.assertIsNone(parse_topic("ebus/5/c1/switch/relay/set"))
        self.assertIsNone(parse_topic("homie/5/c1/x/y"))


class RowsTest(unittest.TestCase):
    def test_panel_row_mapping(self):
        state = state_from([
            (t(UP, "meter/active-power"), "1148.0"),
            (t(DN, "meter/active-power"), "143.1"),
            (t(UP, "meter/imported-energy"), "4101891.5"),
            (t(UP, "meter/exported-energy"), "0.0"),
        ])
        [panel] = rows_by(state, "panel")
        self.assertEqual(panel["tags"], {})
        self.assertEqual(panel["fields"], {
            "grid_power_w": 1148.0,
            "feedthrough_power_w": 143.1,
            "consumed_energy_wh": 4101891.5,
            "produced_energy_wh": 0.0,
        })

    def test_circuit_row_mapping(self):
        state = state_from(circuit_c1(
            (t("c1", "meter/active-power"), "-29.3"),
            (t("c1", "meter/exported-energy"), "90443.1"),
            (t("c1", "meter/imported-energy"), "0.0"),
            (t("c1", "switch/relay"), "CLOSED"),
        ))
        [row] = rows_by(state, "circuit")
        self.assertEqual(row["tags"], {"circuit_id": "c1", "name": "Heat pump (HP)"})
        self.assertEqual(row["fields"], {
            "power_w": -29.3,
            "consumed_energy_wh": 90443.1,
            "produced_energy_wh": 0.0,
            "relay_state": 1,
        })
        state.apply(t("c1", "switch/relay"), "OPEN", 1.0)
        self.assertEqual(rows_by(state, "circuit")[0]["fields"]["relay_state"], 0)

    def test_unseen_fields_omitted(self):
        state = state_from(circuit_c1((t("c1", "meter/active-power"), "-5.0")))
        [row] = rows_by(state, "circuit")
        self.assertEqual(row["fields"], {"power_w": -5.0})

    def test_no_panel_row_without_fields(self):
        state = state_from(circuit_c1((t("c1", "meter/active-power"), "-5.0")))
        self.assertEqual(rows_by(state, "panel"), [])

    def test_values_before_description(self):
        state = state_from([
            (t("c1", "info/name"), "Heat pump (HP)"),
            (t("c1", "meter/active-power"), "-29.3"),
        ])
        self.assertEqual(rows_by(state, "circuit"), [])
        state.apply(t("c1", "$description"), CIRCUIT_DESC, 1.0)
        [row] = rows_by(state, "circuit")
        self.assertEqual(row["fields"], {"power_w": -29.3})

    def test_non_circuit_device_ignored(self):
        state = state_from([
            (t(UP, "$description"), json.dumps({"type": "energy.ebus.device.lugs"})),
            (t(UP, "info/name"), "lugs"),
            (t("x1", "$description"), "{not json"),
            (t("x1", "info/name"), "junk"),
            (t("x1", "meter/active-power"), "1.0"),
        ])
        self.assertEqual(rows_by(state, "circuit"), [])

    def test_circuit_without_name_skipped(self):
        state = state_from([
            (t("c1", "$description"), CIRCUIT_DESC),
            (t("c1", "meter/active-power"), "-1.0"),
        ])
        self.assertEqual(rows_by(state, "circuit"), [])

    def test_empty_payload_clears(self):
        state = state_from(circuit_c1(
            (t("c1", "meter/active-power"), "5.0"),
            (t("c1", "meter/active-power"), ""),
        ))
        self.assertEqual(rows_by(state, "circuit"), [])

    def test_bad_number_skipped(self):
        state = state_from(circuit_c1(
            (t("c1", "meter/active-power"), "abc"),
            (t("c1", "meter/exported-energy"), "10.0"),
        ))
        [row] = rows_by(state, "circuit")
        self.assertEqual(row["fields"], {"consumed_energy_wh": 10.0})

    def test_non_finite_number_skipped(self):
        # Influx rejects NaN/inf, which would fail the whole snapshot write.
        state = state_from(circuit_c1(
            (t("c1", "meter/active-power"), "nan"),
            (t("c1", "meter/imported-energy"), "inf"),
            (t("c1", "meter/exported-energy"), "10.0"),
        ))
        self.assertEqual(rows_by(state, "circuit")[0]["fields"], {"consumed_energy_wh": 10.0})

    def test_rename_uses_latest_name(self):
        state = state_from(circuit_c1(
            (t("c1", "meter/active-power"), "-1.0"),
            (t("c1", "info/name"), "B"),
        ))
        self.assertEqual(rows_by(state, "circuit")[0]["tags"]["name"], "B")


class LifecycleTest(unittest.TestCase):
    def test_lifecycle_events(self):
        state = PanelState(SERIAL)
        self.assertEqual(state.apply(t(SERIAL, "$state"), "ready", 0.0), {"state": "ready", "firmware": None})
        self.assertIsNone(state.apply(t(SERIAL, "$state"), "ready", 1.0))
        self.assertEqual(
            state.apply(t(SERIAL, "info/firmware-version"), "spanos3/r202639/04", 2.0),
            {"state": "ready", "firmware": "spanos3/r202639/04"},
        )
        self.assertIsNone(state.apply(t(SERIAL, "info/firmware-version"), "spanos3/r202639/04", 3.0))
        self.assertEqual(state.apply(t(SERIAL, "$state"), "init", 4.0)["state"], "init")

    def test_child_state_is_not_lifecycle(self):
        state = PanelState(SERIAL)
        self.assertIsNone(state.apply(t("c1", "$state"), "ready", 0.0))

    def test_last_update_tracks_lugs_meter(self):
        state = PanelState(SERIAL)
        self.assertIsNone(state.last_update)
        state.apply(t(UP, "meter/active-power"), "1.0", 100.0)
        state.apply(t("c1", "meter/active-power"), "1.0", 200.0)
        self.assertEqual(state.last_update, 100.0)


if __name__ == "__main__":
    unittest.main()
