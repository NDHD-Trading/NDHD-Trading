"""Scripts and small helpers: the ticker screen's quality rules, database clean-up
and backups, the server's database setup SQL, and sign-in log details.

Run: python -m unittest discover -s tests -t .
"""
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

os.environ.setdefault("LOG_FILE", os.path.join(tempfile.gettempdir(), "ndhd-test-engine.log"))

from sqlalchemy import select  # noqa: E402

from api.routers.auth import _client_details  # noqa: E402
from ndhd import auth, db  # noqa: E402
from scripts import db_upkeep, pg_bootstrap_sql, screen_tickers  # noqa: E402
from tests.test_auth import AuthTestBase  # noqa: E402

HEALTHY = {"marketCap": 100e9, "profitMargins": 0.15, "averageVolume": 5e6, "returnOnEquity": 0.12}


class ScreenQualityTest(unittest.TestCase):
    def problems(self, **info):
        return screen_tickers.quality_problems({**HEALTHY, **info})[0]

    def test_ordinary_company_needs_free_cash_flow(self):
        self.assertEqual(self.problems(sector="Technology", freeCashflow=5e9), [])
        self.assertIn("free cash flow <= 0", self.problems(sector="Technology", freeCashflow=-1e9))

    def test_utility_is_not_failed_on_free_cash_flow(self):
        self.assertEqual(self.problems(sector="Utilities", freeCashflow=-3e9, debtToEquity=150), [])

    def test_pipeline_is_not_failed_on_free_cash_flow(self):
        info = dict(sector="Energy", industry="Oil & Gas Midstream", freeCashflow=-1e9, debtToEquity=180)
        self.assertEqual(self.problems(**info), [])

    def test_oil_major_is_still_judged_on_free_cash_flow(self):
        info = dict(sector="Energy", industry="Oil & Gas Integrated", freeCashflow=-1e9, debtToEquity=20)
        self.assertIn("free cash flow <= 0", self.problems(**info))

    def test_utility_judged_on_profit_and_debt(self):
        self.assertIn("debt/equity > 2.5", self.problems(sector="Utilities", debtToEquity=300))
        self.assertIn("debt unknown", self.problems(sector="Utilities"))
        self.assertIn("ROE <= 8%", self.problems(sector="Utilities", debtToEquity=150, returnOnEquity=0.05))
        self.assertIn("not profitable", self.problems(sector="Utilities", debtToEquity=150, profitMargins=-0.1))

    def test_banks_still_use_return_on_equity(self):
        self.assertEqual(self.problems(sector="Financial Services", freeCashflow=-9e9), [])
        self.assertIn("bank ROE <= 8%", self.problems(sector="Financial Services", returnOnEquity=0.05))


class PruneTest(AuthTestBase):
    def add_session(self, s, token, expires, revoked=False, created=None):
        user = s.scalar(select(db.User).where(db.User.username == "ada"))
        s.add(db.LoginSession(token_hash=auth.token_hash(token), user=user, expires_at=expires, revoked=revoked,
                              created_at=created or expires - timedelta(hours=12)))

    def test_removes_only_what_is_old_enough(self):
        now = datetime(2026, 11, 8, 12, tzinfo=timezone.utc)
        with db.session() as s:
            self.add_session(s, "live", now + timedelta(hours=1))
            self.add_session(s, "just-expired", now - timedelta(days=1))
            self.add_session(s, "long-expired", now - timedelta(days=30))
            self.add_session(s, "revoked-old", now + timedelta(days=30), revoked=True, created=now - timedelta(days=30))
            self.add_session(s, "revoked-new", now + timedelta(hours=1), revoked=True, created=now - timedelta(days=1))
            s.add(db.LoginEvent(username="ada", success=True, at=now - timedelta(days=200)))
            s.add(db.LoginEvent(username="ada", success=True, at=now - timedelta(days=10)))
            s.commit()

            self.assertEqual(auth.prune(s, now), (2, 1))
            left = {row.token_hash for row in s.scalars(select(db.LoginSession))}
            self.assertEqual(left, {auth.token_hash(t) for t in ("live", "just-expired", "revoked-new")})
            self.assertEqual(len(s.scalars(select(db.LoginEvent)).all()), 1)

    def test_running_twice_is_harmless(self):
        with db.session() as s:
            self.assertEqual(auth.prune(s), (0, 0))
            self.assertEqual(auth.prune(s), (0, 0))


