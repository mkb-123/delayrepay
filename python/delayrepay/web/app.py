from __future__ import annotations

from datetime import date, timedelta
import logging
from pathlib import Path
import threading
import uuid
from typing import Any

from flask import Flask, jsonify, render_template, request

from ..refresh import CollectionBusyError, CollectionLock, refresh_plan
from ..ingestion.rtt import RttClient
from ..storage.sqlite import Database
from ..workflows import build_report_data, collect, set_claim

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


def _require_same_origin() -> None:
    if not request.is_json:
        raise ValueError("A JSON request body is required.")
    origin = request.headers.get("Origin")
    expected = request.host_url.rstrip("/")
    if not origin or origin.rstrip("/") != expected:
        raise PermissionError("The request origin does not match this dashboard.")


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
        if (end - start).days > 3660:
            raise ValueError("Date range is too large")
        reports = []
        with Database(data_root) as database:
            for service_date in reversed(database.stored_dates(start.isoformat(), end.isoformat())):
                reports.append(build_report_data(database, service_date, False, persist=False))
        totals = {"potentialClaims": 0, "needsReview": 0, "claimed": 0, "noClaim": 0, "incompleteDays": 0}
        for report in reports:
            for key in ("potentialClaims", "needsReview", "claimed", "noClaim"):
                totals[key] += report["summary"][key]
            totals["incompleteDays"] += int(not report["sourceComplete"])
        return jsonify({"from": start.isoformat(), "to": end.isoformat(), "summary": totals, "days": reports})

    @app.get("/api/export.json")
    def export_json():
        return dashboard()

    @app.get("/api/refresh-plan")
    def get_refresh_plan():
        return jsonify(refresh_plan(data_root, int(request.args.get("days", "10"))))

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

    @app.delete("/api/services/<path:service_id>/claim")
    def undo_claim(service_id: str):
        _require_same_origin()
        with Database(data_root) as database:
            service = database.service_by_id(service_id)
        if not service:
            return jsonify({"error": "Service not found"}), 404
        set_claim(data_root, service["serviceDate"], service_id, True)
        return jsonify({"status": "RESTORED"})

    return app
