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


def build_summary(database: Database, end_date: str, lookback_days: int) -> tuple[str, str, str]:
    end = date.fromisoformat(end_date)
    start = end - timedelta(days=lookback_days - 1)
    suggestions: list[dict] = []
    decisions: list[dict] = []
    for service_date in database.stored_dates(start.isoformat(), end.isoformat()):
        report = build_report_data(database, service_date, False, persist=False)
        if report.get("acknowledgedAt"):
            continue
        for item in report.get("recommendations", []):
            row = {"date": service_date, **item}
            if item["status"] == "POTENTIAL":
                suggestions.append(row)
            elif item["status"] == "NEEDS_REVIEW":
                decisions.append(row)

    subject = f"Delay Repay: {len(suggestions)} to claim, {len(decisions)} to decide"
    plain = [subject, ""]
    markup = [f"<h2>{html.escape(subject)}</h2>"]

    def add_section(title: str, rows: list[dict]) -> None:
        plain.extend([title, ""])
        markup.append(f"<h3>{html.escape(title)}</h3>")
        if not rows:
            plain.extend(["None", ""])
            markup.append("<p>None</p>")
            return
        markup.append("<ul>")
        for item in rows:
            direction = "Morning" if item["direction"] == "MORNING" else "Evening"
            delay = "" if item.get("effectiveDelayMinutes") is None else f" — {item['effectiveDelayMinutes']} min"
            line = f"{item['date']} · {direction} · {_clock(item.get('scheduledDeparture'))} · {item.get('operatorName', '')}{delay}"
            plain.append(line)
            markup.append(f"<li>{html.escape(line)}</li>")
        plain.append("")
        markup.append("</ul>")

    add_section("Claim", suggestions)
    add_section("Decide", decisions)
    plain.append("Open the local dashboard to mark each item.")
    markup.append("<p>Open the local dashboard to mark each item.</p>")
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
