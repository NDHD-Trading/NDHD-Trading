// The live panels, fed made-up data over a mocked /ws.
import { expect, test } from "../support/app.ts";
import * as data from "../support/data.ts";

const tickWith = (account: object) => ({ ...data.tick, account: { ...data.account, ...account } });
const strategyWith = (risk: object) => ({ ...data.strategy, risk: { ...data.risk, ...risk } });

test.describe("top bar", () => {
  test("shows paper mode with orders on, and a live connection", async ({ dashboard }) => {
    await dashboard.open();
    await expect(dashboard.topBar).toContainText("PAPER · orders on");
    await expect(dashboard.topBar.locator(".dot.up")).toBeVisible();
    await expect(dashboard.topBar).toContainText("Live");
  });

  test("shows a dry run when orders are off", async ({ dashboard }) => {
    await dashboard.open(undefined, { messages: [tickWith({ orders_enabled: false })] });
    await expect(dashboard.topBar).toContainText("PAPER · dry run");
  });

  test("makes live trading impossible to miss", async ({ dashboard }) => {
    await dashboard.open(undefined, { messages: [tickWith({ paper: false, live_trading: true })] });
    const badge = dashboard.topBar.locator(".badge.live");
    await expect(badge).toHaveText("LIVE TRADING");
    await expect(dashboard.topBar).not.toContainText("PAPER");
  });
});

test.describe("connection", () => {
  test("shows a banner when the connection drops, and recovers by itself", async ({ page, dashboard }) => {
    await dashboard.open();
    await expect(dashboard.topBar).toContainText("Live");
    dashboard.sockets[0].close();
    // The PDT note shares the .reconnect style, so find this banner by its words.
    const banner = page.locator(".banner.reconnect", { hasText: "Live updates paused." });
    await expect(banner).toBeVisible();
    await expect(dashboard.topBar).toContainText("Reconnecting…");
    await expect(banner).toHaveCount(0, { timeout: 10_000 });
    await expect(dashboard.topBar).toContainText("Live");
    expect(dashboard.sockets.length).toBe(2);
  });

  test("shows a server error in the footer", async ({ page, dashboard }) => {
    await dashboard.open();
    dashboard.send({ type: "error", tier: "fast", message: "Alpaca is unhappy" });
    await expect(page.locator("footer")).toContainText("Last error: Alpaca is unhappy");
  });

  test("clears the error once that tier works again", async ({ page, dashboard }) => {
    await dashboard.open();
    dashboard.send({ type: "error", tier: "fast", message: "Alpaca is unhappy" });
    await expect(page.locator("footer")).toContainText("Last error: Alpaca is unhappy");
    dashboard.send(data.strategy);
    await expect(page.locator("footer")).toContainText("Last error: Alpaca is unhappy");
    dashboard.send(data.tick);
    await expect(page.locator("footer")).not.toContainText("Last error");
  });

  test("ignores a malformed message and keeps working", async ({ page, dashboard }) => {
    await dashboard.open();
    dashboard.sockets[0].send("this is not json");
    dashboard.send(tickWith({ equity: 123456 }));
    await expect(page.locator(".hero-equity .value")).toHaveText("$123,456.00");
  });
});

test.describe("hero numbers", () => {
  test("shows equity, today's gain, buying power and drawdown", async ({ page, dashboard }) => {
    await dashboard.open();
    const hero = page.locator(".hero");
    await expect(hero.locator(".hero-equity .value")).toHaveText("$101,000.00");
    await expect(hero.locator(".delta.up")).toHaveText("+$1,000.00 (+1.00%) today");
    await expect(hero.locator(".stat-card", { hasText: "Buying power" })).toContainText("$80,000.00");
    await expect(hero.locator(".stat-card", { hasText: "Buying power" })).toContainText("Cash: $40,000.00");
    await expect(hero.locator(".stat-card", { hasText: "Daily drawdown" })).toContainText("0.50%");
    await expect(hero.locator(".stat-card", { hasText: "Daily drawdown" })).toContainText("Halt at 3.00%");
  });

  test("shows a loss as a loss", async ({ page, dashboard }) => {
    await dashboard.open(undefined, { messages: [tickWith({ equity: 99000 }), data.strategy] });
    await expect(page.locator(".delta.down")).toHaveText("-$1,000.00 (-1.00%) today");
  });

  test("waits politely before the first data arrives", async ({ page, dashboard }) => {
    await dashboard.open(undefined, { messages: [] });
    await expect(page.locator(".hero-equity .value")).toHaveText("—");
    await expect(page.getByText("Waiting for session data…")).toBeVisible();
    await expect(dashboard.card("Risk").getByText("Loading…")).toBeVisible();
  });

  test("updates on each tick and draws the equity line", async ({ page, dashboard }) => {
    await dashboard.open();
    await expect(page.locator(".sparkline svg")).toHaveCount(0);
    dashboard.send(tickWith({ equity: 102000 }));
    await expect(page.locator(".hero-equity .value")).toHaveText("$102,000.00");
    await expect(page.locator(".sparkline svg")).toBeVisible();
  });
});

