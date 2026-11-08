// The buttons that move money. Every write is answered here in the browser;
// the Dashboard fixture fails any test that sends one nobody mocked.
import { expect, test, type Dashboard } from "../support/app.ts";

const KILL_SWITCH = "**/api/kill-switch";
const ORDERS = /\/api\/orders$/;

test.describe("kill switch", () => {
  async function openModal(dashboard: Dashboard) {
    await dashboard.open();
    await dashboard.killSwitchButton.click();
    await expect(dashboard.modal.getByRole("heading", { name: "Trigger kill switch" })).toBeVisible();
    return dashboard.modal.getByRole("button", { name: "Flatten everything" });
  }

  test("stays locked until FLATTEN is typed", async ({ dashboard }) => {
    const flatten = await openModal(dashboard);
    const input = dashboard.modal.getByPlaceholder("FLATTEN");
    await expect(flatten).toBeDisabled();
    for (const wrong of ["FLAT", "FLATTEN NOW", "yes"]) {
      await input.fill(wrong);
      await expect(flatten).toBeDisabled();
    }
    await input.fill("FLATTEN");
    await expect(flatten).toBeEnabled();
  });

  test("Cancel sends nothing", async ({ dashboard }) => {
    const calls = await dashboard.mockWrite(KILL_SWITCH, 200, {});
    await openModal(dashboard);
    await dashboard.modal.getByPlaceholder("FLATTEN").fill("FLATTEN");
    await dashboard.modal.getByRole("button", { name: "Cancel" }).click();
    await expect(dashboard.modal).toHaveCount(0);
    expect(calls).toHaveLength(0);
  });

  test("clicking outside closes it and sends nothing", async ({ page, dashboard }) => {
    const calls = await dashboard.mockWrite(KILL_SWITCH, 200, {});
    await openModal(dashboard);
    await page.locator(".modal-backdrop").click({ position: { x: 5, y: 5 } });
    await expect(dashboard.modal).toHaveCount(0);
    expect(calls).toHaveLength(0);
  });

  test("confirming sends exactly one request", async ({ dashboard }) => {
    const calls = await dashboard.mockWrite(KILL_SWITCH, 200, {
      triggered: true,
      already_active_today: false,
      kill_switch_date: "2026-11-08",
      closed_symbols: ["AAPL"],
    });
    const flatten = await openModal(dashboard);
    await dashboard.modal.getByPlaceholder("FLATTEN").fill(" flatten ");
    await flatten.click();
    await expect(dashboard.modal).toHaveCount(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].method()).toBe("POST");
  });

  test("a failure is shown", async ({ page, dashboard }) => {
    await dashboard.mockWrite(KILL_SWITCH, 502, { detail: "Broker down" });
    const flatten = await openModal(dashboard);
    await dashboard.modal.getByPlaceholder("FLATTEN").fill("FLATTEN");
    await flatten.click();
    await expect(page.locator(".banner.danger", { hasText: "Action failed" })).toContainText("Broker down");
  });
});

test.describe("closing a position", () => {
  test("asks first, then closes that symbol", async ({ dashboard }) => {
    const calls = await dashboard.mockWrite("**/api/positions/AAPL/close", 200, {
      symbol: "AAPL",
      order_id: "x",
      status: "accepted",
      dry_run: false,
    });
    await dashboard.open();
    await dashboard.row("Positions", "AAPL").getByRole("button", { name: "Close" }).click();
    await expect(dashboard.modal.getByRole("heading", { name: "Close AAPL" })).toBeVisible();
    expect(calls).toHaveLength(0);
    await dashboard.modal.getByRole("button", { name: "Close AAPL" }).click();
    await expect(dashboard.modal).toHaveCount(0);
    expect(calls).toHaveLength(1);
  });

  test("works for an option symbol", async ({ dashboard }) => {
    const calls = await dashboard.mockWrite("**/api/positions/XYZ261218P00100000/close", 200, {
      symbol: "XYZ261218P00100000",
      order_id: "x",
      status: "accepted",
      dry_run: false,
    });
    await dashboard.open();
    await dashboard.row("Positions", "XYZ261218P00100000").getByRole("button", { name: "Close" }).click();
    await dashboard.modal.getByRole("button", { name: "Close XYZ261218P00100000" }).click();
    await expect(dashboard.modal).toHaveCount(0);
    expect(calls).toHaveLength(1);
  });

  test("Cancel sends nothing", async ({ dashboard }) => {
    const calls = await dashboard.mockWrite("**/api/positions/AAPL/close", 200, {});
    await dashboard.open();
    await dashboard.row("Positions", "AAPL").getByRole("button", { name: "Close" }).click();
    await dashboard.modal.getByRole("button", { name: "Cancel" }).click();
    await expect(dashboard.modal).toHaveCount(0);
    expect(calls).toHaveLength(0);
  });

  test("a failure is shown", async ({ page, dashboard }) => {
    await dashboard.mockWrite("**/api/positions/AAPL/close", 404, { detail: "No open position in AAPL." });
    await dashboard.open();
    await dashboard.row("Positions", "AAPL").getByRole("button", { name: "Close" }).click();
    await dashboard.modal.getByRole("button", { name: "Close AAPL" }).click();
    await expect(page.locator(".banner.danger", { hasText: "Action failed" })).toContainText("No open position in AAPL.");
  });
});

