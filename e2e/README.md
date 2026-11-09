# Browser tests (Playwright)

Two suites, kept apart on purpose.

| Command | Runs against | Changes anything real? |
| --- | --- | --- |
| `npm test` | A throwaway copy of the app on port 8765, started and stopped for you | No |
| `npm run test:live` | The real running app on port 8000 | No: GET requests only |

## Set up once

From this folder, with Node 24 or newer (the repo's copy is in `.tools\node`):

```powershell
npm ci --ignore-scripts
npx playwright install chromium
```

The dashboard page must be built (`web\dist`, see `web/README.md`), and the page
loads React from esm.sh, so the tests need internet access.

## Run

```powershell
npm test               # the isolated suite
npm run test:headed    # the same, with the browser visible
npm run test:live      # read-only checks of the real app; start it first
npm run report         # open the last HTML report
```

## Why the isolated suite is safe

`serve_test_app.py` runs the real API code and real sign-in, with nothing real
behind them:

- **No broker.** Alpaca credentials are blank, so every route that needs a broker
  answers 503. `roles.spec.ts` checks this with the admin key on every run. If
  those checks ever fail, stop and find out why.
- **Its own files.** Users are in a new SQLite file. State, logs, events and the
  Congress and Robinhood files all point at the empty `.tmp-run` folder.
- **Two more routes switched off.** The Congress pull and `PATCH /api/config` work
  without a broker and change real files, so the test server refuses them.
- **Writes stopped in the browser.** A test fails if the page sends a write it
  didn't expect (`support/app.ts`).

Market data on the page is made up (`support/data.ts`). It comes from a mocked
`/ws`, so tests can send exactly the case they want, such as a halt or a new alert.

## Why the live suite is safe

It uses `DASHBOARD_API_KEY` from `.env`, which is full admin, so:

- it blocks every request except GET and HEAD in the browser, on every test;
- it never sends a POST on its own, not even a signed-out one to check for a 401,
  because if sign-in were misconfigured that test would fire the kill switch;
- it records no traces, screenshots or video.

If a live test fails, Playwright still writes a text snapshot of the page to
`test-results/`. That folder and `playwright-report/` are git-ignored; don't share them.

## Known bugs

There are none at the moment. To record one, name the test `KNOWN BUG: ...`, have
it describe the correct behaviour, and mark it `test.fail()`. It then counts as
passing until the bug is fixed, when it reports "expected to fail but passed":
remove the `test.fail()` line and it becomes a normal regression test.
