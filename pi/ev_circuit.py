"""The one circuit that is "the car": EV charging. Shared by charge_detector
and the weekly briefing so both count the same energy (exact name, not the
Car regex in categories.json)."""
import os

CHARGE_CIRCUIT = os.getenv("CHARGE_CIRCUIT", "Outdoor / Tesla Car Charger")
