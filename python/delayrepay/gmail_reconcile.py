from __future__ import annotations

import base64
import html
import logging
import os
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from email.utils import parseaddr
from pathlib import Path
from typing import Any

from .storage.sqlite import Database

LOGGER = logging.getLogger(__name__)
SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"]
SENDERS = {
    "noreplyavantiwestcoastdr@firstcustomercontact.com": "VT",
    "noreply_londonnorthwesternrailway@delayrepaycompensation.com": "LM",
}
PARSER_VERSION = "gmail-rules-v1"


@dataclass
class ParsedClaim:
    operator_code: str
    claim_reference: str | None
    outcome: str | None
    travel_date: str | None
    departure_time: str | None
    origin: str | None
    destination: str | None


def _oauth_paths() -> tuple[Path, Path]:
    client = Path(os.environ.get("GMAIL_OAUTH_CLIENT_FILE", "gmail-oauth-client.json"))
    token = Path(os.environ.get("GMAIL_OAUTH_TOKEN_FILE", "gmail-oauth-token.json"))
    return client, token


def authorize() -> Path:
    from google_auth_oauthlib.flow import InstalledAppFlow

    client, token = _oauth_paths()
    if not client.exists():
        raise ValueError(f"Gmail OAuth client file not found: {client}")
    credentials = InstalledAppFlow.from_client_secrets_file(str(client), SCOPES).run_local_server(port=0)
    token.parent.mkdir(parents=True, exist_ok=True)
    token.write_text(credentials.to_json(), encoding="utf-8")
    try:
        token.chmod(0o600)
    except OSError:
        pass
    return token


def _gmail_service() -> Any:
    from google.auth.transport.requests import Request
    from google.oauth2.credentials import Credentials
    from googleapiclient.discovery import build

    _client, token = _oauth_paths()
    if not token.exists():
        raise ValueError("Gmail is not authorized. Run: delayrepay gmail-authorize")
    credentials = Credentials.from_authorized_user_file(str(token), SCOPES)
    if credentials.expired and credentials.refresh_token:
        credentials.refresh(Request())
        token.write_text(credentials.to_json(), encoding="utf-8")
    if not credentials.valid:
        raise ValueError("Gmail OAuth token is invalid. Run: delayrepay gmail-authorize")
    return build("gmail", "v1", credentials=credentials, cache_discovery=False)


def _parts(payload: dict[str, Any]) -> list[dict[str, Any]]:
    result = [payload]
    for part in payload.get("parts", []):
        result.extend(_parts(part))
    return result


def _message_text(payload: dict[str, Any]) -> str:
    values: list[str] = []
    for part in _parts(payload):
        if part.get("mimeType") not in {"text/plain", "text/html"}:
            continue
        encoded = part.get("body", {}).get("data")
        if not encoded:
            continue
        value = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)).decode("utf-8", "replace")
        if part.get("mimeType") == "text/html":
            value = re.sub(r"<[^>]+>", " ", value)
            value = html.unescape(value)
        values.append(value)
    return re.sub(r"\s+", " ", " ".join(values)).strip()


def _header(payload: dict[str, Any], name: str) -> str:
    return next((item.get("value", "") for item in payload.get("headers", []) if item.get("name", "").lower() == name.lower()), "")


def _iso_date(value: str) -> str | None:
    for pattern in ("%a, %d %b %Y", "%d %b %Y", "%d/%m/%Y"):
        try:
            return datetime.strptime(value.strip(), pattern).date().isoformat()
        except ValueError:
            pass
    return None


def parse_claim(sender: str, subject: str, text: str) -> ParsedClaim | None:
    operator = SENDERS.get(parseaddr(sender)[1].lower())
    if not operator:
        return None
    combined = f"{subject} {text}"
    reference_match = re.search(r"(?:Claim Reference:|Claim |Reference)\s*((?:AWC-[\d-]+)|(?:LNR/DR/[A-Z0-9/]+))", combined, re.I)
    date_match = re.search(r"Travel Date:\s*((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s*\d{1,2}\s+[A-Za-z]+\s+\d{4})", combined, re.I)
    if not date_match:
        date_match = re.search(r"\bon\s+(\d{1,2}/\d{1,2}/\d{4})\s+at\s+\d{1,2}:\d{2}", combined, re.I)
    departing = re.search(r"Departing:\s*(\d{1,2}:\d{2})\s+from\s+(MILTON KEYNES CENTRAL|LONDON EUSTON)\s+to\s+(MILTON KEYNES CENTRAL|LONDON EUSTON)", combined, re.I)
    if not departing:
        departing = re.search(r"From\s+(MILTON KEYNES CENTRAL|LONDON EUSTON)\s+to\s+(MILTON KEYNES CENTRAL|LONDON EUSTON)\s+on\s+\d{1,2}/\d{1,2}/\d{4}\s+at\s+(\d{1,2}:\d{2})", combined, re.I)
        time, origin, destination = (departing.group(3), departing.group(1), departing.group(2)) if departing else (None, None, None)
    else:
        time, origin, destination = departing.group(1), departing.group(2), departing.group(3)
    if not departing:
        between = re.search(r"journey between\s+(MILTON KEYNES CENTRAL|LONDON EUSTON)\s+and\s+(MILTON KEYNES CENTRAL|LONDON EUSTON)\s+on\s+\d{1,2}/\d{1,2}/\d{4}\s+at\s+(\d{1,2}:\d{2})", combined, re.I)
        if between:
            time, origin, destination = between.group(3), between.group(1), between.group(2)
    lower = combined.lower()
    if "payment sent" in lower or re.search(r"payment .* (?:is|has been) (?:now )?(?:sent|issued|on its way)", lower):
        outcome = "PAID"
    elif " - approved" in subject.lower() or re.search(r"claim has been approved|pleased to say.*claim has been approved", lower):
        outcome = "APPROVED"
    elif any(value in lower for value in ("decision: unsuccessful", "claim has been declined", "not been able to approve", "claim was also declined")):
        outcome = "REJECTED"
    elif any(value in lower for value in ("thank you for submitting", "with our team for processing", "currently being processed", "in progress")):
        outcome = "SUBMITTED"
    else:
        outcome = None
    return ParsedClaim(operator, reference_match.group(1) if reference_match else None, outcome, _iso_date(date_match.group(1)) if date_match else None, time, origin, destination)


