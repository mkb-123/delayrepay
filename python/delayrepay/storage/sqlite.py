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
            CREATE TABLE IF NOT EXISTS day_acknowledgements (
                service_date TEXT PRIMARY KEY,
                acknowledged_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS not_claimable (
                service_id TEXT PRIMARY KEY REFERENCES services(service_id) ON DELETE CASCADE,
                marked_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS superseded_claims (
                service_id TEXT PRIMARY KEY REFERENCES services(service_id) ON DELETE CASCADE,
                claimed_by_service_id TEXT NOT NULL REFERENCES services(service_id) ON DELETE CASCADE,
                marked_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS claim_lifecycle (
                service_id TEXT PRIMARY KEY REFERENCES services(service_id) ON DELETE CASCADE,
                status TEXT NOT NULL,
                status_at TEXT NOT NULL,
                operator_code TEXT NOT NULL,
                claim_reference TEXT,
                explanation TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS claim_email_events (
                gmail_message_id TEXT PRIMARY KEY,
                service_id TEXT REFERENCES services(service_id) ON DELETE SET NULL,
                operator_code TEXT NOT NULL,
                claim_reference TEXT,
                outcome TEXT NOT NULL,
                received_at TEXT NOT NULL,
                confidence TEXT NOT NULL,
                explanation TEXT NOT NULL,
                parser_version TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS claim_email_events_service_idx ON claim_email_events(service_id);
            CREATE TABLE IF NOT EXISTS claim_submissions (
                service_id TEXT PRIMARY KEY REFERENCES services(service_id) ON DELETE CASCADE,
                operator_code TEXT NOT NULL,
                state TEXT NOT NULL,
                queued_at TEXT NOT NULL,
                started_at TEXT,
                finished_at TEXT,
                updated_at TEXT NOT NULL,
                attempt_count INTEGER NOT NULL DEFAULT 0,
                claim_reference TEXT,
                last_error TEXT
            );
            CREATE INDEX IF NOT EXISTS claim_submissions_state_idx ON claim_submissions(state, queued_at);
            CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        """)
        self.connection.execute("PRAGMA user_version=3")
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

    def services_between(self, start_date: str, end_date: str) -> list[dict[str, Any]]:
        rows = self.connection.execute(
            "SELECT payload_json FROM services WHERE service_date BETWEEN ? AND ? ORDER BY service_date, scheduled_departure",
            (start_date, end_date),
        ).fetchall()
        return [json.loads(row["payload_json"]) for row in rows]

    def metadata_value(self, key: str) -> str | None:
        row = self.connection.execute("SELECT value FROM metadata WHERE key=?", (key,)).fetchone()
        return row["value"] if row else None

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

    def latest_collection_time(self) -> str | None:
        row = self.connection.execute("SELECT max(collected_at) AS collected_at FROM collection_runs").fetchone()
        return row["collected_at"] if row else None

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

    def claim_lifecycle(self, service_id: str) -> dict[str, Any] | None:
        row = self.connection.execute(
            "SELECT status, status_at, operator_code, claim_reference, explanation FROM claim_lifecycle WHERE service_id=?",
            (service_id,),
        ).fetchone()
        return dict(row) if row else None

    def claim_tracking_items(self) -> list[dict[str, Any]]:
        rows = self.connection.execute("""
            SELECT s.payload_json, c.claimed_at, l.status, l.status_at,
                   l.operator_code, l.claim_reference, l.explanation,
                   q.state AS submission_state, q.queued_at, q.started_at,
                   q.finished_at, q.attempt_count, q.claim_reference AS submission_reference,
                   q.last_error AS submission_error
            FROM services s
            LEFT JOIN claims c ON c.service_id = s.service_id
            LEFT JOIN claim_lifecycle l ON l.service_id = s.service_id
            LEFT JOIN claim_submissions q ON q.service_id = s.service_id
            WHERE c.service_id IS NOT NULL OR l.service_id IS NOT NULL OR q.service_id IS NOT NULL
            ORDER BY s.service_date DESC, s.scheduled_departure
        """).fetchall()
        items = []
        for row in rows:
            service = json.loads(row["payload_json"])
            lifecycle = None
            if row["status"]:
                lifecycle = {
                    "status": row["status"], "status_at": row["status_at"],
                    "operator_code": row["operator_code"],
                    "claim_reference": row["claim_reference"],
                    "explanation": row["explanation"],
                }
            submission = None
            if row["submission_state"]:
                submission = {
                    "state": row["submission_state"], "queuedAt": row["queued_at"],
                    "startedAt": row["started_at"], "finishedAt": row["finished_at"],
                    "attemptCount": row["attempt_count"], "claimReference": row["submission_reference"],
                    "lastError": row["submission_error"],
                }
            items.append({**service, "claimedAt": row["claimed_at"], "claimLifecycle": lifecycle, "claimSubmission": submission})
        return items

    def claim_submission(self, service_id: str) -> dict[str, Any] | None:
        row = self.connection.execute(
            "SELECT * FROM claim_submissions WHERE service_id=?", (service_id,)
        ).fetchone()
        return dict(row) if row else None

    def queue_claim_submission(self, service_id: str, operator_code: str, queued_at: str) -> None:
        with self.connection:
            self.connection.execute("""
                INSERT INTO claim_submissions(
                    service_id, operator_code, state, queued_at, updated_at,
                    started_at, finished_at, attempt_count, claim_reference, last_error
                ) VALUES(?, ?, 'QUEUED', ?, ?, NULL, NULL, 0, NULL, NULL)
                ON CONFLICT(service_id) DO UPDATE SET
                    operator_code=excluded.operator_code, state='QUEUED', queued_at=excluded.queued_at,
                    updated_at=excluded.updated_at, started_at=NULL, finished_at=NULL,
                    claim_reference=NULL, last_error=NULL
            """, (service_id, operator_code, queued_at, queued_at))

    def cancel_claim_submission(self, service_id: str) -> None:
        with self.connection:
            row = self.connection.execute(
                "SELECT state FROM claim_submissions WHERE service_id=?", (service_id,)
            ).fetchone()
            if row and row["state"] == "SUBMITTED":
                raise ValueError("A submitted operator claim cannot be removed from the queue.")
            self.connection.execute("DELETE FROM claim_submissions WHERE service_id=?", (service_id,))

    def pending_claim_submissions(self, limit: int = 10) -> list[dict[str, Any]]:
        rows = self.connection.execute("""
            SELECT q.*, s.payload_json
            FROM claim_submissions q JOIN services s ON s.service_id=q.service_id
            WHERE q.state IN ('QUEUED', 'RETRY')
            ORDER BY q.queued_at LIMIT ?
        """, (limit,)).fetchall()
        return [{**dict(row), "service": json.loads(row["payload_json"])} for row in rows]

    def update_claim_submission(
        self, service_id: str, state: str, updated_at: str, *, claim_reference: str | None = None,
        error: str | None = None, started: bool = False, finished: bool = False,
    ) -> None:
        allowed = {"QUEUED", "PROCESSING", "SUBMITTED", "NEEDS_LOGIN", "NEEDS_ATTENTION", "RETRY"}
        if state not in allowed:
            raise ValueError(f"Unsupported submission state: {state}")
        with self.connection:
            self.connection.execute("""
                UPDATE claim_submissions SET state=?, updated_at=?,
                    started_at=CASE WHEN ? THEN ? ELSE started_at END,
                    finished_at=CASE WHEN ? THEN ? ELSE finished_at END,
                    attempt_count=attempt_count + CASE WHEN ? THEN 1 ELSE 0 END,
                    claim_reference=COALESCE(?, claim_reference), last_error=?
                WHERE service_id=?
            """, (
                state, updated_at, int(started), updated_at, int(finished), updated_at,
                int(started), claim_reference, error, service_id,
            ))

    def record_submitted_claim(
        self, service_id: str, operator_code: str, submitted_at: str, claim_reference: str | None,
    ) -> None:
        self.update_claim_submission(
            service_id, "SUBMITTED", submitted_at, claim_reference=claim_reference, finished=True,
        )
        explanation = "Submitted automatically through the operator portal on the Raspberry Pi."
        with self.connection:
            self.connection.execute("""
                INSERT INTO claim_lifecycle(
                    service_id, status, status_at, operator_code, claim_reference, explanation, updated_at
                ) VALUES(?, 'SUBMITTED', ?, ?, ?, ?, ?)
                ON CONFLICT(service_id) DO UPDATE SET
                    status='SUBMITTED', status_at=excluded.status_at,
                    operator_code=excluded.operator_code,
                    claim_reference=COALESCE(excluded.claim_reference, claim_lifecycle.claim_reference),
                    explanation=excluded.explanation, updated_at=excluded.updated_at
            """, (service_id, submitted_at, operator_code, claim_reference, explanation, submitted_at))
            self.connection.execute("""
                INSERT INTO claims(service_id, claimed_at) VALUES(?, ?)
                ON CONFLICT(service_id) DO UPDATE SET claimed_at=excluded.claimed_at
            """, (service_id, submitted_at))

    def claim_email_events_needing_review(self) -> list[dict[str, Any]]:
        rows = self.connection.execute("""
            SELECT gmail_message_id, service_id, operator_code, claim_reference,
                   outcome, received_at, confidence, explanation
            FROM claim_email_events
            WHERE service_id IS NULL OR confidence != 'CERTAIN'
            ORDER BY received_at DESC
        """).fetchall()
        return [dict(row) for row in rows]

    def match_claim_email_event(self, gmail_message_id: str, service_id: str) -> None:
        event = self.connection.execute(
            "SELECT * FROM claim_email_events WHERE gmail_message_id=?", (gmail_message_id,)
        ).fetchone()
        service = self.connection.execute(
            "SELECT operator_code FROM services WHERE service_id=?", (service_id,)
        ).fetchone()
        if not event:
            raise ValueError("Email event not found.")
        if not service:
            raise ValueError("Journey not found.")
        if service["operator_code"] != event["operator_code"]:
            raise ValueError("The email operator does not match the selected journey.")
        self.save_claim_email_event(
            gmail_message_id=gmail_message_id, service_id=service_id,
            operator_code=event["operator_code"], claim_reference=event["claim_reference"],
            outcome=event["outcome"], received_at=event["received_at"], confidence="CERTAIN",
            explanation=event["explanation"], parser_version=event["parser_version"],
        )
        if event["outcome"] == "NEEDS_REVIEW":
            with self.connection:
                self.connection.execute("""
                    INSERT INTO claim_lifecycle(
                        service_id, status, status_at, operator_code, claim_reference,
                        explanation, updated_at
                    ) VALUES(?, 'NEEDS_REVIEW', ?, ?, ?, ?, datetime('now'))
                    ON CONFLICT(service_id) DO UPDATE SET
                        status=excluded.status, status_at=excluded.status_at,
                        operator_code=excluded.operator_code,
                        claim_reference=excluded.claim_reference,
                        explanation=excluded.explanation, updated_at=excluded.updated_at
                """, (service_id, event["received_at"], event["operator_code"],
                      event["claim_reference"], event["explanation"]))

    def save_claim_email_event(
        self, *, gmail_message_id: str, service_id: str | None, operator_code: str,
        claim_reference: str | None, outcome: str, received_at: str, confidence: str,
        explanation: str, parser_version: str = "manual-agent-v1",
    ) -> None:
        allowed = {"SUBMITTED", "APPROVED", "REJECTED", "PAID", "NEEDS_REVIEW"}
        if outcome not in allowed:
            raise ValueError(f"Unsupported claim outcome: {outcome}")
        with self.connection:
            self.connection.execute("""
                INSERT INTO claim_email_events(
                    gmail_message_id, service_id, operator_code, claim_reference, outcome,
                    received_at, confidence, explanation, parser_version
                ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(gmail_message_id) DO UPDATE SET
                    service_id=excluded.service_id, operator_code=excluded.operator_code,
                    claim_reference=excluded.claim_reference, outcome=excluded.outcome,
                    received_at=excluded.received_at, confidence=excluded.confidence,
                    explanation=excluded.explanation, parser_version=excluded.parser_version
            """, (
                gmail_message_id, service_id, operator_code, claim_reference, outcome,
                received_at, confidence, explanation, parser_version,
            ))
            if service_id and confidence == "CERTAIN" and outcome != "NEEDS_REVIEW":
                current = self.connection.execute(
                    "SELECT status, status_at FROM claim_lifecycle WHERE service_id=?", (service_id,)
                ).fetchone()
                ranks = {"SUBMITTED": 1, "REJECTED": 2, "APPROVED": 3, "PAID": 4}
                should_update = not current
                if current:
                    current_status = current["status"]
                    if current_status == "PAID" and outcome != "PAID":
                        should_update = False
                    elif outcome == "SUBMITTED" and current_status in {"APPROVED", "REJECTED", "PAID"}:
                        should_update = False
                    else:
                        should_update = received_at >= current["status_at"] or ranks[outcome] > ranks[current_status]
                if should_update:
                    self.connection.execute("""
                        INSERT INTO claim_lifecycle(
                            service_id, status, status_at, operator_code, claim_reference,
                            explanation, updated_at
                        ) VALUES(?, ?, ?, ?, ?, ?, datetime('now'))
                        ON CONFLICT(service_id) DO UPDATE SET
                            status=excluded.status, status_at=excluded.status_at,
                            operator_code=excluded.operator_code,
                            claim_reference=excluded.claim_reference,
                            explanation=excluded.explanation, updated_at=excluded.updated_at
                    """, (service_id, outcome, received_at, operator_code, claim_reference, explanation))

    def set_last_gmail_reconciliation(self, reconciled_at: str) -> None:
        with self.connection:
            self.connection.execute("""
                INSERT INTO metadata(key, value) VALUES('last_gmail_reconciliation', ?)
                ON CONFLICT(key) DO UPDATE SET value=excluded.value
            """, (reconciled_at,))

    def day_acknowledged_at(self, service_date: str) -> str | None:
        row = self.connection.execute(
            "SELECT acknowledged_at FROM day_acknowledgements WHERE service_date=?", (service_date,)
        ).fetchone()
        return row["acknowledged_at"] if row else None

    def set_day_acknowledgement(self, service_date: str, acknowledged_at: str | None) -> None:
        with self.connection:
            if acknowledged_at is None:
                self.connection.execute("DELETE FROM day_acknowledgements WHERE service_date=?", (service_date,))
            else:
                self.connection.execute("""
                    INSERT INTO day_acknowledgements(service_date, acknowledged_at) VALUES(?, ?)
                    ON CONFLICT(service_date) DO UPDATE SET acknowledged_at=excluded.acknowledged_at
                """, (service_date, acknowledged_at))

    def not_claimable_at(self, service_id: str) -> str | None:
        row = self.connection.execute("SELECT marked_at FROM not_claimable WHERE service_id=?", (service_id,)).fetchone()
        return row["marked_at"] if row else None

    def set_not_claimable(self, service_id: str, marked_at: str | None) -> None:
        with self.connection:
            if marked_at is None:
                self.connection.execute("DELETE FROM not_claimable WHERE service_id=?", (service_id,))
            else:
                self.connection.execute("DELETE FROM claims WHERE service_id=?", (service_id,))
                self.connection.execute("""
                    INSERT INTO not_claimable(service_id, marked_at) VALUES(?, ?)
                    ON CONFLICT(service_id) DO UPDATE SET marked_at=excluded.marked_at
                """, (service_id, marked_at))

    def claimed_time_preferences(self) -> dict[tuple[str, str], dict[str, Any]]:
        rows = self.connection.execute("""
            SELECT s.direction, substr(s.scheduled_departure, 12, 5) AS train_time,
                   count(*) AS claim_count, max(c.claimed_at) AS last_claimed_at
            FROM claims c
            JOIN services s ON s.service_id = c.service_id
            WHERE s.scheduled_departure IS NOT NULL
            GROUP BY s.direction, train_time
        """).fetchall()
        return {
            (row["direction"], row["train_time"]): {
                "count": row["claim_count"], "lastClaimedAt": row["last_claimed_at"],
            }
            for row in rows
        }

    def superseded_by(self, service_id: str) -> str | None:
        row = self.connection.execute(
            "SELECT claimed_by_service_id FROM superseded_claims WHERE service_id=?", (service_id,)
        ).fetchone()
        return row["claimed_by_service_id"] if row else None

    def supersede_claims(self, service_ids: list[str], claimed_by_service_id: str, marked_at: str) -> None:
        with self.connection:
            for service_id in service_ids:
                self.connection.execute("""
                    INSERT INTO superseded_claims(service_id, claimed_by_service_id, marked_at) VALUES(?, ?, ?)
                    ON CONFLICT(service_id) DO UPDATE SET
                        claimed_by_service_id=excluded.claimed_by_service_id, marked_at=excluded.marked_at
                """, (service_id, claimed_by_service_id, marked_at))

    def clear_superseded_service(self, service_id: str) -> None:
        with self.connection:
            self.connection.execute("DELETE FROM superseded_claims WHERE service_id=?", (service_id,))

    def clear_superseded_by(self, claimed_by_service_id: str) -> None:
        with self.connection:
            self.connection.execute(
                "DELETE FROM superseded_claims WHERE claimed_by_service_id=?", (claimed_by_service_id,)
            )
