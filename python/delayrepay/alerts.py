"""Email an alert when something needs attention; stay silent otherwise.

Runs on the Pi (cron). It reuses scripts/status.mjs --alerts so there is one definition of "needs you".
An email is sent only when the set of problems changes, or once a day while they persist, and a short
"all clear" is sent when they go away.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .emailing import send_plain
from .storage.sqlite import Database

REPO = Path(__file__).resolve().parents[2]


def collect_alerts(dashboard_url: str) -> list[str]:
    data = urllib.request.urlopen(dashboard_url.rstrip("/") + "/api/dashboard", timeout=30).read()
    node = shutil.which("node") or "/usr/bin/node"
    done = subprocess.run([node, str(REPO / "scripts" / "status.mjs"), "--alerts"], input=data, capture_output=True, timeout=60, check=True)
    return [line[len("ALERT: "):] for line in done.stdout.decode().splitlines() if line.startswith("ALERT: ")]


def run(root: Path, dry_run: bool = False, test: bool = False) -> dict[str, object]:
    dashboard = os.environ.get("DELAYREPAY_DASHBOARD_LOCAL", "http://127.0.0.1:8765")
    url = os.environ.get("DELAYREPAY_DASHBOARD_URL", "http://delayrepay.local")
    if test:
        send_plain("Delay Repay: test alert", f"This is a test of the alert email.\nDashboard: {url}")
        return {"sent": "test"}
    alerts = collect_alerts(dashboard)
    digest = hashlib.sha256("\n".join(sorted(alerts)).encode()).hexdigest() if alerts else ""
    now = datetime.now(timezone.utc)
    with Database(root) as database:
        previous = database.metadata_value("alerts_last_digest") or ""
        sent_at = database.metadata_value("alerts_last_sent")
        overdue = not sent_at or now - datetime.fromisoformat(sent_at) > timedelta(hours=24)
        if alerts and (digest != previous or overdue):
            subject = f"Delay Repay: {len(alerts)} thing{'s' if len(alerts) != 1 else ''} need{'' if len(alerts) != 1 else 's'} you"
            body = "\n".join(f"- {line}" for line in alerts) + f"\n\nDashboard: {url}"
            action = "alert"
        elif not alerts and previous:
            subject, body, action = "Delay Repay: all clear", f"Everything is back to normal.\n\nDashboard: {url}", "clear"
        else:
            return {"alerts": alerts, "sent": None}
        if not dry_run:
            send_plain(subject, body)
            database.set_metadata_value("alerts_last_digest", digest)
            database.set_metadata_value("alerts_last_sent", now.isoformat())
        return {"alerts": alerts, "sent": None if dry_run else action, "wouldSend": action if dry_run else None}
