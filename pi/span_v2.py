"""Pure SPAN v2 (Homie/eBus MQTT) state: latest property values -> panel/circuit rows. No I/O.

Topics look like `ebus/5/<device-id>/<capability>/<property>`. Every property is retained and
an unchanged value is never republished, so the latest value seen is the current value. A
property not seen yet is simply absent: rows omit it rather than writing 0 (a client that
zero-filled after a retained replay produced fake counter resets, SpanPanel/span#259).
See docs/superpowers/notes/2026-10-27-span-v2-spike-findings.md (#26).
"""

import json
import math

CIRCUIT_TYPE = "energy.ebus.device.circuit"

# (device suffix after the serial, property) -> panel field. Same names v1 wrote.
PANEL_FIELDS = {
    ("-lugs-up", "meter/active-power"): "grid_power_w",
    ("-lugs-dn", "meter/active-power"): "feedthrough_power_w",
    ("-lugs-up", "meter/imported-energy"): "consumed_energy_wh",
    ("-lugs-up", "meter/exported-energy"): "produced_energy_wh",
}

# Circuit property -> circuit field. v1 consumedEnergyWh is the enclosure-frame
# exported-energy (panel -> circuit); signs already match what v1 stored.
CIRCUIT_FIELDS = {
    "meter/active-power": "power_w",
    "meter/exported-energy": "consumed_energy_wh",
    "meter/imported-energy": "produced_energy_wh",
}


def parse_topic(topic: str) -> tuple[str, str] | None:
    """`ebus/5/<dev>/<cap>/<prop>` -> (dev, "cap/prop"); `ebus/5/<dev>/$x` -> (dev, "$x")."""
    parts = topic.split("/")
    if parts[:2] != ["ebus", "5"] or len(parts) < 4:
        return None
    if len(parts) == 4 and parts[3].startswith("$"):
        return parts[2], parts[3]
    if len(parts) == 5:
        return parts[2], f"{parts[3]}/{parts[4]}"
    return None


def _number(payload: str | None) -> float | None:
    if payload is None:
        return None
    try:
        value = float(payload)
    except ValueError:
        return None
    return value if math.isfinite(value) else None


class PanelState:
    def __init__(self, serial: str):
        self.serial = serial
        self.values: dict[tuple[str, str], str] = {}
        self.device_types: dict[str, str] = {}
        self.last_update: float | None = None
        self._lifecycle: tuple[str | None, str | None] = (None, None)

    def apply(self, topic: str, payload: str, now: float) -> dict | None:
        """Record one message. Returns a lifecycle event when the root device's
        `$state` or firmware version changes, else None."""
        parsed = parse_topic(topic)
        if parsed is None:
            return None
        dev, prop = parsed

        if payload == "":
            self.values.pop((dev, prop), None)
        else:
            self.values[(dev, prop)] = payload

        if prop == "$description":
            try:
                self.device_types[dev] = json.loads(payload).get("type", "")
            except (ValueError, AttributeError):
                self.device_types.pop(dev, None)

        if dev == f"{self.serial}-lugs-up" and prop.startswith("meter/"):
            self.last_update = now

        if dev == self.serial and prop in ("$state", "info/firmware-version"):
            current = (self.values.get((dev, "$state")), self.values.get((dev, "info/firmware-version")))
            if current != self._lifecycle:
                self._lifecycle = current
                return {"state": current[0], "firmware": current[1]}
        return None

    def rows(self) -> list[dict]:
        rows = []
        panel = {}
        for (suffix, prop), field in PANEL_FIELDS.items():
            value = _number(self.values.get((self.serial + suffix, prop)))
            if value is not None:
                panel[field] = value
        if panel:
            rows.append({"measurement": "panel", "tags": {}, "fields": panel})

        for dev, kind in sorted(self.device_types.items()):
            name = self.values.get((dev, "info/name"))
            if kind != CIRCUIT_TYPE or not name:
                continue
            fields = {}
            for prop, field in CIRCUIT_FIELDS.items():
                value = _number(self.values.get((dev, prop)))
                if value is not None:
                    fields[field] = value
            relay = self.values.get((dev, "switch/relay"))
            if relay is not None:
                fields["relay_state"] = 1 if relay == "CLOSED" else 0
            if fields:
                rows.append({"measurement": "circuit", "tags": {"circuit_id": dev, "name": name}, "fields": fields})
        return rows
