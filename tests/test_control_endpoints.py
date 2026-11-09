"""The order endpoints in api/routers/control.py, with a fake broker: a manual
order's checks and risk gate, closing a position, cancelling an order, the kill
switch, and the live connection surviving a broker error on connect.

Run: python -m unittest discover -s tests -t .
"""
import asyncio
import dataclasses
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

os.environ.setdefault("LOG_FILE", os.path.join(tempfile.gettempdir(), "ndhd-test-engine.log"))

from fastapi import HTTPException, WebSocketDisconnect  # noqa: E402

from api import deps, main as api_main, ws  # noqa: E402
from api.routers import control  # noqa: E402
from api.schemas import ManualOrderRequest  # noqa: E402

engine = deps.engine
ACCOUNT = {"equity": "100000", "cash": "100000", "buying_power": "200000", "options_buying_power": "100000"}


class FakeBroker:
    def __init__(self, positions=None):
        self.positions = positions or []
        self.equity_orders = []
        self.option_orders = []
        self.cancelled = []

    def get_account(self):
        return dict(ACCOUNT)

    def get_positions(self):
        return self.positions

    def stock_snapshot(self, symbol):
        return {"latestQuote": {"ap": 100.0, "bp": 99.9}}

    def submit_equity_order(self, **kwargs):
        self.equity_orders.append(kwargs)
        return {"id": "e1", "status": "accepted"}

    def submit_option_order(self, **kwargs):
        self.option_orders.append(kwargs)
        return {"id": "o1", "status": "accepted"}

    def cancel_order(self, order_id):
        self.cancelled.append(order_id)


def order(**overrides):
    base = dict(symbol="AAPL", asset_class="equity", side="buy", qty=1, order_type="market", confirm=True)
    base.update(overrides)
    return ManualOrderRequest(**base)