test.describe("positions and orders", () => {
  test("lists a stock position with its gain", async ({ dashboard }) => {
    await dashboard.open();
    const row = dashboard.row("Positions", "AAPL");
    await expect(row).toContainText("long");
    await expect(row).toContainText("$150.00");
    await expect(row).toContainText("$1,600.00");
    await expect(row.locator(".pos")).toHaveText("+$100.00 (+6.67%)");
  });

  test("marks an option and shows its loss", async ({ dashboard }) => {
    await dashboard.open();
    const row = dashboard.row("Positions", "XYZ261218P00100000");
    await expect(row.locator(".pill", { hasText: "OPT" })).toBeVisible();
    await expect(row.locator(".neg")).toHaveText("-$50.00 (-20.00%)");
    await expect(dashboard.card("Positions").locator(".card-title")).toContainText("2");
  });

  test("lists an open order", async ({ dashboard }) => {
    await dashboard.open();
    const row = dashboard.row("Open orders", "MSFT");
    await expect(row).toContainText("buy");
    await expect(row).toContainText("limit");
    await expect(row).toContainText("$400.00");
    await expect(row).toContainText("new");
  });

  test("says so when there's nothing open", async ({ page, dashboard }) => {
    await dashboard.open(undefined, { messages: [{ ...data.tick, positions: [], orders: [] }] });
    await expect(page.getByText("No open positions.")).toBeVisible();
    await expect(page.getByText("No open orders.")).toBeVisible();
  });
});

test.describe("risk panel", () => {
  test("shows the guardrails", async ({ dashboard }) => {
    await dashboard.open();
    const risk = dashboard.card("Risk & guardrails");
    await expect(risk).toContainText("0.50% / 3.00%");
    await expect(risk).toContainText("$1,600.00 / $60,000.00");
    await expect(risk).toContainText("1 / 8");
    await expect(risk).toContainText("technology");
    await expect(risk).toContainText("PDT protection: active");
  });

  test("colours a limit that's nearly used up", async ({ dashboard }) => {
    await dashboard.open(undefined, { messages: [strategyWith({ daily_drawdown_pct: 2.95 }), data.tick] });
    const meter = dashboard.card("Risk & guardrails").locator(".meter", { hasText: "Daily drawdown" });
    await expect(meter.locator(".meter-fill.danger")).toBeVisible();
  });

  test("warns when PDT protection is degraded", async ({ dashboard }) => {
    await dashboard.open(undefined, {
      messages: [strategyWith({ pdt_protection: { enabled_in_config: true, effective: false, note: "Fields missing." } })],
    });
    const risk = dashboard.card("Risk & guardrails");
    await expect(risk.locator(".banner.danger")).toContainText("PDT protection: degraded");
    await expect(risk.locator(".banner.danger")).toContainText("Fields missing.");
  });

  test("announces a daily halt", async ({ page, dashboard }) => {
    await dashboard.open(undefined, { messages: [strategyWith({ daily_risk_halted: true })] });
    await expect(page.locator(".banner.danger", { hasText: "Trading halted" })).toContainText("Daily drawdown limit reached.");
  });

  test("announces an active kill switch", async ({ page, dashboard }) => {
    await dashboard.open(undefined, { messages: [strategyWith({ kill_switch_active: true })] });
    await expect(page.locator(".banner.danger", { hasText: "Trading halted" })).toContainText("Kill switch cooldown is active.");
    await expect(dashboard.card("Risk & guardrails").getByText("Kill switch active")).toBeVisible();
  });

  test("shows no halt banner on a normal day", async ({ page, dashboard }) => {
    await dashboard.open();
    await expect(page.getByText("Trading halted")).toHaveCount(0);
  });
});

test.describe("strategy panels", () => {
  test("shows a stock's signal, indicators and stop", async ({ dashboard }) => {
    await dashboard.open();
    const aapl = dashboard.card("Stock strategy").locator(".card", { hasText: "AAPL" });
    await expect(aapl.locator(".pill.signal-long")).toHaveText("LONG");
    await expect(aapl).toContainText("158.00 / 150.00");
    await expect(aapl).toContainText("(trending)");
    await expect(aapl).toContainText("Trailing stop");
    await expect(aapl).toContainText("$152.00");
  });

  test("explains why a stock has no indicators", async ({ dashboard }) => {
    await dashboard.open();
    const msft = dashboard.card("Stock strategy").locator(".card", { hasText: "MSFT" });
    await expect(msft.locator(".banner.warning")).toHaveText("Not enough bars");
    await expect(msft).not.toContainText("Trailing stop");
  });

  test("shows the wheel's phase and open leg", async ({ dashboard }) => {
    await dashboard.open();
    const panel = dashboard.card("Wheel strategy");
    const open = panel.locator(".card", { hasText: "XYZ" });
    await expect(open.locator(".pill")).toHaveText("CASH PUT");
    await expect(open).toContainText("XYZ261218P00100000");
    await expect(open).toContainText("$2.90 / $3.10");
    await expect(open.locator(".neg")).toHaveText("-20.00%");
    await expect(panel.locator(".card", { hasText: "ABC" })).toContainText("No open leg.");
  });

  test("labels prices as stale while the market is closed", async ({ dashboard }) => {
    const closed = { ...data.strategy, market: { is_open: false, next_open: "2026-11-09T14:30:00Z", next_close: null } };
    await dashboard.open(undefined, { messages: [closed] });
    const stocks = dashboard.card("Stock strategy");
    await expect(stocks.locator(".market-closed")).toContainText("Market closed · prices and spreads are stale");
    await expect(stocks.locator(".card", { hasText: "AAPL" })).toContainText("(last)");
    await expect(stocks.locator(".card", { hasText: "AAPL" })).toContainText("(stale)");
  });

  test("shows no closed-market label while it's open", async ({ page, dashboard }) => {
    await dashboard.open();
    await expect(dashboard.card("Stock strategy").locator(".card").first()).toBeVisible();
    await expect(page.locator(".market-closed")).toHaveCount(0);
  });
});

