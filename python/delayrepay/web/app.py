from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
import base64
import logging
import os
from pathlib import Path
import threading
import uuid
from typing import Any

from flask import Flask, jsonify, render_template, request, send_from_directory

from ..refresh import CollectionBusyError, CollectionLock, refresh_plan
from ..ingestion.rtt import RttClient
from ..operations import collection_plan, discovery_plan
from ..storage.sqlite import Database
from ..workflows import build_report_data, collect, discover, set_claim
from ..workflows import _now

LOGGER = logging.getLogger("delayrepay.web")
JOBS: dict[str, dict[str, Any]] = {}
JOBS_LOCK = threading.Lock()


def _job_update(job_id: str, **values: Any) -> None:
    with JOBS_LOCK:
        JOBS[job_id].update(values)


def _run_refresh(root: Path, job_id: str, plan: dict[str, Any]) -> None:
    try:
        with CollectionLock(root):
            client = RttClient()
            targets = plan["fetch"]
            for index, item in enumerate(targets, 1):
                _job_update(job_id, status="running", message=f"Collecting {item['date']}", completed=index - 1)
                collect(root, item["date"], client)
                with Database(root) as database:
                    build_report_data(database, item["date"], False, persist=True)
            _job_update(job_id, status="complete", completed=len(targets), message="Refresh complete")
    except Exception as error:  # job errors must remain visible to the polling client
        LOGGER.exception("Refresh job %s failed", job_id)
        _job_update(job_id, status="failed", error=str(error), message="Refresh failed")


def _run_operation(root: Path, job_id: str, operation: str, plan: dict[str, Any]) -> None:
    try:
        with CollectionLock(root):
            client = RttClient()
            targets = plan["dates"]
            for index, target in enumerate(targets, 1):
                service_date = target if isinstance(target, str) else target["date"]
                verb = "Discovering" if operation == "discover" else "Collecting"
                _job_update(job_id, status="running", completed=index - 1, message=f"{verb} {service_date}")
                if operation == "discover":
                    discover(root, service_date, client, plan["direction"])
                else:
                    collect(root, service_date, client)
                    with Database(root) as database:
                        build_report_data(database, service_date, False, persist=True)
            _job_update(job_id, status="complete", completed=len(targets), message=f"{operation.title()} complete")
    except Exception as error:
        LOGGER.exception("%s job %s failed", operation, job_id)
        _job_update(job_id, status="failed", error=str(error), message=f"{operation.title()} failed")


def _start_job(root: Path, operation: str, plan: dict[str, Any]):
    with JOBS_LOCK:
        active = next((job for job in JOBS.values() if job["status"] in {"queued", "running"}), None)
        if active or (root / "collection.lock").exists():
            return jsonify({"error": "Another discovery or collection is already running."}), 409
        job_id = uuid.uuid4().hex
        JOBS[job_id] = {
            "id": job_id, "operation": operation, "status": "queued", "completed": 0,
            "total": len(plan["dates"]), "message": "Queued", "plan": plan,
        }
    threading.Thread(target=_run_operation, args=(root, job_id, operation, plan), daemon=True).start()
    return jsonify(JOBS[job_id]), 202


def _require_same_origin() -> None:
    if not request.is_json:
        raise ValueError("A JSON request body is required.")
    origin = request.headers.get("Origin")
    expected = request.host_url.rstrip("/")
    if not origin or origin.rstrip("/") != expected:
        raise PermissionError("The request origin does not match this dashboard.")


def _require_loopback_worker() -> None:
    if request.remote_addr not in {"127.0.0.1", "::1"}:
        raise PermissionError("The laptop worker API is available only through a localhost SSH tunnel.")
    if not request.is_json:
        raise ValueError("A JSON request body is required.")