class ControlTestBase(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        store = engine.StateStore(str(Path(folder.name) / "state.json"))
        self.config = dataclasses.replace(
            engine.CONFIG, paper=True, live_trading=False, paper_orders=False, sector_map_raw="",
            max_single_position_pct=10.0, max_total_stock_exposure_pct=40.0, stock_max_positions=3,
            max_daily_drawdown_pct=2.0, wheel_max_collateral_pct=25.0, wheel_max_total_collateral_pct=50.0,
            kill_switch_flatten=True,
        )
        self.state = engine.PortfolioState(session_start_equity=100000.0)
        self.broker = FakeBroker()
        for patcher in (
            mock.patch.object(deps, "get_alpaca_client", lambda: self.broker),
            mock.patch.object(deps, "load_state", lambda: self.state),
            mock.patch.object(deps, "get_risk_engine", lambda state=None: engine.RiskEngine(self.config, self.state, store)),
            mock.patch.object(engine, "CONFIG", self.config),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)


class ManualOrderTest(ControlTestBase):
    def assertRefused(self, request, reason):
        result = control.submit_manual_order(request)
        self.assertFalse(result.accepted)
        self.assertIn(reason, result.reason)
        self.assertEqual(self.broker.equity_orders + self.broker.option_orders, [])

    def test_needs_confirm(self):
        self.assertRefused(order(confirm=False), "confirm")

    def test_bad_quantities(self):
        for qty in (0, -5, 0.5, float("inf"), float("nan")):
            with self.subTest(qty=qty):
                self.assertRefused(order(qty=qty), "whole number")

    def test_bad_prices_and_types(self):
        self.assertRefused(order(order_type="limit"), "limit_price is required")
        self.assertRefused(order(order_type="limit", limit_price=-1), "above 0")
        self.assertRefused(order(order_type="stop"), "order_type")
        self.assertRefused(order(side="short"), "side")
        self.assertRefused(order(asset_class="crypto"), "asset_class")
        self.assertRefused(order(symbol="  "), "symbol")

    def test_good_order_is_sent(self):
        result = control.submit_manual_order(order(qty=2))
        self.assertTrue(result.accepted)
        self.assertTrue(result.risk_check_passed)
        self.assertEqual(self.broker.equity_orders[0]["qty"], 2)
        self.assertEqual(self.broker.equity_orders[0]["side"], "buy")

    def test_lower_case_symbol_finds_the_existing_position(self):
        self.broker.positions = [{"symbol": "AAPL", "asset_class": "us_equity", "qty": "10", "market_value": "1000"}]
        result = control.submit_manual_order(order(symbol=" aapl ", side="sell", qty=5))
        self.assertTrue(result.accepted)
        self.assertEqual(self.broker.equity_orders[0]["symbol"], "AAPL")

    def test_order_above_the_risk_limit_is_refused(self):
        result = control.submit_manual_order(order(qty=1000))
        self.assertFalse(result.accepted)
        self.assertFalse(result.risk_check_passed)
        self.assertEqual(self.broker.equity_orders, [])

    def test_no_quote_fails_closed(self):
        self.broker.stock_snapshot = lambda symbol: {"latestQuote": {}}
        self.assertRefused(order(), "Could not determine a price")

    def test_reducing_order_skips_the_risk_limit(self):
        self.broker.positions = [{"symbol": "AAPL", "asset_class": "us_equity", "qty": "5000", "market_value": "500000"}]
        result = control.submit_manual_order(order(side="sell", qty=4000))
        self.assertTrue(result.accepted)

    def test_option_needs_intent_and_limit(self):
        put = "XYZ261218P00100000"
        self.assertRefused(order(symbol=put, asset_class="option"), "position_intent")
        self.assertRefused(order(symbol=put, asset_class="option", position_intent="buy_to_close"), "limit_price")

    def test_short_put_goes_through_the_collateral_check(self):
        put = "XYZ261218P00100000"
        request = order(symbol=put, asset_class="option", side="sell", position_intent="sell_to_open", limit_price=2.5)
        result = control.submit_manual_order(request)
        self.assertTrue(result.accepted)
        self.assertEqual(self.broker.option_orders[0]["position_intent"], "sell_to_open")

        too_big = order(symbol="XYZ261218P00500000", asset_class="option", side="sell",
                        position_intent="sell_to_open", limit_price=2.5)
        result = control.submit_manual_order(too_big)
        self.assertFalse(result.accepted)
        self.assertFalse(result.risk_check_passed)


class CloseAndCancelTest(ControlTestBase):
    def test_close_long_stock_sells_it(self):
        self.broker.positions = [{"symbol": "AAPL", "asset_class": "us_equity", "qty": "10"}]
        result = control.close_position("AAPL")
        self.assertEqual(result.order_id, "e1")
        self.assertEqual(self.broker.equity_orders[0]["side"], "sell")
        self.assertEqual(self.broker.equity_orders[0]["qty"], 10)

    def test_close_short_put_buys_it_back_with_a_limit(self):
        put = "XYZ261218P00100000"
        self.broker.positions = [{"symbol": put, "asset_class": "us_option", "qty": "-1", "current_price": "3.10"}]
        control.close_position(put)
        sent = self.broker.option_orders[0]
        self.assertEqual(sent["side"], "buy")
        self.assertEqual(sent["position_intent"], "buy_to_close")
        self.assertEqual(sent["limit_price"], 3.10)

    def test_close_without_a_position_is_a_404(self):
        with self.assertRaises(HTTPException) as caught:
            control.close_position("AAPL")
        self.assertEqual(caught.exception.status_code, 404)
        self.assertEqual(self.broker.equity_orders, [])

    def test_cancel(self):
        self.assertTrue(control.cancel_order("abc").cancelled)
        self.assertEqual(self.broker.cancelled, ["abc"])

    def test_cancel_failure_is_a_400(self):
        self.broker.cancel_order = mock.Mock(side_effect=engine.AlpacaAPIError("filled"))
        with self.assertRaises(HTTPException) as caught:
            control.cancel_order("abc")
        self.assertEqual(caught.exception.status_code, 400)


class KillSwitchTest(ControlTestBase):
    def test_already_triggered_today_does_nothing(self):
        self.state.kill_switch_date = engine.date_today().isoformat()
        self.broker.positions = [{"symbol": "AAPL", "asset_class": "us_equity", "qty": "10"}]
        result = control.trigger_kill_switch()
        self.assertFalse(result.triggered)
        self.assertTrue(result.already_active_today)
        self.assertEqual(self.broker.equity_orders, [])

    def test_refuses_when_flatten_is_off(self):
        with mock.patch.object(engine, "CONFIG", dataclasses.replace(self.config, kill_switch_flatten=False)):
            with self.assertRaises(HTTPException) as caught:
                control.trigger_kill_switch()
        self.assertEqual(caught.exception.status_code, 400)

    def test_broker_down_is_a_502_and_nothing_is_recorded(self):
        self.broker.get_positions = mock.Mock(side_effect=engine.AlpacaAPIError("down"))
        with self.assertRaises(HTTPException) as caught:
            control.trigger_kill_switch()
        self.assertEqual(caught.exception.status_code, 502)
        self.assertIsNone(self.state.kill_switch_date)


class ConfigKeysTest(unittest.TestCase):
    def test_retired_pdt_setting_is_gone(self):
        self.assertNotIn("pdt_protection", control.ALLOWED_CONFIG_ENV_KEYS)
        self.assertFalse(hasattr(engine.CONFIG, "pdt_protection"))


class FakeSocket:
    """Enough of a WebSocket for ws_endpoint: records JSON, then disconnects."""

    query_params = {"api_key": "the-key"}
    cookies = {}

    def __init__(self):
        self.sent = []
        self.closed = None

    async def accept(self):
        pass

    async def send_json(self, message):
        self.sent.append(message)

    async def receive_text(self):
        raise WebSocketDisconnect()

    async def close(self, code=1000):
        self.closed = code


class FirstSnapshotTest(unittest.TestCase):
    def run_endpoint(self, fast, strategy):
        socket = FakeSocket()
        principal = SimpleNamespace(sections=frozenset({"account", "strategy", "alerts"}))
        with mock.patch.object(deps, "principal_from", return_value=principal), \
                mock.patch.object(ws, "build_fast_snapshot", fast), \
                mock.patch.object(ws, "build_strategy_snapshot", strategy), \
                mock.patch.object(api_main.logs, "read_tail", return_value=[{"line": "hello", "level": "INFO"}]):
            asyncio.run(api_main.ws_endpoint(socket))
        return socket

    def test_good_snapshots_are_sent_then_the_log(self):
        socket = self.run_endpoint(lambda: {"type": "tick"}, lambda: {"type": "strategy"})
        self.assertEqual([m["type"] for m in socket.sent], ["tick", "strategy", "log"])

    def test_broker_error_is_reported_and_the_connection_carries_on(self):
        def broken():
            raise engine.AlpacaAPIError("broker down")

        socket = self.run_endpoint(broken, lambda: {"type": "strategy"})
        self.assertEqual([m["type"] for m in socket.sent], ["error", "strategy", "log"])
        self.assertEqual(socket.sent[0]["tier"], "fast")
        self.assertIn("broker down", socket.sent[0]["message"])
        self.assertIsNone(socket.closed)


if __name__ == "__main__":
    unittest.main()