test.describe("cancelling an order", () => {
  test("cancels that order", async ({ dashboard }) => {
    const calls = await dashboard.mockWrite("**/api/orders/order-1/cancel", 200, { order_id: "order-1", cancelled: true });
    await dashboard.open();
    await dashboard.row("Open orders", "MSFT").getByRole("button", { name: "Cancel" }).click();
    await expect.poll(() => calls.length).toBe(1);
  });

  test("a failure is shown, and the next action clears it", async ({ page, dashboard }) => {
    await dashboard.mockWrite("**/api/orders/order-1/cancel", 400, { detail: "Already filled" });
    await dashboard.open();
    const button = dashboard.row("Open orders", "MSFT").getByRole("button", { name: "Cancel" });
    await button.click();
    const banner = page.locator(".banner.danger", { hasText: "Action failed" });
    await expect(banner).toContainText("Already filled");

    await page.unroute("**/api/orders/order-1/cancel");
    await dashboard.mockWrite("**/api/orders/order-1/cancel", 200, { order_id: "order-1", cancelled: true });
    await button.click();
    await expect(banner).toHaveCount(0);
  });

  test("KNOWN BUG: the failure is on screen where you clicked", async ({ page, dashboard }) => {
    // Open orders is far down the page and the banner is at the very top, so a
    // failed cancel shows nothing unless you scroll up. Remove test.fail when fixed.
    test.fail();
    await dashboard.mockWrite("**/api/orders/order-1/cancel", 400, { detail: "Already filled" });
    await dashboard.open();
    await dashboard.row("Open orders", "MSFT").getByRole("button", { name: "Cancel" }).click();
    const banner = page.locator(".banner.danger", { hasText: "Action failed" });
    await expect(banner).toBeAttached();
    await expect(banner).toBeInViewport();
  });
});

