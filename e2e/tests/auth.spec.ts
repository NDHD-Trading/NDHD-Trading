// Sign-in against the real API and a real (temporary) users database.
import { expect, test } from "../support/app.ts";
import { ADMIN, DISABLED, TEST_API_KEY, TEST_PASSWORD, THROTTLED, VIEWER } from "../support/constants.ts";

const username = (page: import("@playwright/test").Page) => page.getByLabel("Username");
const password = (page: import("@playwright/test").Page) => page.getByLabel("Password");
const submit = (page: import("@playwright/test").Page) => page.getByRole("button", { name: "Sign in" });

async function signInByForm(page: import("@playwright/test").Page, user: string, pass: string) {
  await username(page).fill(user);
  await password(page).fill(pass);
  await submit(page).click();
}

test.describe("sign-in form", () => {
  test("a signed-out visitor sees only the sign-in form", async ({ page, dashboard }) => {
    await page.goto("/");
    await expect(dashboard.signInHeading).toBeVisible();
    await expect(dashboard.topBar).toHaveCount(0);
    await expect(page.getByText("Portfolio equity")).toHaveCount(0);
    await expect(page).toHaveTitle("NDHD Trading Dashboard");
  });

  test("the button stays off until both fields are filled", async ({ page, dashboard }) => {
    await page.goto("/");
    await expect(dashboard.signInHeading).toBeVisible();
    await expect(submit(page)).toBeDisabled();
    await username(page).fill("someone");
    await expect(submit(page)).toBeDisabled();
    await password(page).fill("something");
    await expect(submit(page)).toBeEnabled();
    await username(page).fill("   ");
    await expect(submit(page)).toBeDisabled();
  });

  test("a wrong password shows an error and clears the password", async ({ page }) => {
    await page.goto("/");
    await signInByForm(page, ADMIN, "wrong-password-here");
    await expect(page.getByText("Wrong username or password.")).toBeVisible();
    await expect(password(page)).toHaveValue("");
    await expect(username(page)).toHaveValue(ADMIN);
  });

  test("unknown and disabled users get the same message as a wrong password", async ({ page }) => {
    await page.goto("/");
    await signInByForm(page, `nobody-${test.info().testId}`, TEST_PASSWORD);
    await expect(page.getByText("Wrong username or password.")).toBeVisible();
    await signInByForm(page, DISABLED, TEST_PASSWORD);
    await expect(page.getByText("Wrong username or password.")).toBeVisible();
    await expect(page.locator(".topbar")).toHaveCount(0);
  });

  test("repeated failures lock the username, even for the right password", async ({ page, request }) => {
    for (let i = 0; i < 5; i++) {
      const response = await request.post("/api/auth/login", { data: { username: THROTTLED, password: "wrong-password-here" } });
      expect(response.status()).toBe(401);
    }
    await page.goto("/");
    await signInByForm(page, THROTTLED, TEST_PASSWORD);
    await expect(page.getByText("Too many failed sign-ins. Try again in 15 minutes.")).toBeVisible();
  });

  test("the username is trimmed", async ({ page, dashboard }) => {
    await page.goto("/");
    await signInByForm(page, `  ${VIEWER}  `, TEST_PASSWORD);
    await expect(dashboard.topBar).toContainText(`${VIEWER} · viewer`);
  });
});

