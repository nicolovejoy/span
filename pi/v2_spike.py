# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx", "paho-mqtt>=2"]
# ///
"""Spike for #26: register a v2 client with the SPAN panel and capture its MQTT stream.

  uv run pi/v2_spike.py register            # wait for 3x door press, register, save creds
  uv run pi/v2_spike.py capture --minutes 15 --out capture.jsonl

Credentials go to ~/.span-v2-creds.json (0600) and are never printed.
"""

import argparse
import json
import os
import sys
import tempfile
import time
from datetime import datetime
from pathlib import Path

import httpx

PANEL = os.environ.get("SPAN_HOST", "192.168.4.72")
CREDS = Path(os.environ.get("SPAN_V2_CREDS", Path.home() / ".span-v2-creds.json"))
CA_CERT = CREDS.with_suffix(".ca.crt")
SECRET_KEYS = {"accessToken", "ebusBrokerPassword", "hopPassphrase"}


def save_private(path: Path, text: str) -> None:
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    with os.fdopen(fd, "w") as f:
        f.write(text)
    os.replace(tmp, path)


def register(name: str, passphrase: str | None = None) -> dict:
    payload = {"name": name, "description": "span repo collector (#26)"}
    if passphrase:
        payload["hopPassphrase"] = passphrase
    r = httpx.post(f"http://{PANEL}/api/v2/auth/register", json=payload, timeout=10)
    if r.status_code != 200:
        sys.exit(f"register {name}: HTTP {r.status_code}: {r.text[:300]}")
    return r.json()


def cmd_register(args) -> None:
    deadline = time.monotonic() + args.timeout
    print("Waiting for proximity proof: open/close the panel door 3 times...", flush=True)
    while not httpx.get(f"http://{PANEL}/api/v2/status", timeout=5).json()["proximityProven"]:
        if time.monotonic() > deadline:
            sys.exit("Timed out waiting for proximity proof.")
        time.sleep(2)
    print("Proximity proven.", flush=True)

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    reduced = register(f"span-collector-{stamp}")
    creds = reduced
    # The proximity proof is single-use; re-register with the returned passphrase for a
    # full-privilege token so later re-registration needs no trip to the panel.
    if reduced.get("hopPassphrase"):
        creds = register(f"span-collector-{stamp}-full", reduced["hopPassphrase"])
        creds["hopPassphrase"] = creds.get("hopPassphrase") or reduced["hopPassphrase"]
        creds["ebusBrokerPassword"] = creds.get("ebusBrokerPassword") or reduced.get("ebusBrokerPassword")
    save_private(CREDS, json.dumps(creds, indent=2))

    ca = httpx.get(f"http://{PANEL}/api/v2/certificate/ca", timeout=15).text
    if "BEGIN CERTIFICATE" not in ca:
        sys.exit("CA download did not return a PEM certificate")
    CA_CERT.write_text(ca)

    shown = {k: ("<set>" if creds.get(k) else "<missing>") if k in SECRET_KEYS else v for k, v in creds.items()}
    print(f"Saved to {CREDS}:\n{json.dumps(shown, indent=2)}")


def cmd_capture(args) -> None:
    import paho.mqtt.client as mqtt

    creds = json.loads(CREDS.read_text())
    host = creds.get("ebusBrokerHost") or PANEL
    try:
        import socket
        socket.getaddrinfo(host, None)
        insecure = False
    except OSError:
        print(f"{host} does not resolve; connecting to {PANEL} without hostname check", flush=True)
        host, insecure = PANEL, True

    out = open(args.out, "w")
    counts = {"msgs": 0}

    def on_connect(client, userdata, flags, reason_code, properties):
        print(f"connected: {reason_code}", flush=True)
        client.subscribe("ebus/#", qos=0)

    def on_message(client, userdata, msg):
        counts["msgs"] += 1
        out.write(json.dumps({
            "t": time.time(),
            "topic": msg.topic,
            "retain": bool(msg.retain),
            "payload": msg.payload.decode("utf-8", "replace"),
        }) + "\n")

    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"span-spike-{os.getpid()}")
    client.username_pw_set(creds["ebusBrokerUsername"], creds["ebusBrokerPassword"])
    client.tls_set(ca_certs=str(CA_CERT))
    client.tls_insecure_set(insecure)
    client.on_connect = on_connect
    client.on_message = on_message
    client.connect(host, creds.get("ebusBrokerMqttsPort", 8883))
    client.loop_start()
    end = time.time() + args.minutes * 60
    while time.time() < end:
        time.sleep(30)
        out.flush()
        print(f"{datetime.now():%H:%M:%S} {counts['msgs']} msgs", flush=True)
    client.loop_stop()
    client.disconnect()
    out.close()


def main() -> None:
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("register")
    r.add_argument("--timeout", type=int, default=900)
    c = sub.add_parser("capture")
    c.add_argument("--minutes", type=float, default=15)
    c.add_argument("--out", default="capture.jsonl")
    args = p.parse_args()
    {"register": cmd_register, "capture": cmd_capture}[args.cmd](args)


if __name__ == "__main__":
    main()