test.describe("manual order", () => {
  async function openForm(dashboard: Dashboard) {
    await dashboard.open();
    await dashboard.page.getByRole("button", { name: "New manual order" }).click();
    await expect(dashboard.modal.getByRole("heading", { name: "Manual order" })).toBeVisible();
    return {
      submit: dashboard.modal.getByRole("button", { name: "Submit order" }),
      confirm: dashboard.modal.getByRole("checkbox"),
    };
  }

  test("needs a symbol, a quantity and the confirmation tick", async ({ dashboard }) => {
    const { submit, confirm } = await openForm(dashboard);
    await expect(submit).toBeDisabled();
    await dashboard.field("Symbol").fill("AAPL");
    await expect(submit).toBeDisabled();
    await dashboard.field("Qty").fill("2");
    await expect(submit).toBeDisabled();
    await confirm.check();
    await expect(submit).toBeEnabled();
    await confirm.uncheck();
    await expect(submit).toBeDisabled();
  });

  test("sends a market equity order exactly as entered", async ({ dashboard }) => {
    const calls = await dashboard.mockWrite(ORDERS, 200, {
      accepted: true,
      reason: null,
      order_id: "abc",
      status: "accepted",
      dry_run: false,
      risk_check_passed: true,
    });
    const { submit, confirm } = await openForm(dashboard);
    await dashboard.field("Symbol").fill("AAPL");
    await dashboard.field("Side").selectOption("sell");
    await dashboard.field("Qty").fill("2");
    await confirm.check();
    await submit.click();

    await expect(dashboard.modal.locator(".banner")).toContainText("Order accepted");
    await expect(dashboard.modal.locator(".banner")).toContainText("order abc (accepted)");
    expect(calls).toHaveLength(1);
    expect(calls[0].postDataJSON()).toEqual({
      symbol: "AAPL",
      asset_class: "equity",
      side: "sell",
      qty: 2,
      order_type: "market",
      limit_price: null,
      position_intent: null,
      confirm: true,
    });
  });

  test("the limit price appears only for a limit order, and is sent", async ({ dashboard }) => {
    const calls = await dashboard.mockWrite(ORDERS, 200, { accepted: true, order_id: "abc", status: "new", dry_run: false });
    const { submit, confirm } = await openForm(dashboard);
    await expect(dashboard.field("Limit price")).toHaveCount(0);
    await dashboard.field("Order type").selectOption("limit");
    await dashboard.field("Symbol").fill("AAPL");
    await dashboard.field("Qty").fill("1");
    await dashboard.field("Limit price").fill("123.45");
    await confirm.check();
    await submit.click();
    await expect(dashboard.modal.locator(".banner")).toContainText("Order accepted");
    expect(calls[0].postDataJSON()).toMatchObject({ order_type: "limit", limit_price: 123.45 });
  });

  test("an option order asks for its intent and a limit price", async ({ dashboard }) => {
    const calls = await dashboard.mockWrite(ORDERS, 200, { accepted: true, order_id: "abc", status: "new", dry_run: false });
    const { submit, confirm } = await openForm(dashboard);
    await expect(dashboard.field("Position intent")).toHaveCount(0);
    await dashboard.field("Asset class").selectOption("option");
    await expect(dashboard.field("Order type")).toBeDisabled();
    await dashboard.field("Position intent").selectOption("sell_to_open");
    await dashboard.field("Symbol").fill("XYZ261218P00100000");
    await dashboard.field("Qty").fill("1");
    await dashboard.field("Limit price (required for options)").fill("2.5");
    await confirm.check();
    await submit.click();
    await expect(dashboard.modal.locator(".banner")).toContainText("Order accepted");
    expect(calls[0].postDataJSON()).toMatchObject({
      asset_class: "option",
      position_intent: "sell_to_open",
      limit_price: 2.5,
    });
  });

  test("shows a dry run for what it is", async ({ dashboard }) => {
    await dashboard.mockWrite(ORDERS, 200, { accepted: true, order_id: "abc", status: "dry_run", dry_run: true });
    const { submit, confirm } = await openForm(dashboard);
    await dashboard.field("Symbol").fill("AAPL");
    await dashboard.field("Qty").fill("1");
    await confirm.check();
    await submit.click();
    await expect(dashboard.modal.locator(".banner")).toContainText("DRY RUN");
  });

  test("shows why the risk engine refused", async ({ dashboard }) => {
    await dashboard.mockWrite(ORDERS, 200, { accepted: false, reason: "Rejected by RiskEngine.allow_stock_entry", risk_check_passed: false });
    const { submit, confirm } = await openForm(dashboard);
    await dashboard.field("Symbol").fill("AAPL");
    await dashboard.field("Qty").fill("1000000");
    await confirm.check();
    await submit.click();
    const banner = dashboard.modal.locator(".banner.danger");
    await expect(banner).toContainText("Rejected");
    await expect(banner).toContainText("RiskEngine.allow_stock_entry");
  });

  test("KNOWN BUG: a failed submit is shown in the form", async ({ page, dashboard }) => {
    // The error goes to the banner at the top of the page, far above and behind
    // the form, so the click looks like it did nothing. Remove test.fail when fixed.
    test.fail();
    await dashboard.mockWrite(ORDERS, 502, { detail: "Broker down" });
    const { submit, confirm } = await openForm(dashboard);
    await dashboard.field("Symbol").fill("AAPL");
    await dashboard.field("Qty").fill("1");
    await confirm.check();
    await submit.click();
    await expect(page.locator(".banner.danger", { hasText: "Action failed" })).toBeAttached();
    await expect(dashboard.modal).toContainText("Broker down");
  });

  for (const qty of ["0", "-5", "0.5"]) {
    test(`KNOWN BUG: a quantity of ${qty} can't be submitted`, async ({ dashboard }) => {
      // The form only checks that Qty isn't empty. The API has no check either:
      // it casts with int(), so 0.5 becomes 0. Remove test.fail when fixed.
      test.fail();
      const { submit, confirm } = await openForm(dashboard);
      await dashboard.field("Symbol").fill("AAPL");
      await dashboard.field("Qty").fill(qty);
      await confirm.check();
      await expect(submit).toBeDisabled();
    });
  }

  test("Close sends nothing, and the form starts empty next time", async ({ page, dashboard }) => {
    const calls = await dashboard.mockWrite(ORDERS, 200, {});
    await openForm(dashboard);
    await dashboard.field("Symbol").fill("AAPL");
    await dashboard.modal.getByRole("button", { name: "Close" }).click();
    await expect(dashboard.modal).toHaveCount(0);
    expect(calls).toHaveLength(0);
    await page.getByRole("button", { name: "New manual order" }).click();
    await expect(dashboard.field("Symbol")).toHaveValue("");
  });
});
