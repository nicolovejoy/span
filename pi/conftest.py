"""Shared pytest setup for the Pi test suite.

Installs a no-op matplotlib stub into sys.modules at import, before any test
module is collected. Previously test_cool_alert.py and test_weekly_report.py each
installed their own stub behind `if "matplotlib" not in sys.modules`, so whichever
imported first won; test_cool_alert.py's minimal stub shadowed the fuller one
test_weekly_report.py needs (`subplots`, `ticker.StrMethodFormatter`), making 5
weekly-report tests fail order-dependently under a full run.
"""
import sys
import types


def _install_matplotlib_stub():
    if "matplotlib" in sys.modules:
        return
    _mpl = types.ModuleType("matplotlib")
    _mpl.use = lambda *a, **k: None
    sys.modules["matplotlib"] = _mpl

    class _FakeMplObject:
        """Generic no-op stand-in for a matplotlib Figure or Axes — every
        attribute access returns a callable that accepts any args and does
        nothing, so chart-rendering code can run without a real matplotlib
        backend. Charts themselves are manual-verify (see the plan); these
        tests only need the rendering code path not to crash.

        get_ylim/twinx are special-cased so _add_cost_axis's real logic
        (get_ylim -> twinx -> set_ylim) runs against something tuple- and
        attribute-shaped instead of the generic None-returning lambda."""
        def get_ylim(self, *a, **k):
            return (0.0, 1.0)

        def twinx(self, *a, **k):
            return _FakeMplObject()

        @property
        def yaxis(self):
            return _FakeMplObject()

        def __getattr__(self, name):
            return lambda *a, **k: None

    _plt = types.ModuleType("matplotlib.pyplot")
    _plt.subplots = lambda *a, **k: (_FakeMplObject(), _FakeMplObject())
    _plt.close = lambda *a, **k: None
    sys.modules["matplotlib.pyplot"] = _plt
    sys.modules["matplotlib.dates"] = types.ModuleType("matplotlib.dates")

    _mpl_ticker = types.ModuleType("matplotlib.ticker")
    _mpl_ticker.StrMethodFormatter = lambda *a, **k: None
    _mpl.ticker = _mpl_ticker
    sys.modules["matplotlib.ticker"] = _mpl_ticker


_install_matplotlib_stub()
