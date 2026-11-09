"""Stock strategy after a crash: StockStrategy.process_symbol must never send a
second entry, whatever state the last run left behind.

Run: python -m unittest discover -s tests -t .
"""
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

os.environ.setdefault("LOG_FILE", os.path.join(tempfile.gettempdir(), "ndhd-test-engine.log"))

import portfolio_engine as pe  # noqa: E402

ACCOUNT = {"equity": "100000", "cash": "100000", "buying_power": "200000"}


class FakeAPI:
    def __init__(self, open_orders=None):
        self.open_orders = open_orders or []
        self.cancelled = []

    def get_orders(self, status="open"):
        return self.open_orders

    def cancel_order(self, order_id):
        self.cancelled.append(order_id)


class StockCrashTest(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.store = pe.StateStore(str(Path(folder.name) / "state.json"))
        self.state = pe.PortfolioState()

    def run_symbol(self, status="IDLE", positions=None, open_orders=None, stop_order_id=None):
        api = FakeAPI(open_orders)
        self.state.stocks["XYZ"] = pe.StockState(symbol="XYZ", direction="long", status=status,
                                                 stop_order_id=stop_order_id)
        strategy = pe.StockStrategy(pe.CONFIG, api, self.state, self.store, None, None)
        with mock.patch.object(strategy, "open_position") as opened, \
                mock.patch.object(strategy, "manage_existing") as managed, \
                mock.patch.object(strategy, "indicators", return_value=(100.0, 2.0, 95.0, "LONG")):
            strategy.process_symbol(ACCOUNT, positions or [], "XYZ")
        return opened, managed, api

    def test_clean_symbol_may_enter(self):
        opened, managed, _ = self.run_symbol()
        opened.assert_called_once()
        managed.assert_not_called()

    def test_working_entry_from_before_the_crash_blocks_a_second(self):
        order = {"symbol": "XYZ", "client_order_id": "stock-entry-XYZ-abc"}
        opened, managed, _ = self.run_symbol("ENTRY_SUBMITTING", open_orders=[order])
        opened.assert_not_called()
        managed.assert_not_called()

    def test_entry_that_filled_during_the_crash_is_managed_not_doubled(self):
        position = {"symbol": "XYZ", "asset_class": "us_equity", "qty": "10"}
        opened, managed, _ = self.run_symbol("ENTRY_SUBMITTING", positions=[position])
        opened.assert_not_called()
        managed.assert_called_once()

    def test_entry_that_never_reached_the_broker_resets_without_entering(self):
        opened, managed, _ = self.run_symbol("ENTRY_SUBMITTING")
        opened.assert_not_called()
        managed.assert_called_once()

    def test_other_symbols_working_entry_does_not_block(self):
        order = {"symbol": "ABC", "client_order_id": "stock-entry-ABC-abc"}
        opened, _, _ = self.run_symbol(open_orders=[order])
        opened.assert_called_once()

    def test_stale_stop_is_cancelled_when_the_position_is_gone(self):
        _, _, api = self.run_symbol("TRAILING_STOP_ACTIVE", stop_order_id="stop-1")
        self.assertEqual(api.cancelled, ["stop-1"])


if __name__ == "__main__":
    unittest.main()
