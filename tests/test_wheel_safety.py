"""Wheel and risk safety: crash recovery (an order whose outcome wasn't seen must
never lead to a second option), unknown short options, the ex-dividend check
before covered calls, and the buying power checks.

Run: python -m unittest discover -s tests -t .
"""
import dataclasses
import os
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

os.environ.setdefault("LOG_FILE", os.path.join(tempfile.gettempdir(), "ndhd-test-engine.log"))

import portfolio_engine as pe  # noqa: E402
from ndhd import rules  # noqa: E402

TODAY = date(2026, 11, 9)
ACCOUNT = {"equity": "100000", "cash": "100000", "buying_power": "200000", "options_buying_power": "100000"}
PUT = "XYZ261218P00100000"
CALL = "XYZ261218C00120000"


def cfg(**overrides):
    base = dict(
        paper=True, live_trading=False, paper_orders=True, sector_map_raw="", wheel_contract_size=100,
        wheel_min_dte=25, wheel_max_dte=60, order_timeout_seconds=0, wheel_dividend_check=True,
        max_single_position_pct=10.0, max_total_stock_exposure_pct=40.0, stock_max_positions=3,
        max_daily_drawdown_pct=2.0, wheel_max_collateral_pct=25.0, wheel_max_total_collateral_pct=50.0,
    )
    base.update(overrides)
    return dataclasses.replace(pe.CONFIG, **base)


class FakeAPI:
    """Only what the code under test calls; records what it sends."""

    def __init__(self, by_client_id=None, open_orders=None, positions=None):
        self.by_client_id = by_client_id or {}
        self.open_orders = open_orders or []
        self.positions = positions or []
        self.submitted = []
        self.cancelled = []

    def get_order_by_client_id(self, client_order_id):
        return self.by_client_id.get(client_order_id)

    def get_orders(self, status="open"):
        return self.open_orders

    def get_positions(self):
        return self.positions

    def cancel_order(self, order_id):
        self.cancelled.append(order_id)

    def get_order(self, order_id):
        return {"id": order_id, "status": "new"}

    def submit_option_order(self, **kwargs):
        self.submitted.append(kwargs)
        return {"id": "new-order", "status": "new", "symbol": kwargs["symbol"]}

    def option_contracts(self, *args):
        return []

    def option_snapshots(self, *args):
        return {}

    def stock_snapshot(self, symbol):
        return {"latestQuote": {"bp": 100, "ap": 100.2}}


