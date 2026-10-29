#!/usr/bin/env python3
"""Tesla Wall Connector (Gen 3) local API into InfluxDB: the charger's own kWh counter.

Ground truth for `charge_event` (charge_detector.py infers sessions from the
SPAN circuit; this reads the charger itself). Two unauthenticated LAN endpoints:
  - /api/1/lifetime : cumulative energy_wh, charge_starts, charging_time_s
  - /api/1/vitals   : live session_energy_wh, vehicle_connected, contactor_closed
Polled every minute so a session's final session_energy_wh is captured before
the car unplugs. Compare windows by differencing energy_wh -- its absolute value
is unverified (charging_time_s implies ~17 kW average, above the unit's ~11.5 kW).

The charger's address is a DHCP reservation on the router (MAC 98:ED:5C:8D:6D:DE).
"""
import argparse
import os
import time
import logging
from datetime import datetime, timezone

import httpx
from influxdb_client import InfluxDBClient, Point
from influxdb_client.client.write_api import SYNCHRONOUS

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

INFLUXDB_URL = os.getenv("INFLUXDB_URL", "http://localhost:8086")
INFLUXDB_TOKEN = os.getenv("INFLUXDB_TOKEN")
INFLUXDB_ORG = os.getenv("INFLUXDB_ORG", "home")
INFLUXDB_BUCKET = os.getenv("INFLUXDB_BUCKET", "span")

WALL_CONNECTOR_URL = os.getenv("WALL_CONNECTOR_URL", "http://192.168.7.124")

LIFETIME_FIELDS = ("energy_wh", "charge_starts", "charging_time_s", "contactor_cycles")
VITALS_FIELDS = ("session_energy_wh", "session_s", "vehicle_connected", "contactor_closed")


def fetch_json(http_client: httpx.Client, endpoint: str) -> dict | None:
    """GET /api/1/<endpoint>; None on any failure (the charger being briefly
    unreachable is routine, not an error worth a stack trace)."""
    try:
        resp = http_client.get(f"{WALL_CONNECTOR_URL}/api/1/{endpoint}")
        resp.raise_for_status()
        return resp.json()
    except Exception as e:
        logger.warning(f"Wall Connector /{endpoint} failed: {e}")
        return None


def build_fields(lifetime: dict | None, vitals: dict | None) -> dict[str, float]:
    """Pick the fields we keep from both payloads. Everything goes in as a float
    (booleans as 0/1): InfluxDB fixes a field's type at first write, so an int
    arriving later is a silent 422. Missing keys are skipped, never zeroed."""
    fields = {}
    for payload, keys in ((lifetime, LIFETIME_FIELDS), (vitals, VITALS_FIELDS)):
        for key in keys:
            if payload and payload.get(key) is not None:
                fields[key] = float(payload[key])
    return fields


def poll_once(http_client: httpx.Client, write_api) -> bool:
    """One poll: write a single untagged `wall_connector` point, or nothing if
    the charger didn't answer. Returns whether a point was written."""
    fields = build_fields(fetch_json(http_client, "lifetime"),
                          fetch_json(http_client, "vitals"))
    if not fields:
        return False
    point = Point("wall_connector").time(datetime.now(timezone.utc))
    for key, value in fields.items():
        point = point.field(key, value)
    write_api.write(bucket=INFLUXDB_BUCKET, org=INFLUXDB_ORG, record=point)
    return True


def main():
    parser = argparse.ArgumentParser(description="Tesla Wall Connector counters into InfluxDB")
    parser.add_argument("--loop", action="store_true", help="Run continuously")
    parser.add_argument("--interval", type=int, default=60, help="Seconds between polls in loop mode")
    args = parser.parse_args()

    if not INFLUXDB_TOKEN:
        logger.error("INFLUXDB_TOKEN not set")
        return

    client = InfluxDBClient(url=INFLUXDB_URL, token=INFLUXDB_TOKEN, org=INFLUXDB_ORG)
    write_api = client.write_api(write_options=SYNCHRONOUS)

    with httpx.Client(timeout=5.0) as http_client:
        if args.loop:
            logger.info(f"Loop mode: polling {WALL_CONNECTOR_URL} every {args.interval}s")
            while True:
                try:
                    poll_once(http_client, write_api)
                except Exception as e:
                    logger.error(f"Wall Connector poll failed: {e}")
                time.sleep(args.interval)
        else:
            logger.info("Wrote 1 point" if poll_once(http_client, write_api) else "No data")

    client.close()


if __name__ == "__main__":
    main()
