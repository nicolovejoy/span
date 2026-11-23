"""Render a sample weekly briefing from deterministic fixture data (no Influx).

Usage: python pi/tools/render_sample_weekly.py OUT_DIR

Writes OUT_DIR/weekly.html, weekly.txt and chart-N.png (one per embedded chart),
then prints the house and car kWh and whether the two reconciliation rules hold.
Run it with real matplotlib, outside pytest (the conftest stub draws nothing).
"""
import base64
import re
import sys
from datetime import date, timedelta
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import daily_report as dr  # noqa: E402
from email_kit import html_to_text  # noqa: E402

LAST_DAY = date(2026, 11, 22)           # a Sunday
WEEK_START = date(2026, 11, 16)         # the target Monday
N_DAYS = 400
UNMONITORED_KWH = 3.0
CAR_KWH = 18.0
CAR_GAP = (date(2026, 10, 12), date(2026, 10, 25))   # two weeks with no charging


def build_fixture():
    days = [LAST_DAY - timedelta(days=i) for i in range(N_DAYS)][::-1]
    rows, panel = [], {}
    for d in days:
        weekend = d.weekday() >= 5
        circuits = [
            ("Heat pump (HP) / Compressor", 17.0 if weekend else 12.0 + (d.toordinal() % 3)),
            ("Kitchen Lights", 7.5),
            ("Kitchen / Oven", 3.0),
            ("Garage outlet", 0.5),
        ]
        if d.weekday() in (0, 2, 4) and not (CAR_GAP[0] <= d <= CAR_GAP[1]):
            circuits.append((dr.CHARGE_CIRCUIT, CAR_KWH))
        rows += [(name, d, kwh) for name, kwh in circuits]
        panel[d] = sum(kwh for _, kwh in circuits) + UNMONITORED_KWH
    return rows, panel


def build_context():
    rows, panel = build_fixture()
    with mock.patch.object(dr, "query_daily_circuit_counter_kwh", return_value=rows), \
         mock.patch.object(dr, "query_daily_panel_kwh", return_value=list(panel.items())), \
         mock.patch.object(dr, "query_hvac_mode_intervals", return_value=[]), \
         mock.patch.object(dr, "query_mean_temp_f", return_value=44.0):
        return dr.build_weekly_context(object(), WEEK_START)


def main(out_dir: Path) -> None:
    ctx = build_context()
    html = dr.build_weekly_html(ctx)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "weekly.html").write_text(html)
    (out_dir / "weekly.txt").write_text(html_to_text(html))
    for n, b64 in enumerate(re.findall(r'src="data:image/png;base64,([^"]+)"', html), start=1):
        (out_dir / f"chart-{n}.png").write_bytes(base64.b64decode(b64))

    week = ctx.trend[-1][1]
    house_stack = sum(v for c, v in week.items() if c != "Car")
    reconciles = (abs(house_stack - ctx.headline["kwh"]) < 1e-6
                  and abs(week["Car"] - ctx.car["kwh"]) < 1e-6)
    print(f"house kWh: {ctx.headline['kwh']:.2f}")
    print(f"car kWh: {ctx.car['kwh']:.2f}")
    print(f"reconciles: {reconciles}")
    if not reconciles:
        sys.exit(1)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(Path(sys.argv[1]).expanduser())
