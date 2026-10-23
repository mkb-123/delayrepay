from __future__ import annotations

import argparse
import json
import logging
import sys
from datetime import date, timedelta
from pathlib import Path

from .config import data_dir, load_env
from .ingestion.rtt import RttClient, RttError
from .storage.sqlite import Database, catalogue_path, read_json
from .refresh import CollectionBusyError, CollectionLock
from .workflows import collect, discover, discover_cached, generate_report, report_lookback, report_week, set_claim


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(prog="delayrepay", description="MKC-EUS Delay Repay briefing tool")
    commands = root.add_subparsers(dest="command", required=True)
    for name in ("discover", "collect", "report"):
        command = commands.add_parser(name)
        command.add_argument("--date", required=name != "report", help="Service date (YYYY-MM-DD)")
        command.add_argument("--lookback-days", "--lookup-days", dest="lookback_days", type=int, help="Process this many calendar days ending on --date")
        if name == "discover":
            command.add_argument("--from-cache", action="store_true", help="Use retained RTT observations; makes no API calls")
            command.add_argument("--direction", choices=("morning", "evening", "all"), default="all")
        if name == "collect":
            command.add_argument("--dry-run", action="store_true", help="Show exact RTT service requests without calling RTT")
        if name == "report":
            command.add_argument("--action-only", action="store_true", help="Show only potential claims and items needing review")
    commands.add_parser("catalogue")
    weekly = commands.add_parser("report-week")
    weekly.add_argument("--week-start", required=True)
    weekly.add_argument("--action-only", action="store_true")
    claim = commands.add_parser("claim")
    claim.add_argument("--date", required=True)
    claim.add_argument("--service", required=True)
    claim.add_argument("--undo", action="store_true")
    serve = commands.add_parser("serve", help="Run the private local dashboard")
    serve.add_argument("--host", help="Listener address (default: DELAYREPAY_HOST or 127.0.0.1)")
    serve.add_argument("--port", type=int, help="Listener port (default: DELAYREPAY_PORT or 8765)")
    email = commands.add_parser("email-summary", help="Email outstanding claim suggestions")
    email.add_argument("--date", help="Last date included; defaults to the latest weekday")
    email.add_argument("--lookback-days", type=int, default=10)
    email.add_argument("--to", help="Recipient; defaults to DELAYREPAY_EMAIL_TO")
    email.add_argument("--dry-run", action="store_true", help="Print the email without sending it")
    daily = commands.add_parser("daily-brief", help="Collect and report the scheduled lookback window")
    daily.add_argument("--date", help="Window end date; defaults to the latest weekday")
    daily.add_argument("--lookback-days", type=int, default=14)
    commands.add_parser("gmail-authorize", help="Authorize read-only Gmail claim reconciliation")
    reconcile = commands.add_parser("gmail-reconcile", help="Reconcile operator claim emails")
    reconcile.add_argument("--lookback-days", type=int, default=90)
    commands.add_parser("gmail-ingest", help="Reconcile operator emails supplied as JSON on stdin (id, sender, subject, text, internalDate)")
    backup = commands.add_parser("backup", help="Create a consistent SQLite backup")
    backup.add_argument("--keep", type=int, default=30)
    alerts = commands.add_parser("alerts", help="Email an alert if something needs attention (run hourly)")
    alerts.add_argument("--dry-run", action="store_true", help="Show what would be sent without sending")
    alerts.add_argument("--test", action="store_true", help="Send a test email")
    queue = commands.add_parser("queue", help="Manage the claim queue")
    queue.add_argument("action", choices=("list", "add", "retry", "remove", "ignore"))
    queue.add_argument("--service-id")
    queue.add_argument("--operator", choices=("VT", "LM"))
    queue.add_argument("--date", help="Service date (YYYY-MM-DD)")
    queue.add_argument("--time", help="Scheduled departure (HH:MM)")
    record = commands.add_parser("record-claim", help="Record a claim submitted in a browser outside the worker")
    record.add_argument("--operator", required=True, choices=("VT", "LM"))
    record.add_argument("--date", required=True, help="Service date (YYYY-MM-DD)")
    record.add_argument("--time", required=True, help="Scheduled departure (HH:MM)")
    record.add_argument("--reference", required=True, help="Operator claim reference, e.g. AWC-1234-567-890")
    return root


