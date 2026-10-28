#!/usr/bin/env python3
"""SPAN panel collector v2: subscribes to the panel's local MQTT broker (#26).

SPAN removes the v1 REST API on 2026-12-31. The panel pushes every property over
MQTT (~1 s); this keeps the latest values in a span_v2.PanelState and writes a
snapshot every POLL_INTERVAL seconds into the same panel/circuit measurements
collector.py writes, so every downstream consumer is untouched. MEASUREMENT_SUFFIX
(e.g. "_v2") shadows them during the side-by-side run.

    python collector_v2.py            # write to InfluxDB
    python collector_v2.py --dry-run  # print line protocol instead (laptop testing)
"""

import argparse
import logging
import os
import sys
import tempfile
import threading
import time
from datetime import datetime, timezone

import httpx
from influxdb_client import Point

from span_v2 import PanelState, poll_result, snapshot_rows

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


def env_secret(name: str) -> str | None:
    """$NAME_FILE's contents if set (compose file secrets), else $NAME."""
    path = os.getenv(f"{name}_FILE")
    if path:
        with open(path) as f:
            return f.read().strip()
    return os.getenv(name)


SPAN_PANEL_IP = os.getenv("SPAN_PANEL_IP", "192.168.4.72")
POLL_INTERVAL = int(os.getenv("POLL_INTERVAL", "30"))
MEASUREMENT_SUFFIX = os.getenv("MEASUREMENT_SUFFIX", "")

INFLUXDB_URL = os.getenv("INFLUXDB_URL", "http://localhost:8086")
INFLUXDB_ORG = os.getenv("INFLUXDB_ORG", "home")
INFLUXDB_BUCKET = os.getenv("INFLUXDB_BUCKET", "span")


def to_points(rows: list[dict], suffix: str, ts: datetime) -> list[Point]:
    points = []
    for row in rows:
        point = Point(row["measurement"] + suffix)
        for key, value in row["tags"].items():
            point = point.tag(key, value)
        for key, value in row["fields"].items():
            point = point.field(key, value)
        points.append(point.time(ts))
    return points


def poll_point(result: str, error: str, n_points: int, panel_age_s: float | None,
               suffix: str, ts: datetime) -> Point:
    point = (
        Point("collector_poll" + suffix)
        .tag("host", "phrpi")
        .tag("result", result)
        .tag("error", error)
        .field("points", n_points)
    )
    if panel_age_s is not None:
        point = point.field("panel_age_ms", int(round(panel_age_s * 1000)))
    return point.time(ts)


def lifecycle_point(event: dict, suffix: str, ts: datetime) -> Point:
    point = Point("panel_lifecycle" + suffix).field("state", event["state"] or "")
    if event.get("firmware") is not None:
        point = point.field("firmware", event["firmware"])
    return point.time(ts)


def fetch_ca_cert(panel_ip: str) -> str:
    """Download the panel's CA (unauthenticated) to a temp file; returns its path."""
    pem = httpx.get(f"http://{panel_ip}/api/v2/certificate/ca", timeout=15).text
    if "BEGIN CERTIFICATE" not in pem:
        raise RuntimeError("panel CA download did not return a PEM certificate")
    fd, path = tempfile.mkstemp(suffix=".crt")
    with os.fdopen(fd, "w") as f:
        f.write(pem)
    return path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="print line protocol instead of writing")
    args = parser.parse_args()

    import paho.mqtt.client as mqtt

    serial = env_secret("SPAN_SERIAL")
    password = env_secret("SPAN_V2_BROKER_PASSWORD")
    influx_token = env_secret("INFLUXDB_TOKEN")
    if not serial or not password:
        logger.error("SPAN_SERIAL and SPAN_V2_BROKER_PASSWORD must be set")
        sys.exit(1)
    if not args.dry_run and not influx_token:
        logger.error("INFLUXDB_TOKEN not set")
        sys.exit(1)
    broker_host = os.getenv("SPAN_V2_BROKER_HOST", f"span-{serial}.local")

    if args.dry_run:
        def write(records):
            for p in records if isinstance(records, list) else [records]:
                print(p.to_line_protocol(), flush=True)
    else:
        from influxdb_client import InfluxDBClient
        from influxdb_client.client.write_api import SYNCHRONOUS
        write_api = InfluxDBClient(url=INFLUXDB_URL, token=influx_token, org=INFLUXDB_ORG) \
            .write_api(write_options=SYNCHRONOUS)

        def write(records):
            write_api.write(bucket=INFLUXDB_BUCKET, org=INFLUXDB_ORG, record=records)

    state = PanelState(serial)
    lock = threading.Lock()
    connected = threading.Event()
    lifecycle_events: list[tuple[datetime, dict]] = []

    def on_connect(client, userdata, flags, reason_code, properties):
        if reason_code.is_failure:
            logger.error(f"MQTT connect refused: {reason_code}")
            return
        logger.info(f"MQTT connected to {broker_host}")
        connected.set()
        client.subscribe("ebus/5/#", qos=0)

    def on_disconnect(client, userdata, flags, reason_code, properties):
        connected.clear()
        logger.warning(f"MQTT disconnected: {reason_code}")

    def on_message(client, userdata, msg):
        payload = msg.payload.decode("utf-8", "replace")
        with lock:
            event = state.apply(msg.topic, payload, time.time())
            if event is not None:
                lifecycle_events.append((datetime.now(timezone.utc), event))

    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"span-collector-v2{MEASUREMENT_SUFFIX}")
    client.username_pw_set(serial, password)
    client.tls_set(ca_certs=fetch_ca_cert(SPAN_PANEL_IP))
    client.on_connect = on_connect
    client.on_disconnect = on_disconnect
    client.on_message = on_message
    client.reconnect_delay_set(min_delay=1, max_delay=60)
    # No LWT: the broker discards LWTs on SPAN device topics.
    client.connect_async(broker_host, 8883)
    client.loop_start()

    logger.info(f"Starting collector v2: broker={broker_host}, suffix={MEASUREMENT_SUFFIX!r}, "
                f"interval={POLL_INTERVAL}s, dry_run={args.dry_run}")

    while True:
        time.sleep(POLL_INTERVAL)
        try:
            now = time.time()
            ts = datetime.now(timezone.utc)
            with lock:
                is_connected = connected.is_set()
                rows = snapshot_rows(state, now, is_connected)
                result, error = poll_result(state, now, is_connected)
                age = None if state.last_update is None else now - state.last_update
                events, lifecycle_events[:] = list(lifecycle_events), []

            for event_ts, event in events:
                try:
                    write(lifecycle_point(event, MEASUREMENT_SUFFIX, event_ts))
                    logger.info(f"Panel lifecycle: {event}")
                except Exception as e:
                    logger.error(f"Failed to write panel_lifecycle point: {e}")

            points = to_points(rows, MEASUREMENT_SUFFIX, ts)
            if points:
                try:
                    write(points)
                    logger.info(f"Wrote {len(points)} points ({result})")
                except Exception as e:
                    logger.error(f"Failed to write to InfluxDB: {e}")
                    result = "write_fail"
            else:
                logger.warning(f"No points this cycle: {result}/{error}")

            try:
                write(poll_point(result, error, len(points), age, MEASUREMENT_SUFFIX, ts))
            except Exception as e:
                logger.error(f"Failed to write collector_poll point: {e}")
        except Exception as e:
            logger.error(f"Collection error: {e}")


if __name__ == "__main__":
    main()
