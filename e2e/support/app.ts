import { expect, test as base, type Locator, type Page, type Request, type WebSocketRoute } from "@playwright/test";
import { ADMIN, TEST_PASSWORD } from "./constants.ts";
import * as data from "./data.ts";

type Json = Record<string, unknown> | unknown[];

export interface OpenOptions {
  /** Messages each new /ws connection receives. Defaults to a full snapshot. */
  messages?: Json[];
  congress?: Json;
  robinhood?: Json;
  watch?: Json;
}

/** Drives one browser page with the broker side faked and sign-in real. */
export class Dashboard {
  sockets: WebSocketRoute[] = [];
  /** Non-GET API calls no test mocked. They are stopped here and fail the test. */
  unexpectedWrites: string[] = [];
  /** Every API call the page made, as "METHOD /path?query". */
  apiCalls: string[] = [];
  pageErrors: string[] = [];
  messages: Json[] = [data.tick, data.strategy, data.logs];

  constructor(readonly page: Page) {
    page.on("pageerror", (error) => this.pageErrors.push(error.message));
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname.startsWith("/api/")) this.apiCalls.push(`${request.method()} ${url.pathname}${url.search}`);
    });
  }

  /** Runs first in every test: nothing can write unless the test allows it. */
  async guardWrites() {
    await this.page.route("**/api/**", (route, request) => {
      const path = new URL(request.url()).pathname;
      if (request.method() === "GET" || path.startsWith("/api/auth/")) return route.fallback();
      this.unexpectedWrites.push(`${request.method()} ${path}`);
      return route.abort();
    });
  }

  /** Replaces /ws and the panel endpoints with made-up data. */
  async mockData(options: OpenOptions = {}) {
    if (options.messages) this.messages = options.messages;
    await this.page.routeWebSocket(/\/ws(\?.*)?$/, (socket) => {
      this.sockets.push(socket);
      for (const message of this.messages) socket.send(JSON.stringify(message));
    });
    await this.mockGet("**/api/congress", options.congress ?? data.congress);
    await this.mockGet("**/api/congress/refresh", data.congressPullIdle);
    await this.mockGet("**/api/robinhood", options.robinhood ?? data.robinhood);
    await this.mockGet("**/api/watch*", options.watch ?? data.watch);
  }

  async mockGet(url: string, body: Json) {
    await this.page.route(url, (route, request) =>
      request.method() === "GET" ? route.fulfill({ json: body }) : route.fallback(),
    );
  }

  /** Answers one write endpoint and records what the page sent. */
  async mockWrite(url: string | RegExp, status: number, body: Json): Promise<Request[]> {
    const seen: Request[] = [];
    await this.page.route(url, (route, request) => {
      if (request.method() === "GET") return route.fallback();
      seen.push(request);
      return route.fulfill({ status, json: body });
    });
    return seen;
  }

  async signIn(username = ADMIN) {
    const response = await this.page.request.post("/api/auth/login", {
      data: { username, password: TEST_PASSWORD },
    });
    expect(response.ok(), `sign-in as ${username}`).toBeTruthy();
  }

  /** Signs in for real, then opens the page with faked market data. */
  async open(username = ADMIN, options: OpenOptions = {}) {
    await this.mockData(options);
    await this.signIn(username);
    await this.page.goto("/");
    await expect(this.topBar).toBeVisible();
  }

  send(message: Json) {
    for (const socket of this.sockets) socket.send(JSON.stringify(message));
  }

  get topBar() {
    return this.page.locator(".topbar");
  }

  get signInHeading() {
    return this.page.getByRole("heading", { name: "Sign in" });
  }

  get modal() {
    return this.page.locator(".modal-backdrop .modal");
  }

  get killSwitchButton() {
    return this.topBar.getByRole("button", { name: "Kill switch" });
  }

  /** The card whose own title holds this text. */
  card(title: string): Locator {
    return this.page.locator(".card-title", { hasText: title }).first().locator("..");
  }

  /** The table row for a symbol inside a card. */
  row(cardTitle: string, symbol: string): Locator {
    return this.card(cardTitle).locator("tr", { hasText: symbol });
  }

  /** A form control by its label; the labels aren't linked with htmlFor. */
  field(label: string): Locator {
    return this.modal.locator(`xpath=.//label[normalize-space(.)="${label}"]/following-sibling::*[1]`);
  }
}

export const test = base.extend<{ dashboard: Dashboard }>({
  dashboard: async ({ page }, use) => {
    const dashboard = new Dashboard(page);
    await dashboard.guardWrites();
    await use(dashboard);
    // Every test, whatever it checks: the page didn't crash and wrote nothing unplanned.
    expect(dashboard.pageErrors, "uncaught errors in the page").toEqual([]);
    expect(dashboard.unexpectedWrites, "API writes no test mocked").toEqual([]);
  },
});

export { expect };