class WheelTestBase(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.path = Path(folder.name) / "state.json"
        self.store = pe.StateStore(str(self.path))
        self.state = pe.PortfolioState()
        self.alerts = []

    def wheel(self, api, earnings=None, config=None):
        alerter = SimpleNamespace(send=lambda **kw: self.alerts.append(kw))
        return pe.WheelStrategy(config or cfg(), api, self.state, self.store, None, earnings, alerter=alerter)


class RecoverPendingOrderTest(WheelTestBase):
    def pending(self, wheel, client_id="wheel-csp-XYZ-1"):
        state = wheel.get_state("XYZ")
        state.pending_client_order_id = client_id
        return state

    def test_nothing_pending_does_nothing(self):
        self.assertFalse(self.wheel(FakeAPI()).recover_pending_order("XYZ"))

    def test_fill_seen_after_a_crash_becomes_the_open_leg(self):
        order = {"id": "o1", "status": "filled", "symbol": PUT, "filled_avg_price": "2.50"}
        wheel = self.wheel(FakeAPI(by_client_id={"wheel-csp-XYZ-1": order}))
        state = self.pending(wheel)
        self.assertTrue(wheel.recover_pending_order("XYZ"))
        self.assertEqual(state.option_symbol, PUT)
        self.assertEqual(state.option_type, "put")
        self.assertEqual(state.entry_premium, 2.5)
        self.assertEqual(state.phase, "CASH_PUT")
        self.assertIsNone(state.pending_client_order_id)
        self.assertEqual(len(self.alerts), 1)

    def test_recovered_call_keeps_the_covered_call_phase(self):
        order = {"id": "o1", "status": "filled", "symbol": CALL, "filled_avg_price": "1.10"}
        wheel = self.wheel(FakeAPI(by_client_id={"wheel-call-XYZ-1": order}))
        state = self.pending(wheel, "wheel-call-XYZ-1")
        self.assertTrue(wheel.recover_pending_order("XYZ"))
        self.assertEqual(state.phase, "COVERED_CALL")
        self.assertEqual(state.expected_shares, 100)

    def test_order_still_working_is_cancelled_and_stays_pending(self):
        order = {"id": "o1", "status": "new", "symbol": PUT}
        api = FakeAPI(by_client_id={"wheel-csp-XYZ-1": order})
        wheel = self.wheel(api)
        state = self.pending(wheel)
        self.assertTrue(wheel.recover_pending_order("XYZ"))
        self.assertEqual(api.cancelled, ["o1"])
        self.assertEqual(state.pending_client_order_id, "wheel-csp-XYZ-1")
        self.assertIsNone(state.option_symbol)

    def test_ended_orders_clear_the_record(self):
        for status in ("canceled", "rejected", "expired"):
            with self.subTest(status=status):
                order = {"id": "o1", "status": status, "symbol": PUT}
                wheel = self.wheel(FakeAPI(by_client_id={"wheel-csp-XYZ-1": order}))
                state = self.pending(wheel)
                self.assertFalse(wheel.recover_pending_order("XYZ"))
                self.assertIsNone(state.pending_client_order_id)

    def test_never_placed_clears_the_record(self):
        wheel = self.wheel(FakeAPI())
        state = self.pending(wheel)
        self.assertFalse(wheel.recover_pending_order("XYZ"))
        self.assertIsNone(state.pending_client_order_id)

    def test_failed_lookup_finds_it_among_open_orders(self):
        working = {"id": "o1", "status": "new", "symbol": PUT, "client_order_id": "wheel-csp-XYZ-1"}
        api = FakeAPI(open_orders=[working])
        wheel = self.wheel(api)
        self.pending(wheel)
        self.assertTrue(wheel.recover_pending_order("XYZ"))
        self.assertEqual(api.cancelled, ["o1"])

    def test_broker_outage_keeps_the_record(self):
        api = FakeAPI()
        api.get_orders = mock.Mock(side_effect=pe.AlpacaAPIError("down"))
        wheel = self.wheel(api)
        state = self.pending(wheel)
        with self.assertRaises(pe.AlpacaAPIError):
            wheel.recover_pending_order("XYZ")
        self.assertEqual(state.pending_client_order_id, "wheel-csp-XYZ-1")

    def test_pending_order_survives_a_restart(self):
        wheel = self.wheel(FakeAPI())
        self.pending(wheel)
        self.store.save(self.state)
        self.assertEqual(self.store.load().wheels["XYZ"].pending_client_order_id, "wheel-csp-XYZ-1")

    def test_state_file_from_before_this_field_still_loads(self):
        self.path.write_text('{"wheels": {"XYZ": {"symbol": "XYZ", "phase": "CASH_PUT"}}, "stocks": {}}', encoding="utf-8")
        self.assertIsNone(self.store.load().wheels["XYZ"].pending_client_order_id)


class ProcessSymbolTest(WheelTestBase):
    def run_symbol(self, api):
        wheel = self.wheel(api)
        with mock.patch.object(wheel, "open_csp") as open_csp, mock.patch.object(wheel, "manage_max_loss"), \
                mock.patch.object(wheel, "manage_profit"):
            wheel.process_symbol(ACCOUNT, api.positions, "XYZ")
        return wheel, open_csp

    def test_a_clean_symbol_opens_a_put(self):
        _, open_csp = self.run_symbol(FakeAPI())
        open_csp.assert_called_once()

    def test_a_working_order_from_before_a_crash_blocks_a_second_put(self):
        state = pe.WheelState(symbol="XYZ", pending_client_order_id="wheel-csp-XYZ-1")
        self.state.wheels["XYZ"] = state
        order = {"id": "o1", "status": "new", "symbol": PUT}
        _, open_csp = self.run_symbol(FakeAPI(by_client_id={"wheel-csp-XYZ-1": order}))
        open_csp.assert_not_called()

    def test_an_unknown_short_option_blocks_a_new_put_and_alerts(self):
        position = {"symbol": PUT, "asset_class": "us_option", "qty": "-1"}
        _, open_csp = self.run_symbol(FakeAPI(positions=[position]))
        open_csp.assert_not_called()
        self.assertIn("Unknown short option", self.alerts[0]["subject"])

    def test_other_symbols_short_options_are_ignored(self):
        position = {"symbol": "ABC261218P00100000", "asset_class": "us_option", "qty": "-1"}
        _, open_csp = self.run_symbol(FakeAPI(positions=[position]))
        open_csp.assert_called_once()

    def test_a_tracked_leg_is_left_alone(self):
        self.state.wheels["XYZ"] = pe.WheelState(symbol="XYZ", option_symbol=PUT, option_type="put")
        position = {"symbol": PUT, "asset_class": "us_option", "qty": "-1"}
        _, open_csp = self.run_symbol(FakeAPI(positions=[position]))
        open_csp.assert_not_called()
        self.assertEqual(self.alerts, [])


class IntentBeforeSubmitTest(WheelTestBase):
    """The intent must be on disk before the order leaves."""

    def candidate(self, symbol=PUT):
        return SimpleNamespace(symbol=symbol, strike=100.0, dte=40, delta=0.3, midpoint=2.5)

    def test_put_intent_is_saved_before_the_order_is_sent(self):
        api = FakeAPI()
        seen = {}

        def submit(**kwargs):
            seen["on_disk"] = self.store.load().wheels["XYZ"].pending_client_order_id
            seen["sent"] = kwargs["client_order_id"]
            return {"id": "o1", "status": "new", "symbol": kwargs["symbol"]}

        api.submit_option_order = submit
        wheel = self.wheel(api, earnings=SimpleNamespace(is_blackout=lambda s: False))
        wheel.risk = SimpleNamespace(allow_wheel_entry=lambda *a, **k: True)
        with mock.patch.object(wheel, "select_option", return_value=self.candidate()), \
                mock.patch.object(wheel, "wait_fill", return_value=None):
            wheel.open_csp(ACCOUNT, "XYZ")
        self.assertEqual(seen["on_disk"], seen["sent"])

    def test_submit_failure_leaves_the_record_for_the_next_cycle(self):
        api = FakeAPI()
        api.submit_option_order = mock.Mock(side_effect=pe.AlpacaAPIError("timeout"))
        wheel = self.wheel(api, earnings=SimpleNamespace(is_blackout=lambda s: False))
        wheel.risk = SimpleNamespace(allow_wheel_entry=lambda *a, **k: True)
        with mock.patch.object(wheel, "select_option", return_value=self.candidate()):
            with self.assertRaises(pe.AlpacaAPIError):
                wheel.open_csp(ACCOUNT, "XYZ")
        self.assertTrue(wheel.get_state("XYZ").pending_client_order_id.startswith("wheel-csp-XYZ-"))

    def test_fill_records_the_leg_and_clears_the_intent(self):
        wheel = self.wheel(FakeAPI(), earnings=SimpleNamespace(is_blackout=lambda s: False))
        wheel.risk = SimpleNamespace(allow_wheel_entry=lambda *a, **k: True)
        filled = {"id": "new-order", "status": "filled", "filled_avg_price": "2.40"}
        with mock.patch.object(wheel, "select_option", return_value=self.candidate()), \
                mock.patch.object(wheel, "wait_fill", return_value=filled):
            wheel.open_csp(ACCOUNT, "XYZ")
        state = wheel.get_state("XYZ")
        self.assertEqual(state.option_symbol, PUT)
        self.assertEqual(state.entry_premium, 2.4)
        self.assertIsNone(state.pending_client_order_id)

    def test_dry_run_leaves_nothing_pending(self):
        api = FakeAPI()
        api.submit_option_order = lambda **k: {"id": "DRYRUN-1", "status": "dry_run", "symbol": k["symbol"]}
        wheel = self.wheel(api, earnings=SimpleNamespace(is_blackout=lambda s: False))
        wheel.risk = SimpleNamespace(allow_wheel_entry=lambda *a, **k: True)
        with mock.patch.object(wheel, "select_option", return_value=self.candidate()):
            wheel.open_csp(ACCOUNT, "XYZ")
        state = wheel.get_state("XYZ")
        self.assertIsNone(state.pending_client_order_id)
        self.assertIsNone(state.option_symbol)


class WaitFillLoggingTest(WheelTestBase):
    def test_timeout_cancel_is_logged(self):
        api = FakeAPI()
        with self.assertLogs(pe.LOGGER, level="INFO") as logs:
            self.assertIsNone(self.wheel(api, config=cfg(order_timeout_seconds=0)).wait_fill("o1"))
        self.assertEqual(api.cancelled, ["o1"])
        self.assertTrue(any("cancelled" in line for line in logs.output))

    def test_broker_cancel_is_logged(self):
        api = FakeAPI()
        api.get_order = lambda order_id: {"id": order_id, "status": "canceled", "symbol": PUT}
        with self.assertLogs(pe.LOGGER, level="INFO") as logs:
            self.assertIsNone(self.wheel(api, config=cfg(order_timeout_seconds=30)).wait_fill("o1"))
        self.assertTrue(any("ended unfilled: canceled" in line for line in logs.output))


class ExDividendRuleTest(unittest.TestCase):
    def test_listed_future_date_is_used(self):
        self.assertEqual(rules.next_ex_dividend(date(2026, 12, 10), TODAY), date(2026, 12, 10))
        self.assertEqual(rules.next_ex_dividend(TODAY, TODAY), TODAY)

    def test_no_dividend(self):
        self.assertIsNone(rules.next_ex_dividend(None, TODAY))

    def test_past_date_is_estimated_a_quarter_on_erring_early(self):
        # Listed 2026-09-03, so about 2026-12-03; the margin makes it 11-23.
        self.assertEqual(rules.next_ex_dividend(date(2026, 9, 3), TODAY), date(2026, 11, 23))

    def test_estimate_is_never_before_today(self):
        self.assertEqual(rules.next_ex_dividend(date(2026, 8, 15), TODAY), TODAY)

    def test_old_date_rolls_forward_several_quarters(self):
        self.assertGreaterEqual(rules.next_ex_dividend(date(2025, 1, 2), TODAY), TODAY)

    def test_calendar_reading(self):
        self.assertEqual(pe.ex_dividend_date({"Ex-Dividend Date": date(2026, 12, 10)}), date(2026, 12, 10))
        self.assertEqual(pe.ex_dividend_date({"Ex-Dividend Date": "2026-12-10"}), date(2026, 12, 10))
        self.assertIsNone(pe.ex_dividend_date({"Earnings Date": [date(2026, 12, 1)]}))
        self.assertIsNone(pe.ex_dividend_date({"Ex-Dividend Date": "not a date"}))
        self.assertIsNone(pe.ex_dividend_date(None))

    def test_contract_expiring_after_the_limit_fails(self):
        contract = {"tradable": True, "symbol": CALL, "expiration_date": "2026-12-18", "strike_price": "120",
                    "open_interest": "500"}
        snapshot = {"greeks": {"delta": 0.3}, "latestQuote": {"bp": 2.0, "ap": 2.1}}
        common = dict(option_type="call", underlying_price=110.0, today=TODAY, min_dte=25, max_dte=60,
                      min_bid=0.1, max_spread_pct=20.0, min_open_interest=10)
        self.assertIsNotNone(rules.evaluate_contract(contract, snapshot, **common))
        self.assertIsNotNone(rules.evaluate_contract(contract, snapshot, latest_expiration=date(2026, 12, 18), **common))
        self.assertIsNone(rules.evaluate_contract(contract, snapshot, latest_expiration=date(2026, 12, 17), **common))


class CoveredCallDividendTest(WheelTestBase):
    SHARES = [{"symbol": "XYZ", "asset_class": "us_equity", "qty": "100", "avg_entry_price": "100"}]

    def run_call(self, lookup, config=None):
        api = FakeAPI()
        earnings = SimpleNamespace(is_blackout=lambda s: False, next_ex_dividend=lambda s: lookup)
        wheel = self.wheel(api, earnings=earnings, config=config)
        wheel.get_state("XYZ").phase = "COVERED_CALL"
        wheel.get_state("XYZ").assignment_basis = 100.0
        with mock.patch.object(pe, "date_today", return_value=TODAY), \
                mock.patch.object(wheel, "select_option", side_effect=pe.NoSuitableOption("none")) as select:
            try:
                wheel.open_covered_call(self.SHARES, "XYZ")
            except pe.NoSuitableOption:
                pass
        return select, api

    def test_failed_lookup_sells_nothing(self):
        select, api = self.run_call((False, None))
        select.assert_not_called()
        self.assertEqual(api.submitted, [])

    def test_ex_date_inside_the_minimum_sells_nothing(self):
        select, _ = self.run_call((True, TODAY + timedelta(days=20)))
        select.assert_not_called()

    def test_ex_date_further_out_limits_the_expiry(self):
        select, _ = self.run_call((True, TODAY + timedelta(days=45)))
        self.assertEqual(select.call_args.kwargs["latest_expiration"], TODAY + timedelta(days=44))

    def test_no_dividend_sets_no_limit(self):
        select, _ = self.run_call((True, None))
        self.assertIsNone(select.call_args.kwargs["latest_expiration"])

    def test_check_can_be_switched_off(self):
        select, _ = self.run_call((False, None), config=cfg(wheel_dividend_check=False))
        self.assertIsNone(select.call_args.kwargs["latest_expiration"])


class NextExDividendLookupTest(unittest.TestCase):
    def setUp(self):
        self.filter = pe.EarningsFilter(True, 5)

    def lookup(self, calendar):
        ticker = SimpleNamespace(calendar=calendar)
        with mock.patch("yfinance.Ticker", return_value=ticker) as patched:
            result = self.filter.next_ex_dividend("XYZ")
        return result, patched

    def test_listed_date(self):
        future = pe.date_today() + timedelta(days=30)
        self.assertEqual(self.lookup({"Ex-Dividend Date": future})[0], (True, future))

    def test_company_without_a_dividend(self):
        self.assertEqual(self.lookup({"Earnings Date": [pe.date_today()]})[0], (True, None))

    def test_empty_answer_is_a_failure_not_no_dividend(self):
        self.assertEqual(self.lookup({})[0], (False, None))

    def test_looked_up_once_a_day(self):
        self.lookup({"Earnings Date": [pe.date_today()]})
        _, patched = self.lookup({"Earnings Date": [pe.date_today()]})
        patched.assert_not_called()

    def test_failure_is_not_retried_straight_away(self):
        self.lookup({})
        _, patched = self.lookup({})
        patched.assert_not_called()


class BuyingPowerTest(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        store = pe.StateStore(str(Path(folder.name) / "state.json"))
        self.risk = pe.RiskEngine(cfg(), pe.PortfolioState(session_start_equity=100000.0), store)

    def test_stock_entry_must_fit_buying_power(self):
        self.assertTrue(self.risk.allow_stock_entry(ACCOUNT, [], "AAPL", 9000.0, {"AAPL"}))
        short = {**ACCOUNT, "buying_power": "5000"}
        self.assertFalse(self.risk.allow_stock_entry(short, [], "AAPL", 9000.0, {"AAPL"}))

    def test_stock_entry_fails_closed_without_the_field(self):
        account = {k: v for k, v in ACCOUNT.items() if k != "buying_power"}
        self.assertFalse(self.risk.allow_stock_entry(account, [], "AAPL", 9000.0, {"AAPL"}))

    def test_small_account_is_no_longer_limited_by_a_day_trade_count(self):
        account = {"equity": "20000", "cash": "20000", "buying_power": "40000", "options_buying_power": "20000",
                   "daytrade_count": "5"}
        self.risk.state.session_start_equity = 20000.0
        self.assertTrue(self.risk.allow_stock_entry(account, [], "AAPL", 1000.0, {"AAPL"}))

    def test_put_collateral_uses_what_is_actually_free(self):
        # Cash still shows $100k, but $90k is already held against open puts.
        held = {**ACCOUNT, "options_buying_power": "10000"}
        self.assertFalse(self.risk.allow_wheel_entry(held, 20000.0, positions=[]))
        self.assertTrue(self.risk.allow_wheel_entry(held, 9000.0, positions=[]))

    def test_put_collateral_also_limited_by_cash(self):
        account = {**ACCOUNT, "cash": "5000"}
        self.assertFalse(self.risk.allow_wheel_entry(account, 9000.0, positions=[]))

    def test_put_entry_fails_closed_without_the_field(self):
        account = {k: v for k, v in ACCOUNT.items() if k != "options_buying_power"}
        self.assertFalse(self.risk.allow_wheel_entry(account, 9000.0, positions=[]))


if __name__ == "__main__":
    unittest.main()
