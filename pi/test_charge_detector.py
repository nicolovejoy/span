"""Tests for charge_detector's pure session finder.

Background (docs/superpowers/notes/2026-10-27-ev-accuracy-findings.md): the
detector used to write a session the first time it was >= 30 min long and then
skip every later, longer version of it, so nearly every stored charge_event was
30-40 min / 6-7 kWh while real sessions ran ~2 h / ~22 kWh. The fix: a run that
is still above threshold at the end of the samples is *open* and is not emitted;
only runs followed by a below-threshold sample are sessions.
"""

import unittest
from datetime import datetime, timedelta, timezone

import charge_detector as cd

T0 = datetime(2026, 9, 14, 19, 0, tzinfo=timezone.utc)
STEP = timedelta(seconds=30)


def samples(spec):
    """spec: list of (minutes, power_w) segments, sampled every 30 s."""
    out = []
    t = T0
    for minutes, power in spec:
        for _ in range(int(minutes * 2)):
            out.append({"time": t, "power": float(power)})
            t += STEP
    return out


class FindChargeSessionsTest(unittest.TestCase):
    def test_closed_two_hour_session_is_emitted_in_full(self):
        s = samples([(10, 0), (120, 11000), (10, 0)])
        sessions = cd.find_charge_sessions(s)
        self.assertEqual(len(sessions), 1)
        self.assertAlmostEqual(sessions[0]["duration_min"], 119.5, delta=0.6)
        self.assertAlmostEqual(sessions[0]["energy_kwh"], 22.0, delta=0.2)
        self.assertEqual(sessions[0]["start"], T0 + timedelta(minutes=10))

    def test_open_run_at_end_of_samples_is_not_emitted(self):
        # 45 min above threshold, still charging when the samples stop: the
        # old code wrote this as a 45-min session and never updated it.
        s = samples([(10, 0), (45, 11000)])
        self.assertEqual(cd.find_charge_sessions(s), [])

    def test_open_run_is_emitted_once_it_closes(self):
        before = samples([(10, 0), (45, 11000)])
        after = samples([(10, 0), (120, 11000), (1, 0)])
        self.assertEqual(cd.find_charge_sessions(before), [])
        sessions = cd.find_charge_sessions(after)
        self.assertEqual(len(sessions), 1)
        self.assertAlmostEqual(sessions[0]["duration_min"], 119.5, delta=0.6)

    def test_short_closed_run_is_ignored(self):
        s = samples([(5, 0), (20, 11000), (5, 0)])
        self.assertEqual(cd.find_charge_sessions(s), [])

    def test_dip_below_threshold_splits_sessions(self):
        s = samples([(1, 0), (40, 11000), (2, 0), (35, 11000), (1, 0)])
        sessions = cd.find_charge_sessions(s)
        self.assertEqual(len(sessions), 2)
        self.assertAlmostEqual(sessions[0]["duration_min"], 39.5, delta=0.6)
        self.assertAlmostEqual(sessions[1]["duration_min"], 34.5, delta=0.6)

    def test_accepts_a_generator_so_backfill_can_stream_chunks(self):
        chunk_a = samples([(10, 0), (60, 11000)])
        start_b = chunk_a[-1]["time"] + STEP
        chunk_b = []
        t = start_b
        for _ in range(120):            # 60 more minutes charging
            chunk_b.append({"time": t, "power": 11000.0})
            t += STEP
        chunk_b.append({"time": t, "power": 0.0})

        def stream():
            yield from chunk_a
            yield from chunk_b

        sessions = cd.find_charge_sessions(stream())
        self.assertEqual(len(sessions), 1)
        self.assertAlmostEqual(sessions[0]["duration_min"], 119.5, delta=0.6)
        self.assertEqual(sessions[0]["start"], T0 + timedelta(minutes=10))


class LookbackTest(unittest.TestCase):
    def test_lookback_covers_a_full_charge(self):
        # A full Ioniq 5 charge at ~11 kW is ~7 h; the old 180-min window
        # clipped session starts.
        self.assertGreaterEqual(cd.LOOKBACK_MINUTES, 12 * 60)


if __name__ == "__main__":
    unittest.main()