def lookback_dates(end_date: str, days: int, latest_per_weekday: bool = False) -> list[str]:
    if days < 1:
        raise ValueError("Lookback days must be at least 1")
    end = date.fromisoformat(end_date)
    dates = [end - timedelta(days=offset) for offset in range(days)]
    if latest_per_weekday:
        selected: dict[int, date] = {}
        for value in dates:
            selected.setdefault(value.weekday(), value)
        dates = list(selected.values())
    return sorted(value.isoformat() for value in dates)


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8")
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
    )
    load_env()
    args = parser().parse_args(argv)
    root = data_dir()
    load_env(root / "secrets" / "operator-accounts.env")
    try:
        if args.command == "discover":
            direction = args.direction.upper()
            dates = lookback_dates(args.date, args.lookback_days, True) if args.lookback_days else [args.date]
            client = None if args.from_cache else RttClient()
            total = 0
            for service_date in dates:
                found = discover_cached(root, service_date, direction) if args.from_cache else discover(root, service_date, client, direction)
                total += len(found)
                print(f"{service_date}: discovered {len(found)} relevant services.")
            print(f"Discovered {total} services across {len(dates)} weekday catalogue snapshots. Catalogue: {catalogue_path(root)}")
        elif args.command == "collect":
            dates = lookback_dates(args.date, args.lookback_days) if args.lookback_days else [args.date]
            client = None if args.dry_run else RttClient()
            if args.dry_run:
                results = [collect(root, service_date, client, True) for service_date in dates]
            else:
                with CollectionLock(root):
                    results = [collect(root, service_date, client, False) for service_date in dates]
            if args.dry_run:
                print(json.dumps({"dates": results, "requestCount": sum(item["requestCount"] for item in results)}, indent=2))
            else:
                for service_date, value in zip(dates, results):
                    print(f"{service_date}: stored {len(value['services'])} services; {len(value['errors'])} errors.")
        elif args.command == "report":
            if args.lookback_days:
                print(report_lookback(root, args.date or date.today().isoformat(), args.lookback_days, args.action_only))
            elif args.date:
                print(generate_report(root, args.date, args.action_only))
            else:
                raise ValueError("--date is required unless --lookback-days is supplied")
        elif args.command == "catalogue":
            value = read_json(catalogue_path(root))
            if not value:
                raise ValueError("No service catalogue. Run discover first.")
            print(json.dumps(value, indent=2))
        elif args.command == "report-week":
            print(report_week(root, args.week_start, args.action_only))
        elif args.command == "claim":
            set_claim(root, args.date, args.service, args.undo)
            print("Claim acknowledgement removed." if args.undo else "Marked as claimed. This does not submit a claim.")
        elif args.command == "serve":
            import os
            from logging.handlers import RotatingFileHandler
            from waitress import serve
            from .web import create_app

            host = args.host or os.environ.get("DELAYREPAY_HOST", "127.0.0.1")
            port = args.port or int(os.environ.get("DELAYREPAY_PORT", "8765"))
            log_dir = Path(os.environ.get("DELAYREPAY_LOG_DIR", str(root / "logs")))
            log_dir.mkdir(parents=True, exist_ok=True)
            handler = RotatingFileHandler(log_dir / "server.log", maxBytes=5 * 1024 * 1024, backupCount=3, encoding="utf-8")
            handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
            logging.getLogger().addHandler(handler)
            logging.getLogger("delayrepay").info("Dashboard listening on http://%s:%d", host, port)
            serve(create_app(root), host=host, port=port, threads=4)
        elif args.command == "email-summary":
            from .emailing import build_summary, send_summary
            from .scheduled import latest_weekday

            end_date = args.date or latest_weekday().isoformat()
            with Database(root) as database:
                if args.dry_run:
                    subject, plain, _markup = build_summary(database, end_date, args.lookback_days)
                    print(subject)
                    print(plain)
                else:
                    subject = send_summary(database, end_date, args.lookback_days, args.to)
                    print(f"Sent: {subject}")
        elif args.command == "daily-brief":
            from .scheduled import run_daily_brief

            result = run_daily_brief(root, date.fromisoformat(args.date) if args.date else None, args.lookback_days)
            print(json.dumps(result, indent=2))
        elif args.command == "gmail-authorize":
            from .gmail_reconcile import authorize
            print(f"Gmail authorized. Token: {authorize()}")
        elif args.command == "gmail-reconcile":
            from .gmail_reconcile import reconcile
            with Database(root) as database:
                print(json.dumps(reconcile(database, args.lookback_days), indent=2))
        elif args.command == "gmail-ingest":
            from .gmail_reconcile import ingest_messages
            messages = json.load(sys.stdin)
            with Database(root) as database:
                print(json.dumps(ingest_messages(database, messages), indent=2))
        elif args.command == "backup":
            from .backup import backup_database
            print(f"Backup: {backup_database(root, args.keep)}")
        elif args.command == "alerts":
            from .alerts import run as run_alerts
            print(json.dumps(run_alerts(root, args.dry_run, args.test)))
        elif args.command == "queue":
            from datetime import datetime, timezone
            with Database(root) as database:
                if args.action == "list":
                    rows = database.connection.execute(
                        "SELECT service_id, operator_code, state, substr(coalesce(last_error, ''), 1, 90) AS error FROM claim_submissions "
                        "WHERE state != 'SUBMITTED' ORDER BY queued_at").fetchall()
                    print("\n".join(f"{r['state']:<16} {r['operator_code']} {r['service_id'].split(':', 1)[1]} {r['error']}" for r in rows) or "Queue is empty.")
                else:
                    service_id = args.service_id or database.find_service_id(args.date, args.time, args.operator)
                    service = database.service_by_id(service_id)
                    if not service:
                        raise ValueError(f"No such service: {service_id}")
                    now = datetime.now(timezone.utc).isoformat()
                    if args.action in ("add", "retry"):
                        if database.claim_lifecycle(service_id):
                            raise ValueError("This journey already has an operator claim.")
                        database.queue_claim_submission(service_id, service["operatorCode"], now, "SUBMIT")
                    elif args.action == "remove":
                        database.cancel_claim_submission(service_id)
                    else:  # ignore: take it out of the queue and stop suggesting it
                        database.cancel_claim_submission(service_id)
                        database.set_not_claimable(service_id, now)
                    print(f"{args.action}: {service_id}")
        elif args.command == "record-claim":
            from datetime import datetime, timezone
            with Database(root) as database:
                service_id = database.find_service_id(args.date, args.time, args.operator)
                database.record_submitted_claim(service_id, args.operator, datetime.now(timezone.utc).isoformat(), args.reference)
            print(f"Recorded {args.reference} for {service_id}.")
        return 0
    except (ValueError, RttError, CollectionBusyError) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 2