def create_app(root: Path | str | None = None) -> Flask:
    app = Flask(__name__)
    data_root = Path(root or "data-store")
    app.config["DATA_ROOT"] = data_root

    @app.errorhandler(ValueError)
    def bad_request(error: ValueError):
        return jsonify({"error": str(error)}), 400

    @app.errorhandler(PermissionError)
    def forbidden(error: PermissionError):
        return jsonify({"error": str(error)}), 403

    @app.get("/")
    def index():
        return render_template("index.html")

    @app.get("/health")
    def health():
        with Database(data_root) as database:
            database.connection.execute("SELECT 1").fetchone()
        return jsonify({"status": "ok"})

    @app.get("/api/dashboard")
    def dashboard():
        end = date.fromisoformat(request.args.get("to", date.today().isoformat()))
        start = date.fromisoformat(request.args.get("from", (end - timedelta(days=9)).isoformat()))
        if start > end:
            raise ValueError("from must be on or before to")
        if (end - start).days > 36525:
            raise ValueError("Choose a date range of 100 years or less.")
        reports = []
        with Database(data_root) as database:
            for service_date in reversed(database.stored_dates(start.isoformat(), end.isoformat())):
                reports.append(build_report_data(database, service_date, False, persist=False))
            email_review = database.claim_email_events_needing_review()
            last_reconciliation = database.metadata_value("last_gmail_reconciliation")
            last_collection = database.latest_collection_time()
            claim_tracking = database.claim_tracking_items()
            operator_sessions = database.operator_sessions()
            calibrated = {code: database.operator_calibrated(code) for code in ("VT", "LM")}
        totals = {"potentialClaims": 0, "needsReview": 0, "claimed": 0, "noClaim": 0, "incompleteDays": 0}
        for report in reports:
            for key in ("potentialClaims", "needsReview", "claimed", "noClaim"):
                totals[key] += report["summary"][key]
            totals["incompleteDays"] += int(not report["sourceComplete"])
        backups = sorted((data_root / "backups").glob("delayrepay-*.sqlite"), reverse=True)
        mirror_value = os.environ.get("DELAYREPAY_BACKUP_MIRROR_DIR", "").strip()
        token_value = os.environ.get("GMAIL_OAUTH_TOKEN_FILE", "").strip()
        operations = {
            "lastGmailReconciliation": last_reconciliation,
            "lastCollection": last_collection,
            "gmailConfigured": bool(token_value and Path(token_value).is_file()),
            "emailReview": email_review,
            "claimTracking": claim_tracking,
            "operatorSessions": operator_sessions,
            "operatorCalibrated": calibrated,
            "lastBackup": datetime.fromtimestamp(backups[0].stat().st_mtime, timezone.utc).isoformat() if backups else None,
            "backupMirrorConfigured": bool(mirror_value),
            "backupMirrorAvailable": bool(mirror_value and Path(mirror_value).is_dir()),
        }
        return jsonify({"from": start.isoformat(), "to": end.isoformat(), "summary": totals, "days": reports, "operations": operations})

    @app.get("/api/export.json")
    def export_json():
        return dashboard()

    @app.post("/api/email-events/<path:gmail_message_id>/match")
    def match_email_event(gmail_message_id: str):
        _require_same_origin()
        service_id = (request.get_json() or {}).get("serviceId", "")
        if not service_id:
            raise ValueError("serviceId is required")
        with Database(data_root) as database:
            database.match_claim_email_event(gmail_message_id, service_id)
        return jsonify({"status": "MATCHED"})

    @app.get("/api/refresh-plan")
    def get_refresh_plan():
        return jsonify(refresh_plan(data_root, int(request.args.get("days", "10"))))

    @app.get("/api/discovery-plan")
    def get_discovery_plan():
        return jsonify(discovery_plan(
            request.args.get("endDate", date.today().isoformat()),
            int(request.args.get("days", "5")), request.args.get("direction", "ALL"),
        ))

    @app.post("/api/discover")
    def start_discovery():
        _require_same_origin()
        payload = request.get_json() or {}
        plan = discovery_plan(payload.get("endDate", date.today().isoformat()), int(payload.get("days", 5)), payload.get("direction", "ALL"))
        if not plan["dates"]:
            return jsonify({"status": "complete", "message": "No dates in this range.", "plan": plan})
        return _start_job(data_root, "discover", plan)

    @app.get("/api/collection-plan")
    def get_collection_plan():
        return jsonify(collection_plan(
            data_root, request.args.get("endDate", date.today().isoformat()),
            int(request.args.get("days", "10")), request.args.get("mode", "missing"),
        ))

    @app.post("/api/collect")
    def start_collection():
        _require_same_origin()
        payload = request.get_json() or {}
        plan = collection_plan(data_root, payload.get("endDate", date.today().isoformat()), int(payload.get("days", 10)), payload.get("mode", "missing"))
        if not plan["dates"]:
            return jsonify({"status": "complete", "message": "Nothing needs collecting.", "plan": plan})
        return _start_job(data_root, "collect", plan)

    @app.post("/api/refresh")
    def start_refresh():
        _require_same_origin()
        payload = request.get_json() or {}
        days = int(payload.get("days", 10))
        plan = refresh_plan(data_root, days)
        if not plan["fetch"]:
            return jsonify({"status": "complete", "message": "Nothing needs refreshing.", "plan": plan})
        lock_path = data_root / "collection.lock"
        if lock_path.exists():
            return jsonify({"error": "Another collection is already running."}), 409
        job_id = uuid.uuid4().hex
        with JOBS_LOCK:
            JOBS[job_id] = {
                "id": job_id, "status": "queued", "completed": 0,
                "total": len(plan["fetch"]), "message": "Queued", "plan": plan,
            }
        thread = threading.Thread(target=_run_refresh, args=(data_root, job_id, plan), daemon=True)
        thread.start()
        return jsonify(JOBS[job_id]), 202

    @app.get("/api/jobs/<job_id>")
    def job(job_id: str):
        with JOBS_LOCK:
            value = JOBS.get(job_id)
            return (jsonify(value), 200) if value else (jsonify({"error": "Job not found"}), 404)

    @app.post("/api/services/<path:service_id>/claim")
    def claim(service_id: str):
        _require_same_origin()
        with Database(data_root) as database:
            service = database.service_by_id(service_id)
        if not service:
            return jsonify({"error": "Service not found"}), 404
        set_claim(data_root, service["serviceDate"], service_id, False)
        return jsonify({"status": "CLAIMED", "message": "Acknowledged only; no claim was submitted."})

    @app.post("/api/services/<path:service_id>/submission")
    def queue_submission(service_id: str):
        _require_same_origin()
        with Database(data_root) as database:
            service = database.service_by_id(service_id)
            if not service:
                return jsonify({"error": "Service not found"}), 404
            report = build_report_data(database, service["serviceDate"], False, persist=False)
            row = next(item for item in report["services"] if item["serviceId"] == service_id)
            if row["assessment"]["status"] not in {"POTENTIAL", "NEEDS_REVIEW", "CLAIMED"}:
                raise ValueError("Only a claimable or reviewed disruption can be queued.")
            if database.claim_lifecycle(service_id) and database.claim_lifecycle(service_id)["status"] in {"SUBMITTED", "APPROVED", "PAID"}:
                raise ValueError("This journey already has an operator claim.")
            mode = "SUBMIT" if database.operator_calibrated(service["operatorCode"]) else "CALIBRATE"
            database.queue_claim_submission(service_id, service["operatorCode"], _now(), mode)
        message = "Queued for the laptop claim worker." if mode == "SUBMIT" else "Queued for laptop calibration; it will stop before submission."
        return jsonify({"status": "QUEUED", "mode": mode, "message": message})

    @app.post("/api/services/<path:service_id>/submission/confirm-calibration")
    def confirm_calibration(service_id: str):
        _require_same_origin()
        with Database(data_root) as database:
            service = database.service_by_id(service_id)
            submission = database.claim_submission(service_id)
            if not service or not submission:
                return jsonify({"error": "Claim calibration not found"}), 404
            if submission["state"] != "CALIBRATION_READY":
                raise ValueError("This claim is not waiting for calibration confirmation.")
            database.set_operator_calibrated(service["operatorCode"], _now())
            database.queue_claim_submission(service_id, service["operatorCode"], _now(), "SUBMIT")
        return jsonify({"status": "QUEUED", "message": "Calibration approved; queued for the laptop worker."})

    @app.post("/api/services/<path:service_id>/submission/retry")
    def retry_submission(service_id: str):
        _require_same_origin()
        with Database(data_root) as database:
            service = database.service_by_id(service_id)
            submission = database.claim_submission(service_id)
            if not service or not submission:
                return jsonify({"error": "Queued claim not found"}), 404
            mode = submission.get("mode") or ("SUBMIT" if database.operator_calibrated(service["operatorCode"]) else "CALIBRATE")
            database.queue_claim_submission(service_id, service["operatorCode"], _now(), mode)
        return jsonify({"status": "QUEUED", "message": "Queued for the laptop worker."})

    @app.post("/api/claim-worker/run")
    def run_worker_now():
        _require_same_origin()
        return jsonify({"status": "WAITING", "message": "Queued. The laptop worker picks it up within about 15 minutes while the laptop is on and signed in."})

    @app.post("/api/operator-sessions/check")
    def check_operator_sessions():
        _require_same_origin()
        return jsonify({"status": "WAITING", "message": "Session checks run on the Windows laptop."})

    @app.post("/api/private-worker/next")
    def private_worker_next():
        _require_loopback_worker()
        with Database(data_root) as database:
            item = database.lease_claim_submission(_now())
        if not item:
            return jsonify({"job": None})
        return jsonify({"job": {
            "serviceId": item["service_id"], "operatorCode": item["operator_code"],
            "mode": item.get("mode") or "CALIBRATE", "service": item["service"],
        }})

    @app.post("/api/private-worker/result")
    def private_worker_result():
        _require_loopback_worker()
        payload = request.get_json() or {}
        service_id = payload.get("serviceId", "")
        state = payload.get("state", "")
        if state not in {"CALIBRATION_READY", "SUBMITTED", "NEEDS_LOGIN", "NEEDS_ATTENTION"}:
            raise ValueError("Unsupported worker result state.")
        with Database(data_root) as database:
            submission = database.claim_submission(service_id)
            if not submission or submission["state"] != "PROCESSING":
                raise ValueError("This claim job is not leased to a worker.")
            screenshot_name = None
            encoded = payload.get("screenshotBase64")
            if encoded:
                content = base64.b64decode(encoded, validate=True)
                if len(content) > 5_000_000 or not content.startswith(b"\x89PNG\r\n\x1a\n"):
                    raise ValueError("Invalid worker screenshot.")
                screenshot_name = "".join(c if c.isalnum() or c in "._-" else "_" for c in service_id) + ".png"
                target = data_root / "claim-screenshots" / screenshot_name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(content)
            if state == "SUBMITTED":
                database.record_submitted_claim(service_id, submission["operator_code"], _now(), payload.get("reference"))
            else:
                database.update_claim_submission(service_id, state, _now(), finished=True,
                    error=payload.get("error"), last_step=payload.get("lastStep"), screenshot_path=screenshot_name)
            if state == "NEEDS_LOGIN":
                database.set_operator_session(submission["operator_code"], "LOGIN_NEEDED", _now(), payload.get("error") or "Login required.")
            elif state in {"CALIBRATION_READY", "SUBMITTED"}:
                database.set_operator_session(submission["operator_code"], "LOGIN_OK", _now(), "Laptop browser session opened successfully.")
        return jsonify({"status": state})

    @app.post("/api/private-worker/session")
    def private_worker_session():
        _require_loopback_worker()
        payload = request.get_json() or {}
        code, status = payload.get("operatorCode", ""), payload.get("status", "")
        if code not in {"VT", "LM"} or status not in {"LOGIN_OK", "LOGIN_NEEDED"}:
            raise ValueError("Unsupported operator session update.")
        with Database(data_root) as database:
            database.set_operator_session(code, status, _now(), payload.get("explanation") or "Laptop session check.")
        return jsonify({"status": status})

    @app.get("/api/claim-screenshots/<path:filename>")
    def claim_screenshot(filename: str):
        if Path(filename).name != filename or not filename.endswith(".png"):
            raise ValueError("Invalid screenshot name")
        return send_from_directory(data_root / "claim-screenshots", filename)

    @app.delete("/api/services/<path:service_id>/submission")
    def cancel_submission(service_id: str):
        _require_same_origin()
        with Database(data_root) as database:
            if not database.service_by_id(service_id):
                return jsonify({"error": "Service not found"}), 404
            database.cancel_claim_submission(service_id)
        return jsonify({"status": "CANCELLED", "message": "Removed from the automatic claim queue."})

    @app.delete("/api/services/<path:service_id>/claim")
    def undo_claim(service_id: str):
        _require_same_origin()
        with Database(data_root) as database:
            service = database.service_by_id(service_id)
        if not service:
            return jsonify({"error": "Service not found"}), 404
        set_claim(data_root, service["serviceDate"], service_id, True)
        return jsonify({"status": "RESTORED"})

    @app.post("/api/services/<path:service_id>/not-claimable")
    def mark_not_claimable(service_id: str):
        _require_same_origin()
        with Database(data_root) as database:
            if not database.service_by_id(service_id):
                return jsonify({"error": "Service not found"}), 404
            database.set_not_claimable(service_id, _now())
        return jsonify({"status": "NO_CLAIM"})

    @app.delete("/api/services/<path:service_id>/not-claimable")
    def undo_not_claimable(service_id: str):
        _require_same_origin()
        with Database(data_root) as database:
            if not database.service_by_id(service_id):
                return jsonify({"error": "Service not found"}), 404
            database.set_not_claimable(service_id, None)
        return jsonify({"status": "RESTORED"})

    @app.post("/api/days/<service_date>/acknowledgement")
    def acknowledge_day(service_date: str):
        _require_same_origin()
        date.fromisoformat(service_date)
        with Database(data_root) as database:
            if service_date not in database.stored_dates(service_date, service_date):
                return jsonify({"error": "No stored services for this date."}), 404
            database.set_day_acknowledgement(service_date, _now())
        return jsonify({"status": "ACKNOWLEDGED"})

    @app.delete("/api/days/<service_date>/acknowledgement")
    def undo_day_acknowledgement(service_date: str):
        _require_same_origin()
        date.fromisoformat(service_date)
        with Database(data_root) as database:
            database.set_day_acknowledgement(service_date, None)
        return jsonify({"status": "RESTORED"})

    return app