test.describe("console", () => {
  test("streams log lines, coloured by level", async ({ page, dashboard }) => {
    await dashboard.open();
    const console_ = page.locator(".console-card");
    await expect(console_).toContainText("3 lines");
    await expect(console_.locator(".console-line.ERROR")).toHaveText("2026-11-06 | ERROR | Quote failed");
    dashboard.send({ type: "log", entries: [{ line: "one more", level: "INFO" }] });
    await expect(console_).toContainText("4 lines");
  });

  test("Clear empties it, and new lines still arrive", async ({ page, dashboard }) => {
    await dashboard.open();
    const console_ = page.locator(".console-card");
    await expect(console_).toContainText("3 lines");
    await console_.getByRole("button", { name: "Clear" }).click();
    await expect(console_).toContainText("0 lines");
    await expect(console_.locator(".console-empty")).toBeVisible();
    dashboard.send({ type: "log", entries: [{ line: "after clear", level: "INFO" }] });
    await expect(console_.locator(".console-line")).toHaveText("after clear");
  });

  test("keeps only the last 500 lines", async ({ page, dashboard }) => {
    await dashboard.open();
    const entries = Array.from({ length: 600 }, (_, i) => ({ line: `line ${i}`, level: "INFO" }));
    dashboard.send({ type: "log", entries });
    await expect(page.locator(".console-card")).toContainText("500 lines");
  });
});

test.describe("alerts", () => {
  test("old alerts go in the feed without a pop-up", async ({ page, dashboard }) => {
    await dashboard.open();
    await expect(dashboard.card("Alert feed")).toContainText("Old alert subject");
    await expect(page.locator(".toast")).toHaveCount(0);
  });

  test("a new alert pops up once, then goes away by itself", async ({ page, dashboard }) => {
    await dashboard.open();
    await expect(dashboard.card("Alert feed")).toContainText("Old alert subject");
    const withNew = { ...data.tick, alerts: [data.alertNew, data.alertOld] };
    dashboard.send(withNew);
    const toast = page.locator(".toast");
    await expect(toast).toHaveCount(1);
    await expect(toast).toContainText("New alert subject");
    await expect(toast).toHaveClass(/critical/);

    dashboard.send(withNew);
    await expect(toast).toHaveCount(1);
    await expect(toast).toHaveCount(0, { timeout: 10_000 });
    await expect(dashboard.card("Alert feed")).toContainText("New alert subject");
  });

  test("says so when there are none", async ({ page, dashboard }) => {
    await dashboard.open(undefined, { messages: [{ ...data.tick, alerts: [] }] });
    await expect(page.getByText("No alerts yet.")).toBeVisible();
  });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the sign-in screen fits the width", async ({ page, dashboard }) => {
    await page.goto("/");
    await expect(dashboard.signInHeading).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test("the dashboard page doesn't scroll sideways", async ({ page, dashboard }) => {
    await dashboard.open();
    await expect(dashboard.card("Positions")).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test("the kill switch, Settings and Sign out are on screen", async ({ dashboard }) => {
    await dashboard.open();
    await expect(dashboard.killSwitchButton).toBeInViewport({ ratio: 1 });
    await expect(dashboard.topBar.getByTitle("Settings")).toBeInViewport({ ratio: 1 });
    await expect(dashboard.topBar.getByRole("button", { name: "Sign out" })).toBeInViewport({ ratio: 1 });
  });

  test("the kill switch stays on screen after scrolling down", async ({ page, dashboard }) => {
    await dashboard.open();
    await page.locator("footer").scrollIntoViewIfNeeded();
    await expect(dashboard.killSwitchButton).toBeInViewport({ ratio: 1 });
  });
});

test.describe("on a tablet", () => {
  test.use({ viewport: { width: 768, height: 1024 } });

  test("the dashboard page doesn't scroll sideways", async ({ page, dashboard }) => {
    await dashboard.open();
    await expect(dashboard.card("Positions")).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
