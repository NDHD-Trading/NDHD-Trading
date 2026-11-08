// Read-only checks of the REAL running app (http://127.0.0.1:8000 by default).
//
// These use the API key from .env, so every non-GET request is stopped in the
// browser before it leaves, and no button that changes anything is clicked.
// The live project records no traces, screenshots or video (playwright.config.ts).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test as base, type Page } from "@playwright/test";

function apiKeyFromEnvFile(): string | null {
  try {
    const text = readFileSync(resolve(import.meta.dirname, "..", "..", ".env"), "utf-8");
    const match = text.match(/^\s*DASHBOARD_API_KEY\s*=\s*["']?([^"'\r\n]+)["']?\s*$/m);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

const test = base.extend<{ blockedWrites: string[] }>({
  // auto: on for every test here, whether or not the test asks for it.
  blockedWrites: [
    async ({ page }, use) => {
      const blocked: string[] = [];
      await page.route("**/*", (route, request) => {
        if (request.method() === "GET" || request.method() === "HEAD") return route.fallback();
        blocked.push(`${request.method()} ${new URL(request.url()).pathname}`);
        return route.abort();
      });
      await use(blocked);
      expect(blocked, "the page tried to write to the real app").toEqual([]);
    },
    { auto: true },
  ],
});

async function enterKey(page: Page, key: string) {
  await page.goto("/");
  await page.getByRole("button", { name: "Use API key" }).click();
  await page.locator(".modal-backdrop").getByPlaceholder("only if DASHBOARD_API_KEY is set").fill(key);
  await page.locator(".modal-backdrop").getByRole("button", { name: "Save" }).click();
  await expect(page.locator(".topbar")).toContainText("API key · admin");
}

test.describe("signed out", () => {
  test("the app is up, in paper mode, with live trading off", async ({ request }) => {
    const response = await request.get("/api/health");
    expect(response.ok()).toBeTruthy();
    expect(await response.json()).toMatchObject({
      ok: true,
      paper: true,
      live_trading: false,
      alpaca_credentials_configured: true,
      authenticated_api: true,
      users_enabled: true,
    });
  });

  test("the page shows the sign-in form and no data", async ({ page, blockedWrites }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await expect(page.locator(".topbar")).toHaveCount(0);
    expect(blockedWrites).toEqual([]);
  });

  test("every data route refuses", async ({ request }) => {
    for (const path of ["/api/account", "/api/positions", "/api/orders", "/api/robinhood", "/api/congress", "/api/config"]) {
      expect((await request.get(path)).status(), path).toBe(401);
    }
  });

  // Deliberately no POST here, not even a signed-out one. If sign-in were ever
  // misconfigured, a test of "the kill switch refuses" would fire the kill
  // switch. tests/roles.spec.ts checks the control routes on the test server.
});

test.describe("with the API key", () => {
  const key = apiKeyFromEnvFile();
  test.skip(!key, "DASHBOARD_API_KEY isn't in .env");

  test("the dashboard loads real data with no page errors", async ({ page, blockedWrites }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await enterKey(page, key!);

    const topBar = page.locator(".topbar");
    await expect(topBar).toContainText("Live", { timeout: 30_000 });
    await expect(topBar.locator(".badge.paper")).toContainText("PAPER", { timeout: 30_000 });
    await expect(topBar.locator(".badge.live")).toHaveCount(0);

    await expect(page.locator(".hero-equity .value")).toHaveText(/^\$[\d,]+\.\d{2}$/, { timeout: 30_000 });
    await expect(page.locator(".card-title", { hasText: "Positions" })).toBeVisible();
    await expect(page.locator(".card-title", { hasText: "Open orders" })).toBeVisible();
    await expect(page.locator(".card-title", { hasText: "Risk & guardrails" })).toBeVisible({ timeout: 60_000 });
    await expect(page.locator(".card-title", { hasText: "Stock strategy" })).toBeVisible();
    await expect(page.locator(".card-title", { hasText: "Wheel strategy" })).toBeVisible();
    await expect(page.locator(".console-line").first()).toBeAttached({ timeout: 30_000 });
    await expect(page.locator("#congress")).toBeVisible();
    await expect(page.locator("#robinhood")).toBeVisible();
    await expect(page.locator("#watch")).toBeVisible();

    await expect(page.locator(".banner.danger", { hasText: "Action failed" })).toHaveCount(0);
    expect(errors).toEqual([]);
    expect(blockedWrites).toEqual([]);
  });

  test("the kill switch opens locked, and is closed without firing", async ({ page, blockedWrites }) => {
    await enterKey(page, key!);
    await page.locator(".topbar").getByRole("button", { name: "Kill switch" }).click();
    const modal = page.locator(".modal-backdrop .modal");
    await expect(modal.getByRole("button", { name: "Flatten everything" })).toBeDisabled();
    await modal.getByRole("button", { name: "Cancel" }).click();
    await expect(modal).toHaveCount(0);
    expect(blockedWrites).toEqual([]);
  });

  test("the key isn't saved in the browser for good", async ({ page }) => {
    await enterKey(page, key!);
    const saved = await page.evaluate(() => JSON.stringify(window.localStorage));
    expect(saved.includes(key!)).toBe(false);
  });
});
