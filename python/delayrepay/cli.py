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
    daily.add_argument("--lookback-days", type=int, default=10)
    commands.add_parser("gmail-authorize", help="Authorize read-only Gmail claim reconciliation")
    reconcile = commands.add_parser("gmail-reconcile", help="Reconcile operator claim emails")
    reconcile.add_argument("--lookback-days", type=int, default=90)
    backup = commands.add_parser("backup", help="Create a consistent SQLite backup")
    backup.add_argument("--keep", type=int, default=30)
    return root


def lookback_dates(end_date: str, days: int, latest_per_weekday: bool = False) -> list[str]:
    if days < 1:
        raise ValueError("Lookback days must be at least 1")
    end = date.fromisoformat(end_date)
    dates = [end - timedelta(days=offset) for offset in range(days)]
    weekdays = [value for value in dates if value.weekday() < 5]
    if latest_per_weekday:
        selected: dict[int, date] = {}
        for value in weekdays:
            selected.setdefault(value.weekday(), value)
        weekdays = list(selected.values())
    return sorted(value.isoformat() for value in weekdays)


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
        elif args.command == "backup":
            from .backup import backup_database
            print(f"Backup: {backup_database(root, args.keep)}")
        return 0
    except (ValueError, RttError, CollectionBusyError) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 2
