from __future__ import annotations

from datetime import date, timedelta
from email.message import EmailMessage
import html
import os
import smtplib

from .storage.sqlite import Database
from .workflows import build_report_data


def _clock(value: str | None) -> str:
    return value[11:16] if value else "—"


def _display_date(value: str) -> str:
    parsed = date.fromisoformat(value)
    return f"{parsed.strftime('%a')} {parsed.day} {parsed.strftime('%b')}"


def build_summary(database: Database, end_date: str, lookback_days: int) -> tuple[str, str, str]:
    end = date.fromisoformat(end_date)
    start = end - timedelta(days=lookback_days - 1)
    suggestions: list[dict] = []
    decisions: list[dict] = []
    handled: list[dict] = []
    for service_date in database.stored_dates(start.isoformat(), end.isoformat()):
        report = build_report_data(database, service_date, False, persist=False)
        if report.get("acknowledgedAt"):
            continue
        services = {item["serviceId"]: item for item in report.get("services", [])}
        for item in report.get("recommendations", []):
            service = services.get(item.get("serviceId"), {})
            assessment = service.get("assessment", {})
            row = {"date": service_date, "reason": assessment.get("explanation", item.get("explanation")), **item}
            if item["status"] == "POTENTIAL":
                suggestions.append(row)
            elif item["status"] == "NEEDS_REVIEW":
                decisions.append(row)
            elif item["status"] == "CLAIMED":
                handled.append(row)

    subject = f"Delay Repay: {len(suggestions)} to claim, {len(decisions)} to decide"
    plain = [subject, ""]
    markup = [
        '<div style="font-family:Arial,sans-serif;max-width:620px;margin:auto;color:#17201d">',
        '<div style="background:#153e34;color:white;padding:18px 20px;border-radius:12px">',
        '<div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#bdd6cd">MKC ↔ EUS</div>',
        f'<h2 style="margin:6px 0 0;font-size:22px">{html.escape(subject)}</h2></div>',
    ]

    def add_section(title: str, rows: list[dict], colour: str, action_label: str | None = None) -> None:
        plain.extend([title, ""])
        markup.append(f'<h3 style="margin:22px 2px 9px;font-size:17px">{html.escape(title)}</h3>')
        if not rows:
            plain.extend(["None", ""])
            markup.append('<p style="color:#68736d;margin:0 2px">None</p>')
            return
        for item in rows:
            direction = "Morning" if item["direction"] == "MORNING" else "Evening"
            delay = "" if item.get("effectiveDelayMinutes") is None else f" — {item['effectiveDelayMinutes']} min"
            line = f"{_display_date(item['date'])} · {direction} · {_clock(item.get('scheduledDeparture'))} · {item.get('operatorName', '')}{delay}"
            reason = item.get("reason") or item.get("explanation") or ""
            plain.extend([line, f"  {reason}"])
            if action_label and item.get("claimUrl"):
                plain.append(f"  {action_label}: {item['claimUrl']}")
            markup.extend([
                f'<div style="border:1px solid #dce2de;border-left:5px solid {colour};border-radius:9px;padding:12px 14px;margin:0 0 9px;background:#fff">',
                f'<div style="font-weight:700">{html.escape(line)}</div>',
                f'<div style="font-size:13px;color:#59645f;margin-top:5px;line-height:1.4">{html.escape(reason)}</div>',
            ])
            if action_label and item.get("claimUrl"):
                markup.append(f'<a href="{html.escape(item["claimUrl"], quote=True)}" style="display:inline-block;margin-top:10px;background:#176b55;color:white;text-decoration:none;padding:8px 11px;border-radius:7px;font-weight:700;font-size:13px">{html.escape(action_label)} →</a>')
            markup.append("</div>")
        plain.append("")

    add_section("Claim", suggestions, "#dfb833", "Open claim page")
    add_section("Decide", decisions, "#cf7440", "Open operator page")
    add_section("Already handled", handled, "#168354")
    dashboard_url = os.environ.get("DELAYREPAY_DASHBOARD_URL")
    if dashboard_url:
        plain.append(f"Dashboard: {dashboard_url}")
        markup.append(f'<p style="margin-top:22px"><a href="{html.escape(dashboard_url, quote=True)}" style="color:#176b55;font-weight:700">Open Delay Repay dashboard →</a></p>')
    else:
        plain.append("Open the local dashboard to mark each item.")
        markup.append('<p style="margin-top:22px">Open the local dashboard to mark each item.</p>')
    markup.append("</div>")
    return subject, "\n".join(plain), "".join(markup)


def send_summary(database: Database, end_date: str, lookback_days: int, recipient: str | None = None) -> str:
    recipient = recipient or os.environ.get("DELAYREPAY_EMAIL_TO")
    sender = os.environ.get("GMAIL_SMTP_USER")
    password = os.environ.get("GMAIL_APP_PASSWORD")
    if not recipient or not sender or not password:
        raise ValueError("Set DELAYREPAY_EMAIL_TO, GMAIL_SMTP_USER, and GMAIL_APP_PASSWORD in .env")
    subject, plain, markup = build_summary(database, end_date, lookback_days)
    message = EmailMessage()
    message["Subject"] = subject
    message["From"] = sender
    message["To"] = recipient
    message.set_content(plain)
    message.add_alternative(markup, subtype="html")
    with smtplib.SMTP("smtp.gmail.com", 587, timeout=30) as smtp:
        smtp.starttls()
        smtp.login(sender, password)
        smtp.send_message(message)
    return subject
