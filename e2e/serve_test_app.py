"""A throwaway copy of the dashboard for the Playwright tests.

The real API code, real sign-in and real page, but nothing real behind them:

- Alpaca credentials are blank, so the API cannot build a broker client. Every
  route that needs one answers 503. No order can leave this process.
- Users live in a new SQLite file, migrated with the real Alembic migration.
- The state, log, events, status, Congress and Robinhood files all point at an
  empty folder, so the running engine's files and the personal snapshot are
  neither read nor written.

python-dotenv never overrides a variable that is already set, including one set
to "", so the values below win over the repository's .env.

Started by playwright.config.ts. Run from the repository root.
"""
from __future__ import annotations

import logging
import os
import shutil
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
RUN_DIR = Path(__file__).resolve().parent / ".tmp-run"
PORT = int(os.environ["NDHD_E2E_PORT"])
PASSWORD = os.environ["NDHD_E2E_PASSWORD"]
API_KEY = os.environ["NDHD_E2E_API_KEY"]

shutil.rmtree(RUN_DIR, ignore_errors=True)
RUN_DIR.mkdir(parents=True)

DB_FILE = RUN_DIR / "users.db"
os.environ.update({
    "ALPACA_API_KEY": "",
    "ALPACA_SECRET_KEY": "",
    "ALPACA_PAPER": "true",
    "LIVE_TRADING": "false",
    "PAPER_ORDERS": "false",
    "ALERTS_ENABLED": "false",
    "SMTP_HOST": "",
    "SMTP_USER": "",
    "SMTP_PASSWORD": "",
    "DATABASE_URL": f"sqlite:///{DB_FILE.as_posix()}",
    "DASHBOARD_API_KEY": API_KEY,
    "STATE_FILE": str(RUN_DIR / "state.json"),
    "EVENTS_FILE": str(RUN_DIR / "events.jsonl"),
    "LOG_FILE": str(RUN_DIR / "engine.log"),
    "LOCK_FILE": str(RUN_DIR / "engine.lock"),
    "ENGINE_STATUS_FILE": str(RUN_DIR / "engine_status.json"),
    "CONGRESS_DATA_FILE": str(RUN_DIR / "congress_trades.json"),
    "CONGRESS_AGGREGATOR_CSV": str(RUN_DIR / "no-aggregator.csv"),
    "ROBINHOOD_SNAPSHOT_FILE": str(RUN_DIR / "robinhood_snapshot.json"),
    "WATCH_TICKERS": "",
    # Tests that revoke access shouldn't wait the usual 15 seconds.
    "WS_AUTH_RECHECK_SECONDS": "1",
})

sys.path.insert(0, str(REPO_ROOT))

import uvicorn  # noqa: E402
from alembic import command  # noqa: E402
from alembic.config import Config  # noqa: E402
from fastapi.responses import JSONResponse  # noqa: E402
from sqlalchemy import create_engine, select  # noqa: E402

from api import deps  # noqa: E402
from api.main import app  # noqa: E402
from ndhd import auth, db  # noqa: E402


def refuse_unless_isolated() -> None:
    """Stop rather than serve if anything above didn't take effect."""
    cfg = deps.engine.CONFIG
    problems = []
    if os.getenv("ALPACA_API_KEY") or os.getenv("ALPACA_SECRET_KEY"):
        problems.append("Alpaca credentials are set")
    if cfg.live_trading or not cfg.paper:
        problems.append("not in paper mode")
    if not (db.database_url() or "").startswith("sqlite:"):
        problems.append("DATABASE_URL is not the test SQLite file")
    for name in ("state_file", "events_file", "log_file", "status_file", "congress_data_file"):
        if RUN_DIR not in Path(getattr(cfg, name)).resolve().parents:
            problems.append(f"{name} is outside the test folder")
    if problems:
        raise SystemExit("Refusing to start the test server: " + "; ".join(problems))


def create_database() -> None:
    engine = create_engine(os.environ["DATABASE_URL"])
    cfg = Config()  # no ini file: keeps Alembic's logging setup out of the run
    cfg.set_main_option("script_location", str(REPO_ROOT / "migrations"))
    with engine.begin() as conn:
        cfg.attributes["connection"] = conn
        command.upgrade(cfg, "head")
    db.configure(engine=engine)

    password_hash = auth.hash_password(PASSWORD)
    users = (
        ("e2e-admin", db.ADMIN_ROLE, True),
        ("e2e-viewer", db.VIEWER_ROLE, True),
        ("e2e-disabled", db.VIEWER_ROLE, False),
        ("e2e-throttled", db.VIEWER_ROLE, True),
    )
    with db.session() as s:
        for username, role, active in users:
            s.add(db.User(username=username, password_hash=password_hash, is_active=active,
                          role=s.scalar(select(db.Role).where(db.Role.name == role))))
        s.commit()


# These two work without a broker and change real things: one downloads House
# filings into data/, the other rewrites .env. The tests never mean to reach
# them here, so they are switched off rather than trusted to stay unused.
BLOCKED = {("POST", "/api/congress/refresh"), ("PATCH", "/api/config")}


@app.middleware("http")
async def block_real_side_effects(request, call_next):
    if (request.method, request.url.path) in BLOCKED:
        return JSONResponse({"detail": "Blocked on the test server."}, status_code=418)
    return await call_next(request)


if __name__ == "__main__":
    refuse_unless_isolated()
    create_database()
    # With no broker on purpose, every tick would log the same warning.
    logging.getLogger("dashboard-api").setLevel(logging.ERROR)
    logging.getLogger("dashboard-api.ws").setLevel(logging.ERROR)
    # "critical": the broker-less /ws errors (see the KNOWN BUG in roles.spec.ts)
    # would otherwise bury the test output in stack traces.
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="critical")
