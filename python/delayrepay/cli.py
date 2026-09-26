from __future__ import annotations

import argparse
import json
import sys
from datetime import date

from .config import data_dir, load_env
from .rtt import RttClient, RttError
from .store import catalogue_path, read_json
from .workflows import collect, discover, generate_report, report_week, set_claim


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(prog="delayrepay", description="MKC-EUS Delay Repay briefing tool")
    commands = root.add_subparsers(dest="command", required=True)
    for name in ("discover", "collect", "report"):
        command = commands.add_parser(name)
        command.add_argument("--date", required=True, help="Service date (YYYY-MM-DD)")
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
    return root


def main(argv: list[str] | None = None) -> int:
    load_env()
    args = parser().parse_args(argv)
    root = data_dir()
    try:
        if args.command == "discover":
            found = discover(root, args.date, RttClient())
            print(f"Discovered {len(found)} relevant services. Catalogue: {catalogue_path(root)}")
        elif args.command == "collect":
            value = collect(root, args.date, None if args.dry_run else RttClient(), args.dry_run)
            print(json.dumps(value, indent=2) if args.dry_run else f"Stored {len(value['services'])} services for {args.date}; {len(value['errors'])} errors.")
        elif args.command == "report":
            text, _ = generate_report(root, args.date, args.action_only)
            print(text)
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
        return 0
    except (ValueError, RttError) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 2
