"""Back up the dashboard's user database and clear out old records.

    python scripts/db_upkeep.py                 # both
    python scripts/db_upkeep.py --backup-only
    python scripts/db_upkeep.py --prune-only

Backups go to backups/ (git-ignored; they hold password hashes). The newest 14
are kept. See docs/DATABASE.md. The password never appears on a command line or
in the output.
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from dotenv import load_dotenv  # noqa: E402
from sqlalchemy.engine import make_url  # noqa: E402

from ndhd import auth, db  # noqa: E402

KEEP_BACKUPS = 14


def find_pg_dump() -> str:
    found = shutil.which("pg_dump")
    if found:
        return found
    for candidate in sorted(Path(r"C:\Program Files\PostgreSQL").glob(r"*\bin\pg_dump.exe"), reverse=True):
        return str(candidate)
    raise SystemExit("pg_dump not found. Install the PostgreSQL client tools.")


def pg_dump_command(url: str, pg_dump: str, out_file: Path) -> tuple[list[str], dict]:
    """(command, extra environment). The password travels in the environment."""
    parts = make_url(url)
    command = [pg_dump, "-h", parts.host or "127.0.0.1", "-p", str(parts.port or 5432),
               "-U", parts.username or "", "-Fc", "-f", str(out_file), parts.database or ""]
    return command, {"PGPASSWORD": parts.password or ""}


def rotate(folder: Path, keep: int = KEEP_BACKUPS) -> list[Path]:
    """Delete all but the newest `keep` backups; returns what was deleted."""
    backups = sorted(folder.glob("ndhd-*.dump"), reverse=True)  # the name sorts by time
    old = backups[keep:]
    for path in old:
        path.unlink()
    return old


def backup(url: str, folder: Path) -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / f"ndhd-{datetime.now():%Y%m%d-%H%M%S}.dump"
    partial = target.with_suffix(".partial")
    command, extra_env = pg_dump_command(url, find_pg_dump(), partial)
    try:
        subprocess.run(command, env={**os.environ, **extra_env}, check=True, capture_output=True, text=True)
    except subprocess.CalledProcessError as exc:
        partial.unlink(missing_ok=True)
        raise SystemExit(f"pg_dump failed (exit {exc.returncode}): {exc.stderr.strip()[:300]}") from exc
    partial.replace(target)
    return target


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--backup-only", action="store_true")
    mode.add_argument("--prune-only", action="store_true")
    parser.add_argument("--out", type=Path, default=ROOT / "backups", help="backup folder")
    args = parser.parse_args()

    load_dotenv(ROOT / ".env")
    url = db.database_url()
    if not url:
        raise SystemExit("DATABASE_URL is not set (see .env).")

    stamp = f"{datetime.now():%Y-%m-%d %H:%M:%S}"
    if not args.prune_only:
        target = backup(url, args.out)
        removed = rotate(args.out)
        print(f"{stamp} backup: {target.name} ({target.stat().st_size} bytes), {len(removed)} old removed")
    if not args.backup_only:
        with db.session() as s:
            sessions, events = auth.prune(s)
        print(f"{stamp} prune: {sessions} old sessions, {events} old sign-in records removed")


if __name__ == "__main__":
    main()
