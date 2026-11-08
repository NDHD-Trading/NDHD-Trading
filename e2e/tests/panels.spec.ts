// Congress, Robinhood and Watch panels. These load over REST, not /ws.
import { expect, test } from "../support/app.ts";
import { VIEWER } from "../support/constants.ts";
import * as data from "../support/data.ts";

test.describe("congress panel", () => {
  test("shows the tiles and whether the engine would alert", async ({ page, dashboard }) => {
    await dashboard.open();
    const panel = page.locator("#congress");
    await expect(panel.locator(".stat-card", { hasText: "Official rows" })).toContainText("12");
    await expect(panel.locator(".stat-card", { hasText: "Not checked" })).toContainText("3");
    await expect(panel.locator(".congress-symbols tr", { hasText: "AAPL" })).toContainText("Alert");
    await expect(panel).toContainText("Stocks meeting it today: AAPL (Buy).");
    await expect(panel).toContainText("Research and advisory only");
    await expect(dashboard.topBar).toContainText("Congress data: today");
  });

  test("puts a badge on the strategy card for the same symbol", async ({ dashboard }) => {
    await dashboard.open();
    const badge = dashboard.card("Stock strategy").locator(".card", { hasText: "AAPL" }).locator(".congress-badge");
    await expect(badge).toContainText("↑2");
    await expect(badge.locator(".pill", { hasText: "alert" })).toBeVisible();
  });

  test("the research details open, and stay open after a reload", async ({ page, dashboard }) => {
    await dashboard.open();
    const panel = page.locator("#congress");
    await expect(panel.locator(".congress-details")).toHaveCount(0);
    await panel.getByRole("button", { name: /Show research details/ }).click();
    await expect(panel.locator(".congress-details")).toContainText("Test Lawmaker");
    await expect(panel.locator(".congress-details")).toContainText("Party split");
    await page.reload();
    await expect(page.locator("#congress .congress-details")).toBeVisible();
    await page.locator("#congress").getByRole("button", { name: /Hide research details/ }).click();
    await expect(page.locator("#congress .congress-details")).toHaveCount(0);
  });

  test("warns about stale data", async ({ page, dashboard }) => {
    await dashboard.open(undefined, {
      congress: { ...data.congress, status: "stale", stale: true, business_days_old: 6, message: "Six days old." },
    });
    const banner = page.locator("#congress .banner.warning");
    await expect(banner).toContainText("Data is stale");
    await expect(banner).toContainText('Click "Pull latest filings"');
    await expect(dashboard.topBar).toContainText("6 business days old · stale");
  });

  test("a viewer is told an admin can update stale data", async ({ page, dashboard }) => {
    await dashboard.open(VIEWER, {
      congress: { ...data.congress, status: "stale", stale: true, business_days_old: 6, message: "Six days old." },
    });
    await expect(page.locator("#congress .banner.warning")).toContainText("An admin can update it.");
  });

  test("explains when there's no data yet", async ({ page, dashboard }) => {
    await dashboard.open(undefined, {
      congress: { ...data.congress, status: "missing", as_of: null, store: null, message: "No file yet." },
    });
    const panel = page.locator("#congress");
    await expect(panel.locator(".banner.danger")).toContainText("No congress data yet");
    await expect(panel.locator(".congress-tiles")).toHaveCount(0);
    await expect(dashboard.topBar).toContainText("Congress data: no data");
  });

  test("shows a load failure", async ({ page, dashboard }) => {
    await dashboard.mockData();
    await page.route("**/api/congress", (route) => route.fulfill({ status: 500, json: { detail: "Boom" } }));
    await dashboard.signIn();
    await page.goto("/");
    await expect(page.locator("#congress .banner.danger")).toContainText("Could not load /api/congress: Boom");
  });

  test("a pull runs, reports progress and reloads the data", async ({ page, dashboard }) => {
    await dashboard.open();
    const panel = page.locator("#congress");
    // Let the page's first status check finish, or it could read the "running"
    // answer set up below and never show the idle button this test clicks.
    await expect(panel.getByRole("button", { name: "Pull latest filings" })).toBeEnabled();
    await expect.poll(() => dashboard.apiCalls).toContain("GET /api/congress/refresh");
    await expect(panel.locator(".stat-card", { hasText: "Official rows" })).toContainText("12");

    let finished = false;
    const pulls = await dashboard.mockWrite("**/api/congress/refresh", 202, {
      ...data.congressPullIdle,
      state: "running",
      message: "Downloading filings…",
    });
    await page.route("**/api/congress/refresh", (route, request) => {
      if (request.method() !== "GET") return route.fallback();
      const state = finished ? "done" : "running";
      const message = finished ? "Pulled 4 new filings." : "Downloading filings…";
      return route.fulfill({ json: { ...data.congressPullIdle, state, message } });
    });
    await page.route("**/api/congress", (route) =>
      route.fulfill({ json: finished ? { ...data.congress, counts: { verified: 99, unverified: 3 } } : data.congress }),
    );

    await panel.getByRole("button", { name: "Pull latest filings" }).click();
    await expect(panel.getByRole("button", { name: "Pulling…" })).toBeDisabled();
    await expect(panel).toContainText("Downloading filings…");
    expect(pulls).toHaveLength(1);

    finished = true;
    await expect(panel).toContainText("✓ Pulled 4 new filings.", { timeout: 10_000 });
    await expect(panel.locator(".stat-card", { hasText: "Official rows" })).toContainText("99");
    await expect(panel.getByRole("button", { name: "Pull latest filings" })).toBeEnabled();
  });
});

