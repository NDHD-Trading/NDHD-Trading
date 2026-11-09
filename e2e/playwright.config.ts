import { resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { TEST_API_KEY, TEST_PASSWORD, TEST_PORT } from "./support/constants.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const PYTHON =
  process.env.NDHD_E2E_PYTHON ??
  resolve(REPO_ROOT, process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python");
const LIVE_URL = process.env.NDHD_LIVE_URL ?? "http://127.0.0.1:8000";
const liveOnly = process.argv.includes("--project=live");

export default defineConfig({
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  // No retries: a throttling test can't pass twice against one database, and
  // a flaky test should be seen, not hidden.
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  projects: [
    {
      // The isolated copy of the app (serve_test_app.py). Safe to run any time.
      name: "app",
      testDir: "./tests",
      use: {
        ...devices["Desktop Chrome"],
        baseURL: `http://127.0.0.1:${TEST_PORT}`,
        trace: "retain-on-failure",
        screenshot: "only-on-failure",
        // Slows each browser step (ms), to watch a headed run. For a few tests
        // only: timing checks such as the reconnect banner can fail when slowed.
        launchOptions: { slowMo: Number(process.env.NDHD_E2E_SLOWMO ?? 0) },
      },
    },
    {
      // The real running app. Read-only. No traces, screenshots or video, so
      // the API key and account data never land in the test output.
      name: "live",
      testDir: "./live",
      fullyParallel: false,
      use: {
        ...devices["Desktop Chrome"],
        baseURL: LIVE_URL,
        trace: "off",
        screenshot: "off",
        video: "off",
      },
    },
  ],
  webServer: liveOnly
    ? undefined
    : {
        command: `"${PYTHON}" e2e/serve_test_app.py`,
        cwd: REPO_ROOT,
        url: `http://127.0.0.1:${TEST_PORT}/api/health`,
        reuseExistingServer: false,
        timeout: 90_000,
        env: {
          NDHD_E2E_PORT: String(TEST_PORT),
          NDHD_E2E_PASSWORD: TEST_PASSWORD,
          NDHD_E2E_API_KEY: TEST_API_KEY,
        },
      },
});
