"""Print the SQL that creates the dashboard's PostgreSQL role and database from
DATABASE_URL in .env. Safe to run again. deploy/setup-server.sh pipes it into
psql, so the password never appears on a command line.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from dotenv import load_dotenv  # noqa: E402
from sqlalchemy.engine import make_url  # noqa: E402

from ndhd import db  # noqa: E402


def bootstrap_sql(url: str) -> str:
    parts = make_url(url)
    role, database, password = parts.username, parts.database, parts.password
    for name in (role, database):
        if not name or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
            raise ValueError("The database and role names in DATABASE_URL must be plain identifiers.")
    if not password:
        raise ValueError("DATABASE_URL has no password.")
    secret = "'" + password.replace("'", "''") + "'"
    return "\n".join([
        f"SELECT 'CREATE ROLE {role} LOGIN' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{role}') \\gexec",
        f"ALTER ROLE {role} WITH LOGIN PASSWORD {secret};",
        f"SELECT 'CREATE DATABASE {database} OWNER {role}' "
        f"WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = '{database}') \\gexec",
        "",
    ])


if __name__ == "__main__":
    load_dotenv(ROOT / ".env")
    url = db.database_url()
    if not url:
        raise SystemExit("DATABASE_URL is not set (see .env).")
    sys.stdout.write(bootstrap_sql(url))