test.describe("robinhood panel", () => {
  test("shows totals, holdings and says it's read-only", async ({ page, dashboard }) => {
    await dashboard.open();
    const panel = page.locator("#robinhood");
    await expect(panel).toContainText("Read-only: nothing here can trade");
    await expect(panel.locator(".stat-card", { hasText: "All accounts" })).toContainText("$3,200.00");
    await expect(panel.locator("tr", { hasText: "AAPL" })).toContainText("$1,600.00");
    await expect(panel).toContainText("Sample suggestion");
    await expect(panel.locator(".meter", { hasText: "Largest position" })).toContainText("50%");
    await expect(panel.locator(".meter", { hasText: "Largest position" }).locator(".meter-fill.danger")).toBeVisible();
  });

  test("has no way to place an order", async ({ page, dashboard }) => {
    await dashboard.open();
    const panel = page.locator("#robinhood");
    await expect(panel.getByRole("button", { name: /Show crypto/ })).toBeVisible();
    const buttons = await panel.getByRole("button").allInnerTexts();
    expect(buttons.map((text) => text.replace(/\s*\(\d+\).*$/, ""))).toEqual(["Reload", "Show crypto"]);
  });

  test("crypto stays hidden until asked for", async ({ page, dashboard }) => {
    await dashboard.open();
    const panel = page.locator("#robinhood");
    await expect(panel).not.toContainText("SAMPLECOIN");
    await panel.getByRole("button", { name: "Show crypto (1)" }).click();
    await expect(panel).toContainText("SAMPLECOIN");
    await panel.getByRole("button", { name: "Hide crypto (1)" }).click();
    await expect(panel).not.toContainText("SAMPLECOIN");
  });

  test("warns about an old snapshot", async ({ page, dashboard }) => {
    await dashboard.open(undefined, { robinhood: { ...data.robinhood, stale: true, age_days: 9 } });
    await expect(page.locator("#robinhood .banner.warning")).toContainText("Snapshot is stale");
    await expect(page.locator("#robinhood .banner.warning")).toContainText("It is 9 days old.");
  });

  test("explains a missing snapshot, and Reload picks up a new one", async ({ page, dashboard }) => {
    await dashboard.open(undefined, { robinhood: { ...data.robinhood, status: "missing", message: "No snapshot yet." } });
    const panel = page.locator("#robinhood");
    await expect(panel.locator(".banner.warning")).toContainText("No snapshot yet.");
    await dashboard.mockGet("**/api/robinhood", data.robinhood);
    await panel.getByRole("button", { name: "Reload" }).click();
    await expect(panel.locator(".stat-card", { hasText: "All accounts" })).toContainText("$3,200.00");
  });
});

test.describe("watch panel", () => {
  test("shows signals and says the engine never trades them", async ({ page, dashboard }) => {
    await dashboard.open();
    const panel = page.locator("#watch");
    await expect(panel).toContainText("The engine never trades these");
    const row = panel.locator("tr", { hasText: "TSLA" });
    await expect(row).toContainText("$250.00");
    await expect(row).toContainText("uptrend");
    await expect(row).toContainText("crossed today");
    await expect(row).toContainText("buy signal today");
  });

  test("shows a row's own error without losing the others", async ({ page, dashboard }) => {
    await dashboard.open();
    await expect(page.locator("#watch tr", { hasText: "BAD" })).toContainText("No signals: no bars");
    await expect(page.locator("#watch tr", { hasText: "TSLA" })).toBeVisible();
  });

  test("the first load uses the cache; Refresh asks for fresh numbers", async ({ page, dashboard }) => {
    await dashboard.open();
    await expect(page.locator("#watch tr", { hasText: "TSLA" })).toBeVisible();
    expect(dashboard.apiCalls).toContain("GET /api/watch");
    expect(dashboard.apiCalls).not.toContain("GET /api/watch?refresh=true");
    await page.locator("#watch").getByRole("button", { name: "Refresh" }).click();
    await expect.poll(() => dashboard.apiCalls).toContain("GET /api/watch?refresh=true");
  });

  test("shows the note when nothing is on the list", async ({ page, dashboard }) => {
    await dashboard.open(undefined, { watch: { ...data.watch, tickers: [], rows: [], note: "WATCH_TICKERS is empty in .env." } });
    await expect(page.locator("#watch .empty-row")).toHaveText("WATCH_TICKERS is empty in .env.");
  });

  test("shows a load failure", async ({ page, dashboard }) => {
    await dashboard.mockData();
    await page.route("**/api/watch*", (route) => route.fulfill({ status: 503, json: { detail: "Quotes down" } }));
    await dashboard.signIn();
    await page.goto("/");
    await expect(page.locator("#watch .banner.danger")).toContainText("Could not load /api/watch: Quotes down");
  });
});
