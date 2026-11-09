// What each role can see in the page, and what the real API allows.
import { expect, test } from "../support/app.ts";
import { ADMIN, TEST_API_KEY, TEST_PASSWORD, VIEWER } from "../support/constants.ts";

test.describe("page sections by role", () => {
  test("an admin sees every section and every control", async ({ page, dashboard }) => {
    await dashboard.open(ADMIN);
    for (const title of [
      "Live engine console",
      "Risk & positions",
      "Strategies",
      "Congress trades (research · advisory only)",
      "Robinhood (your accounts · read-only)",
      "Watch list (signals only · never traded)",
      "Orders & activity",
      "Manual control",
    ]) {
      await expect(page.locator(".section-title", { hasText: title })).toBeVisible();
    }
    await expect(dashboard.killSwitchButton).toBeVisible();
    await expect(dashboard.row("Positions", "AAPL").getByRole("button", { name: "Close" })).toBeVisible();
    await expect(dashboard.row("Open orders", "MSFT").getByRole("button", { name: "Cancel" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Pull latest filings" })).toBeVisible();
  });

  test("a viewer sees the data but no personal data and no controls", async ({ page, dashboard }) => {
    await dashboard.open(VIEWER);
    await expect(dashboard.topBar).toContainText(`${VIEWER} · viewer`);
    await expect(page.getByText("Portfolio equity")).toBeVisible();
    await expect(dashboard.row("Positions", "AAPL")).toBeVisible();
    await expect(page.locator(".section-title", { hasText: "Strategies" })).toBeVisible();

    await expect(page.locator(".section-title", { hasText: "Robinhood" })).toHaveCount(0);
    await expect(page.locator(".section-title", { hasText: "Manual control" })).toHaveCount(0);
    await expect(dashboard.killSwitchButton).toHaveCount(0);
    await expect(dashboard.row("Positions", "AAPL").getByRole("button", { name: "Close" })).toHaveCount(0);
    await expect(dashboard.row("Open orders", "MSFT").getByRole("button", { name: "Cancel" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Pull latest filings" })).toHaveCount(0);
    await expect(page.getByText("Only an admin can pull new filings.")).toBeVisible();
  });

  test("a viewer's page never asks for the Robinhood data", async ({ page, dashboard }) => {
    await dashboard.open(VIEWER);
    await expect(page.getByText("Portfolio equity")).toBeVisible();
    await expect(page.locator("#watch")).toBeVisible();
    expect(dashboard.apiCalls.filter((call) => call.includes("/api/robinhood"))).toEqual([]);
  });

  test("signing out leaves nothing of the last user's data on the page", async ({ page, dashboard }) => {
    await dashboard.open(ADMIN);
    await expect(page.getByText("$101,000.00").first()).toBeVisible();
    await dashboard.topBar.getByRole("button", { name: "Sign out" }).click();
    await expect(dashboard.signInHeading).toBeVisible();
    await expect(page.locator("body")).not.toContainText("$101,000.00");
    await expect(page.locator("body")).not.toContainText("AAPL");
  });
});

test.describe("access changing while the page is open", () => {
  test("when the server ends the sign-in, the page returns to the sign-in screen", async ({ page, dashboard }) => {
    await dashboard.open(VIEWER);
    await page.request.post("/api/auth/logout");
    dashboard.sockets[0].close({ code: 4401, reason: "signed out" });
    await expect(dashboard.signInHeading).toBeVisible();
    await expect(page.locator("body")).not.toContainText("AAPL");
  });

  test("when the role loses a section, that section disappears", async ({ page, dashboard }) => {
    await dashboard.open(VIEWER);
    await expect(page.locator(".section-title", { hasText: "Strategies" })).toBeVisible();
    await page.route("**/api/auth/me", (route) =>
      route.fulfill({
        json: { signed_in: true, users_enabled: true, username: VIEWER, role: "viewer", sections: ["account"], via: "session" },
      }),
    );
    dashboard.sockets[0].close({ code: 4403, reason: "role changed" });
    await expect(page.locator(".section-title", { hasText: "Strategies" })).toHaveCount(0);
    await expect(page.getByText("Portfolio equity")).toBeVisible();
  });
});

test.describe("what the API enforces", () => {
  const signedOutRoutes = [
    "/api/account",
    "/api/positions",
    "/api/orders",
    "/api/risk",
    "/api/alerts",
    "/api/congress",
    "/api/watch",
    "/api/robinhood",
    "/api/config",
  ];
  const writes: [string, string][] = [
    ["post", "/api/kill-switch"],
    ["post", "/api/orders"],
    ["post", "/api/positions/AAPL/close"],
    ["post", "/api/orders/order-1/cancel"],
    ["patch", "/api/config"],
    ["post", "/api/congress/refresh"],
  ];
  const body = { symbol: "AAPL", asset_class: "equity", side: "buy", qty: 1, confirm: true, values: {} };

  test("signed out, everything is refused", async ({ request }) => {
    for (const path of signedOutRoutes) {
      expect((await request.get(path)).status(), `GET ${path}`).toBe(401);
    }
    for (const [method, path] of writes.filter(([, p]) => p !== "/api/congress/refresh" && p !== "/api/config")) {
      expect((await request[method as "post"](path, { data: body })).status(), `${method} ${path}`).toBe(401);
    }
  });

  test("a viewer can't reach controls or Robinhood", async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL });
    const api = context.request;
    await api.post("/api/auth/login", { data: { username: VIEWER, password: TEST_PASSWORD } });
    expect((await api.get("/api/robinhood")).status()).toBe(403);
    expect((await api.get("/api/congress")).status()).toBe(200);
    for (const [method, path] of writes.filter(([, p]) => p !== "/api/congress/refresh" && p !== "/api/config")) {
      expect((await api[method as "post"](path, { data: body })).status(), `${method} ${path}`).toBe(403);
    }
    await context.close();
  });

  test("a wrong API key is refused", async ({ request }) => {
    const response = await request.get("/api/account", { headers: { "X-API-Key": "wrong-key" } });
    expect(response.status()).toBe(401);
  });

  test("a signed-out live connection is closed with the sign-out code", async ({ page }) => {
    await page.goto("/");
    const code = await page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          const socket = new WebSocket(`ws://${location.host}/ws`);
          socket.onclose = (event) => resolve(event.code);
        }),
    );
    expect(code).toBe(4401);
  });
});