def _match_service(database: Database, claim: ParsedClaim) -> tuple[str | None, str]:
    if claim.claim_reference:
        recorded = database.service_id_for_reference(claim.claim_reference)
        if recorded:
            return recorded, f"Matched by claim reference {claim.claim_reference} recorded when the claim was submitted."
    if not claim.travel_date or not claim.departure_time or not claim.origin or not claim.destination:
        return None, "Email lacks a complete travel date, departure time, or route."
    candidates = database.services_between(claim.travel_date, claim.travel_date)
    candidates = [service for service in candidates if service.get("operatorCode") == claim.operator_code and service.get("scheduledDeparture", "")[11:16] == claim.departure_time and service.get("origin") == ("MKC" if claim.origin.upper().startswith("MILTON") else "EUS") and service.get("destination") == ("MKC" if claim.destination.upper().startswith("MILTON") else "EUS")]
    if len(candidates) == 1:
        return candidates[0]["serviceId"], f"Matched {claim.travel_date} {claim.departure_time} and route to one stored service."
    if not candidates:
        return None, "No stored monitored service matches the email journey."
    return None, "More than one stored service matches the email journey."


def reconcile(database: Database, lookback_days: int = 90) -> dict[str, Any]:
    service = _gmail_service()
    previous = database.metadata_value("last_gmail_reconciliation")
    start = datetime.fromisoformat(previous) - timedelta(days=1) if previous else datetime.now(timezone.utc) - timedelta(days=lookback_days)
    query = f"after:{int(start.timestamp())} -in:spam -in:trash {{from:{list(SENDERS)[0]} from:{list(SENDERS)[1]}}}"
    message_ids: list[str] = []
    page_token = None
    while True:
        response = service.users().messages().list(userId="me", q=query, maxResults=100, pageToken=page_token).execute()
        message_ids.extend(item["id"] for item in response.get("messages", []))
        page_token = response.get("nextPageToken")
        if not page_token:
            break
    counts = {"checked": len(message_ids), "stored": 0, "matched": 0, "review": 0, "excluded": 0}
    for message_id in message_ids:
        message = service.users().messages().get(userId="me", id=message_id, format="full").execute()
        payload = message.get("payload", {})
        process_message(database, counts, message_id, _header(payload, "From"), _header(payload, "Subject"),
                        _message_text(payload), int(message["internalDate"]))
    database.set_last_gmail_reconciliation(datetime.now(timezone.utc).isoformat())
    return counts


def process_message(database: Database, counts: dict[str, int], message_id: str, sender: str, subject: str,
                    text: str, internal_date_ms: int) -> None:
    """Parse one operator email, match it to a stored service, and save the event (idempotent by message id)."""
    claim = parse_claim(sender, subject, text)
    if not claim or not claim.outcome:
        return
    service_id, explanation = _match_service(database, claim)
    confidence = "CERTAIN" if service_id else "REVIEW"
    outcome = claim.outcome if service_id else "NEEDS_REVIEW"
    received_at = datetime.fromtimestamp(internal_date_ms / 1000, timezone.utc).isoformat()
    existed = database.connection.execute(
        "SELECT 1 FROM claim_email_events WHERE gmail_message_id=?", (message_id,)
    ).fetchone() is not None
    database.save_claim_email_event(gmail_message_id=message_id, service_id=service_id, operator_code=claim.operator_code, claim_reference=claim.claim_reference, outcome=outcome, received_at=received_at, confidence=confidence, explanation=explanation, parser_version=PARSER_VERSION)
    counts["stored"] += int(not existed)
    counts["matched" if service_id else "excluded"] += 1


def ingest_messages(database: Database, messages: list[dict[str, Any]]) -> dict[str, Any]:
    """Reconcile messages fetched elsewhere (for example through an approved Gmail connector).

    Each message: {"id", "sender", "subject", "text", "internalDate"} with internalDate in milliseconds.
    Bodies are parsed in memory and never stored. The reconciliation time is recorded only after every write succeeds.
    """
    counts = {"checked": len(messages), "stored": 0, "matched": 0, "review": 0, "excluded": 0}
    for item in messages:
        process_message(database, counts, item["id"], item["sender"], item.get("subject", ""), item.get("text", ""), int(item["internalDate"]))
    database.set_last_gmail_reconciliation(datetime.now(timezone.utc).isoformat())
    return counts