test.describe("session", () => {
  test("an admin signs in and sees their name, role and the kill switch", async ({ page, dashboard }) => {
    await page.goto("/");
    await signInByForm(page, ADMIN, TEST_PASSWORD);
    await expect(dashboard.topBar).toContainText(`${ADMIN} · admin`);
    await expect(dashboard.killSwitchButton).toBeVisible();
  });

  test("the session cookie is hidden from page scripts", async ({ page, context, dashboard }) => {
    await dashboard.signIn();
    const cookie = (await context.cookies()).find((c) => c.name === "ndhd_session");
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe("Strict");
    await page.goto("/");
    expect(await page.evaluate(() => document.cookie)).not.toContain("ndhd_session");
  });

  test("a reload keeps the session", async ({ page, dashboard }) => {
    await dashboard.signIn();
    await page.goto("/");
    await expect(dashboard.topBar).toContainText(ADMIN);
    await page.reload();
    await expect(dashboard.topBar).toContainText(ADMIN);
  });

  test("sign-out ends the session on the server too", async ({ page, context, dashboard, playwright, baseURL }) => {
    await dashboard.signIn();
    const token = (await context.cookies()).find((c) => c.name === "ndhd_session")?.value;
    await page.goto("/");
    await dashboard.topBar.getByRole("button", { name: "Sign out" }).click();
    await expect(dashboard.signInHeading).toBeVisible();
    await page.reload();
    await expect(dashboard.signInHeading).toBeVisible();

    // A copy of the old cookie must be worthless now.
    const stolen = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { Cookie: `ndhd_session=${token}` } });
    const me = await (await stolen.get("/api/auth/me")).json();
    expect(me.signed_in).toBe(false);
    await stolen.dispose();
  });

  test("a made-up session cookie is refused", async ({ page, context, dashboard, baseURL }) => {
    await context.addCookies([{ name: "ndhd_session", value: "made-up-token", url: baseURL! }]);
    await page.goto("/");
    await expect(dashboard.signInHeading).toBeVisible();
  });
});

test.describe("API key", () => {
  async function enterKey(page: import("@playwright/test").Page, key: string) {
    await page.getByRole("button", { name: "Use API key" }).click();
    await page.locator(".modal-backdrop").getByPlaceholder("only if DASHBOARD_API_KEY is set").fill(key);
    await page.locator(".modal-backdrop").getByRole("button", { name: "Save" }).click();
  }

  test("the right key gives admin access; a wrong one doesn't", async ({ page, dashboard }) => {
    await page.goto("/");
    await enterKey(page, "wrong-key");
    await expect(dashboard.signInHeading).toBeVisible();
    await enterKey(page, TEST_API_KEY);
    await expect(dashboard.topBar).toContainText("API key · admin");
    await expect(dashboard.killSwitchButton).toBeVisible();
  });

  test("the key stays in this tab only and is never saved for good", async ({ page, context, dashboard }) => {
    await page.goto("/");
    await enterKey(page, TEST_API_KEY);
    await expect(dashboard.topBar).toContainText("API key · admin");

    const saved = await page.evaluate(() => JSON.stringify(window.localStorage));
    expect(saved).not.toContain(TEST_API_KEY);

    const secondTab = await context.newPage();
    await secondTab.goto("/");
    await expect(secondTab.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await secondTab.close();
  });

  test("Forget key returns to the sign-in screen", async ({ page, dashboard }) => {
    await page.goto("/");
    await enterKey(page, TEST_API_KEY);
    await dashboard.topBar.getByRole("button", { name: "Forget key" }).click();
    await expect(dashboard.signInHeading).toBeVisible();
    await page.reload();
    await expect(dashboard.signInHeading).toBeVisible();
    expect(await page.evaluate(() => window.sessionStorage.getItem("ndhd_dashboard_api_key"))).toBeNull();
  });

  test("a key saved by an old version of the page is erased and not used", async ({ page, dashboard }) => {
    await page.goto("/");
    await page.evaluate((key) => {
      window.localStorage.setItem("ndhd_dashboard_settings_v1", JSON.stringify({ apiBase: "", apiKey: key }));
    }, TEST_API_KEY);
    await page.reload();
    await expect(dashboard.signInHeading).toBeVisible();
    const saved = await page.evaluate(() => window.localStorage.getItem("ndhd_dashboard_settings_v1"));
    expect(saved).not.toContain(TEST_API_KEY);
  });

  test("Cancel in Settings discards what was typed", async ({ page, dashboard }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Use API key" }).click();
    await page.locator(".modal-backdrop").getByPlaceholder("only if DASHBOARD_API_KEY is set").fill(TEST_API_KEY);
    await page.locator(".modal-backdrop").getByRole("button", { name: "Cancel" }).click();
    await expect(dashboard.modal).toHaveCount(0);
    await expect(dashboard.signInHeading).toBeVisible();
    expect(await page.evaluate(() => window.sessionStorage.getItem("ndhd_dashboard_api_key"))).toBeNull();
  });
});
