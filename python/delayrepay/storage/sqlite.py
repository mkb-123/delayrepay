from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any


def read_json(path: Path, default: Any = None) -> Any:
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    temporary.replace(path)


def catalogue_path(root: Path) -> Path:
    return root / "service-catalogue.json"


class Database:
    def __init__(self, root: Path):
        root.mkdir(parents=True, exist_ok=True)
        self.path = root / "delayrepay.sqlite"
        self.connection = sqlite3.connect(self.path, timeout=10)
        self.connection.row_factory = sqlite3.Row
        self.connection.execute("PRAGMA journal_mode=WAL")
        self.connection.execute("PRAGMA busy_timeout=10000")
        self.connection.execute("PRAGMA foreign_keys=ON")
        self._migrate()
        self._import_json_history(root)

    def close(self) -> None:
        self.connection.close()

    def __enter__(self) -> "Database":
        return self

    def __exit__(self, _exception_type: object, _exception: object, _traceback: object) -> None:
        self.close()

    def _migrate(self) -> None:
        self.connection.executescript("""
            CREATE TABLE IF NOT EXISTS services (
                service_id TEXT PRIMARY KEY,
                service_date TEXT NOT NULL,
                direction TEXT NOT NULL,
                operator_code TEXT NOT NULL,
                scheduled_departure TEXT,
                payload_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS services_date_idx ON services(service_date);
            CREATE TABLE IF NOT EXISTS collection_runs (
                service_date TEXT PRIMARY KEY,
                collected_at TEXT NOT NULL,
                complete INTEGER NOT NULL,
                errors_json TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS assessments (
                service_id TEXT PRIMARY KEY REFERENCES services(service_id) ON DELETE CASCADE,
                assessed_at TEXT NOT NULL,
                status TEXT NOT NULL,
                rule_version TEXT NOT NULL,
                payload_json TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS claims (
                service_id TEXT PRIMARY KEY REFERENCES services(service_id) ON DELETE CASCADE,
                claimed_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        """)
        self.connection.execute("PRAGMA user_version=1")
        self.connection.commit()

    def _import_json_history(self, root: Path) -> None:
        marker = self.connection.execute("SELECT value FROM metadata WHERE key='json_history_imported'").fetchone()
        if marker:
            return
        sources = [root / "daily", root.parent / "legacy" / "python-json-data" / "daily"]
        imported: set[str] = set()
        for source in sources:
            for path in sorted(source.glob("*.json")):
                value = read_json(path, {})
                if value.get("date") in imported or value.get("services") is None:
                    continue
                self.save_collection(value)
                imported.add(value["date"])
        self.connection.execute("INSERT INTO metadata(key, value) VALUES('json_history_imported', datetime('now'))")
        self.connection.commit()

    def save_collection(self, value: dict[str, Any]) -> None:
        collected_at = value["collectedAt"]
        with self.connection:
            for service in value.get("services", []):
                self.connection.execute("""
                    INSERT INTO services(service_id, service_date, direction, operator_code, scheduled_departure, payload_json, created_at, updated_at)
                    VALUES(?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(service_id) DO UPDATE SET
                        service_date=excluded.service_date, direction=excluded.direction,
                        operator_code=excluded.operator_code, scheduled_departure=excluded.scheduled_departure,
                        payload_json=excluded.payload_json, updated_at=excluded.updated_at
                """, (
                    service["serviceId"], service["serviceDate"], service["direction"], service["operatorCode"],
                    service.get("scheduledDeparture"), json.dumps(service, ensure_ascii=False), collected_at, collected_at,
                ))
            self.connection.execute("""
                INSERT INTO collection_runs(service_date, collected_at, complete, errors_json)
                VALUES(?, ?, ?, ?)
                ON CONFLICT(service_date) DO UPDATE SET
                    collected_at=excluded.collected_at, complete=excluded.complete, errors_json=excluded.errors_json
            """, (value["date"], collected_at, int(value.get("complete", False)), json.dumps(value.get("errors", []))))

    def services_for_date(self, service_date: str) -> list[dict[str, Any]]:
        rows = self.connection.execute(
            "SELECT payload_json FROM services WHERE service_date=? ORDER BY direction, scheduled_departure", (service_date,)
        ).fetchall()
        return [json.loads(row["payload_json"]) for row in rows]

    def service_by_id(self, service_id: str) -> dict[str, Any] | None:
        row = self.connection.execute(
            "SELECT payload_json FROM services WHERE service_id=?", (service_id,)
        ).fetchone()
        return json.loads(row["payload_json"]) if row else None

    def stored_dates(self, start_date: str, end_date: str) -> list[str]:
        rows = self.connection.execute(
            "SELECT DISTINCT service_date FROM services WHERE service_date BETWEEN ? AND ? ORDER BY service_date", (start_date, end_date)
        ).fetchall()
        return [row["service_date"] for row in rows]

    def collection_complete(self, service_date: str) -> bool:
        row = self.connection.execute("SELECT complete FROM collection_runs WHERE service_date=?", (service_date,)).fetchone()
        return bool(row["complete"]) if row else False

    def collection_state(self, service_date: str) -> dict[str, Any] | None:
        row = self.connection.execute(
            "SELECT collected_at, complete, errors_json FROM collection_runs WHERE service_date=?", (service_date,)
        ).fetchone()
        if not row:
            return None
        return {
            "collectedAt": row["collected_at"],
            "complete": bool(row["complete"]),
            "errors": json.loads(row["errors_json"]),
        }

    def claimed_at(self, service_id: str) -> str | None:
        row = self.connection.execute("SELECT claimed_at FROM claims WHERE service_id=?", (service_id,)).fetchone()
        return row["claimed_at"] if row else None

    def save_assessment(self, service_id: str, assessed_at: str, assessment: dict[str, Any]) -> None:
        with self.connection:
            self.connection.execute("""
                INSERT INTO assessments(service_id, assessed_at, status, rule_version, payload_json)
                VALUES(?, ?, ?, ?, ?)
                ON CONFLICT(service_id) DO UPDATE SET assessed_at=excluded.assessed_at,
                    status=excluded.status, rule_version=excluded.rule_version, payload_json=excluded.payload_json
            """, (service_id, assessed_at, assessment["status"], assessment["ruleVersion"], json.dumps(assessment, ensure_ascii=False)))

    def set_claim(self, service_id: str, claimed_at: str | None) -> None:
        with self.connection:
            if claimed_at is None:
                self.connection.execute("DELETE FROM claims WHERE service_id=?", (service_id,))
            else:
                self.connection.execute("""
                    INSERT INTO claims(service_id, claimed_at) VALUES(?, ?)
                    ON CONFLICT(service_id) DO UPDATE SET claimed_at=excluded.claimed_at
                """, (service_id, claimed_at))