test.describe("when the broker can't be reached", () => {
  // This server has no broker, which looks just like an Alpaca outage to the page.
  test("the live connection stays up and reports the problem", async ({ page, dashboard }) => {
    await dashboard.signIn();
    await page.goto("/");
    await expect(page.locator("footer")).toContainText("Last error:", { timeout: 15_000 });
    await expect(dashboard.topBar).toContainText("Live");
    await expect(page.locator(".banner.reconnect", { hasText: "Live updates paused." })).toHaveCount(0);
  });

  test("the panels that don't need the broker still load", async ({ page, dashboard }) => {
    await dashboard.signIn();
    await page.goto("/");
    await expect(page.locator("#congress")).toContainText("No congress data yet");
    await expect(page.locator("#robinhood .banner.warning")).toBeVisible();
    await expect(page.locator("#watch .empty-row")).toHaveText("WATCH_TICKERS is empty in .env.");
  });
});

test.describe("the test server is cut off from the broker", () => {
  // If one of these ever fails, stop: the isolation in serve_test_app.py is broken.
  test("health says paper, no live trading, no Alpaca credentials", async ({ request }) => {
    const health = await (await request.get("/api/health")).json();
    expect(health).toMatchObject({ paper: true, live_trading: false, alpaca_credentials_configured: false });
  });

  test("even the admin key can't place an order or fire the kill switch", async ({ request }) => {
    const headers = { "X-API-Key": TEST_API_KEY };
    const order = { symbol: "AAPL", asset_class: "equity", side: "buy", qty: 1, confirm: true };
    expect((await request.post("/api/orders", { headers, data: order })).status()).toBe(503);
    expect((await request.post("/api/kill-switch", { headers })).status()).toBe(503);
    expect((await request.post("/api/positions/AAPL/close", { headers })).status()).toBe(503);
  });

  test("the API refuses a bad manual order before it needs a broker", async ({ request }) => {
    const headers = { "X-API-Key": TEST_API_KEY };
    const order = { symbol: "AAPL", asset_class: "equity", side: "buy", qty: 1, confirm: true };
    const cases: [object, string][] = [
      [{ qty: 0 }, "qty must be a whole number"],
      [{ qty: -5 }, "qty must be a whole number"],
      [{ qty: 0.5 }, "qty must be a whole number"],
      [{ order_type: "stop" }, "order_type must be"],
      [{ order_type: "limit" }, "limit_price is required"],
      [{ order_type: "limit", limit_price: -1 }, "limit_price must be above 0"],
      [{ symbol: "   " }, "symbol is required"],
    ];
    for (const [change, reason] of cases) {
      const body = await (await request.post("/api/orders", { headers, data: { ...order, ...change } })).json();
      expect(body.accepted, JSON.stringify(change)).toBe(false);
      expect(body.reason, JSON.stringify(change)).toContain(reason);
    }
  });

  test("the steps that would change real files are switched off", async ({ request }) => {
    const headers = { "X-API-Key": TEST_API_KEY };
    expect((await request.post("/api/congress/refresh", { headers })).status()).toBe(418);
    expect((await request.patch("/api/config", { headers, data: { values: {} } })).status()).toBe(418);
  });

  test("the personal snapshot isn't visible to the test server", async ({ request }) => {
    const view = await (await request.get("/api/robinhood", { headers: { "X-API-Key": TEST_API_KEY } })).json();
    expect(view.status).toBe("missing");
    expect(view.accounts).toEqual([]);
  });
});