class BackupTest(unittest.TestCase):
    def test_password_goes_in_the_environment_not_the_command(self):
        url = "postgresql+psycopg://app_role:s3cret@127.0.0.1:5433/ndhd"
        command, env = db_upkeep.pg_dump_command(url, "pg_dump", Path("x.dump"))
        self.assertNotIn("s3cret", " ".join(command))
        self.assertEqual(env, {"PGPASSWORD": "s3cret"})
        self.assertEqual(command[1:7], ["-h", "127.0.0.1", "-p", "5433", "-U", "app_role"])
        self.assertEqual(command[-1], "ndhd")

    def test_rotate_keeps_the_newest(self):
        with tempfile.TemporaryDirectory() as folder:
            folder = Path(folder)
            for day in range(1, 6):
                (folder / f"ndhd-2026110{day}-030000.dump").write_text("x")
            (folder / "keep-me.txt").write_text("x")
            removed = db_upkeep.rotate(folder, keep=2)
            self.assertEqual(len(removed), 3)
            left = sorted(p.name for p in folder.iterdir())
            self.assertEqual(left, ["keep-me.txt", "ndhd-20261104-030000.dump", "ndhd-20261105-030000.dump"])


class BootstrapSqlTest(unittest.TestCase):
    def test_creates_role_and_database_only_if_missing(self):
        sql = pg_bootstrap_sql.bootstrap_sql("postgresql+psycopg://app_role:pw@127.0.0.1:5432/ndhd")
        self.assertIn("CREATE ROLE app_role LOGIN", sql)
        self.assertIn("WHERE NOT EXISTS", sql)
        self.assertIn("CREATE DATABASE ndhd OWNER app_role", sql)
        self.assertIn("PASSWORD 'pw';", sql)

    def test_password_quote_is_escaped(self):
        sql = pg_bootstrap_sql.bootstrap_sql("postgresql+psycopg://app_role:it%27s@127.0.0.1/ndhd")
        self.assertIn("PASSWORD 'it''s';", sql)

    def test_odd_names_are_refused(self):
        with self.assertRaises(ValueError):
            pg_bootstrap_sql.bootstrap_sql('postgresql+psycopg://bad"role:pw@127.0.0.1/ndhd')
        with self.assertRaises(ValueError):
            pg_bootstrap_sql.bootstrap_sql("postgresql+psycopg://app_role@127.0.0.1/ndhd")


class ClientDetailsTest(unittest.TestCase):
    def request(self, host, **headers):
        fixed = {k.replace("_", "-"): v for k, v in headers.items()}
        return SimpleNamespace(client=SimpleNamespace(host=host), headers=fixed)

    def test_behind_tailscale_shows_the_real_address_and_user(self):
        request = self.request("127.0.0.1", x_forwarded_for="100.64.0.7", tailscale_user_login="a@example.com",
                               user_agent="Phone")
        self.assertEqual(_client_details(request), ("100.64.0.7", "tailscale:a@example.com Phone"))

    def test_on_this_pc(self):
        self.assertEqual(_client_details(self.request("127.0.0.1", user_agent="Chrome")), ("127.0.0.1", "Chrome"))

    def test_proxy_headers_are_ignored_from_anywhere_else(self):
        request = self.request("10.0.0.5", x_forwarded_for="1.2.3.4", tailscale_user_login="fake@example.com",
                               user_agent="Curl")
        self.assertEqual(_client_details(request), ("10.0.0.5", "Curl"))


if __name__ == "__main__":
    unittest.main()
