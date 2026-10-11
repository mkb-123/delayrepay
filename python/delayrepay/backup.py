from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from pathlib import Path


def backup_database(data_dir: Path, keep: int = 30) -> Path:
    source = data_dir / "delayrepay.sqlite"
    if not source.exists():
        raise ValueError(f"Database not found: {source}")
    destination_dir = data_dir / "backups"
    destination_dir.mkdir(parents=True, exist_ok=True)
    destination = destination_dir / f"delayrepay-{datetime.now(timezone.utc):%Y%m%dT%H%M%SZ}.sqlite"
    with sqlite3.connect(source) as source_db, sqlite3.connect(destination) as destination_db:
        source_db.backup(destination_db)
    backups = sorted(destination_dir.glob("delayrepay-*.sqlite"), reverse=True)
    for old in backups[max(1, keep):]:
        old.unlink()
    return destination
