from __future__ import annotations

import re
import os
import shutil
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class OperatorAdapter:
    code: str
    version: str
    login_portal: str
    claim_portal: str
    date_labels: tuple[str, ...]
    origin_labels: tuple[str, ...]
    destination_labels: tuple[str, ...]
    departure_labels: tuple[str, ...]
    arrival_labels: tuple[str, ...]


ADAPTERS = {
    "VT": OperatorAdapter("VT", "avanti-2026-10", "https://delayrepay.avantiwestcoast.co.uk/", "https://delayrepay.avantiwestcoast.co.uk/", (r"date.*journey", r"travel date", r"departure date"), (r"from", r"origin", r"departure station"), (r"to", r"destination", r"arrival station"), (r"scheduled departure", r"departure time"), (r"actual arrival", r"arrival time")),
    "LM": OperatorAdapter("LM", "lnr-2026-10", "https://londonnorthwesternrailway.delayrepaycompensation.com/index.cfm?action=login.login", "https://londonnorthwesternrailway.delayrepaycompensation.com/index.cfm?action=myclaims.add", (r"date.*journey", r"travel date", r"departure date"), (r"from", r"origin", r"departure station"), (r"to", r"destination", r"arrival station"), (r"scheduled departure", r"departure time"), (r"actual arrival", r"arrival time")),
}


class ClaimBrowserError(RuntimeError):
    state = "NEEDS_ATTENTION"


class LoginRequired(ClaimBrowserError):
    state = "NEEDS_LOGIN"


@dataclass
class SubmissionResult:
    reference: str | None
    submitted: bool
    screenshot_path: str | None = None
    last_step: str | None = None


def _playwright():
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as error:
        raise ClaimBrowserError("Playwright is not installed. Re-run the Raspberry Pi installer.") from error
    return sync_playwright


def profile_dir(root: Path, operator_code: str) -> Path:
    value = root / "browser-profiles" / operator_code.lower()
    value.mkdir(parents=True, exist_ok=True)
    return value


def _launch_options() -> dict[str, str]:
    configured = os.environ.get("DELAYREPAY_CHROMIUM_PATH", "").strip()
    executable = configured or shutil.which("chromium") or shutil.which("chromium-browser")
    return {"executable_path": executable} if executable else {}


def _cookie_file(root: Path, operator_code: str) -> Path:
    return root / "secrets" / f"{operator_code.lower()}-cookies.json"


def _load_exported_cookies(context: Any, root: Path, operator_code: str) -> None:
    path = _cookie_file(root, operator_code)
    if not path.is_file():
        return
    cookies = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(cookies, list):
        raise ClaimBrowserError(f"Invalid cookie export for {operator_code}.")
    context.add_cookies(cookies)


def login(root: Path, operator_code: str) -> None:
    if operator_code not in ADAPTERS:
        raise ValueError(f"Unsupported operator: {operator_code}")
    with _playwright()() as playwright:
        context = playwright.chromium.launch_persistent_context(
            str(profile_dir(root, operator_code)), headless=False, **_launch_options(),
        )
        _load_exported_cookies(context, root, operator_code)
        page = context.pages[0] if context.pages else context.new_page()
        page.goto(ADAPTERS[operator_code].login_portal, wait_until="domcontentloaded")
        _fill_credentials(page, operator_code)
        input("Log in, complete any CAPTCHA, confirm the saved season ticket, then press Enter here...")
        context.close()


def _fill_label(page: Any, patterns: list[str], value: str) -> bool:
    for pattern in patterns:
        locator = page.get_by_label(re.compile(pattern, re.I)).first
        if locator.count() and locator.is_visible():
            try:
                locator.fill(value)
                return True
            except Exception:
                continue
    return False


def _choose_saved_ticket(page: Any) -> None:
    for pattern in (r"season ticket", r"saved ticket", r"ticket used"):
        locator = page.get_by_label(re.compile(pattern, re.I)).first
        if not locator.count() or not locator.is_visible():
            continue
        try:
            options = locator.locator("option")
            if options.count() > 1:
                locator.select_option(index=1)
                return
        except Exception:
            try:
                locator.click()
                return
            except Exception:
                pass


def _looks_logged_out(page: Any) -> bool:
    return bool(
        page.locator('input[type="password"]').count()
        or page.get_by_text(re.compile(r"log in to.*delay repay", re.I)).count()
        or page.get_by_text(re.compile(r"complete the recaptcha", re.I)).count()
    )


def _fill_credentials(page: Any, operator_code: str) -> bool:
    prefix = "AVANTI" if operator_code == "VT" else "LNR"
    email = os.environ.get(f"{prefix}_DELAY_REPAY_EMAIL", "").strip()
    password = os.environ.get(f"{prefix}_DELAY_REPAY_PASSWORD", "")
    if not email or not password:
        return False
    cookie_button = page.get_by_role("button", name=re.compile(r"cookie consent|accept", re.I)).first
    if cookie_button.count() and cookie_button.is_visible():
        try:
            cookie_button.click()
            page.wait_for_timeout(250)
        except Exception:
            pass
    email_field = page.get_by_label(re.compile(r"email(?: address)?", re.I)).first
    password_field = page.get_by_label(re.compile(r"password", re.I)).first
    if not email_field.count():
        email_field = page.locator('input[type="email"]').first
    if not password_field.count():
        password_field = page.locator('input[type="password"]').first
    if not email_field.count() or not password_field.count():
        return False
    email_field.fill(email)
    password_field.fill(password)
    return True


def _attempt_login(page: Any, operator_code: str) -> None:
    if not _looks_logged_out(page):
        return
    if not _fill_credentials(page, operator_code):
        raise LoginRequired(f"{operator_code} credentials are missing from operator-accounts.env.")
    if page.get_by_text(re.compile(r"complete the recaptcha", re.I)).count():
        raise LoginRequired(f"{operator_code} requires CAPTCHA. Run claim-login for this operator.")
    button = page.get_by_role("button", name=re.compile(r"log in|sign in", re.I)).first
    if not button.count() or not button.is_visible():
        raise LoginRequired(f"{operator_code} login form could not be submitted automatically.")
    button.click()
    page.wait_for_load_state("domcontentloaded")
    if _looks_logged_out(page):
        raise LoginRequired(f"{operator_code} login was not accepted or needs additional verification.")


def screenshot_path(root: Path, service: dict[str, Any]) -> Path:
    safe_id = re.sub(r"[^A-Za-z0-9_.-]", "_", service["serviceId"])
    return root / "claim-screenshots" / f"{safe_id}.png"


def check_session(root: Path, operator_code: str) -> tuple[str, str]:
    adapter = ADAPTERS[operator_code]
    with _playwright()() as playwright:
        context = playwright.chromium.launch_persistent_context(
            str(profile_dir(root, operator_code)), headless=True, **_launch_options(),
        )
        _load_exported_cookies(context, root, operator_code)
        page = context.pages[0] if context.pages else context.new_page()
        try:
            page.goto(adapter.login_portal, wait_until="domcontentloaded", timeout=60_000)
            _attempt_login(page, operator_code)
            return "LOGIN_OK", "Operator account opened successfully."
        except LoginRequired as error:
            return "LOGIN_NEEDED", str(error)
        except Exception as error:
            return "CHECK_FAILED", f"Session check failed: {type(error).__name__}"
        finally:
            context.close()


def submit(root: Path, service: dict[str, Any], mode: str = "CALIBRATE") -> SubmissionResult:
    operator_code = service["operatorCode"]
    if operator_code not in ADAPTERS:
        raise ClaimBrowserError(f"No claim browser is configured for operator {operator_code}.")
    adapter = ADAPTERS[operator_code]
    shot = screenshot_path(root, service)
    shot.parent.mkdir(parents=True, exist_ok=True)
    with _playwright()() as playwright:
        context = playwright.chromium.launch_persistent_context(
            str(profile_dir(root, operator_code)), headless=True, **_launch_options(),
        )
        _load_exported_cookies(context, root, operator_code)
        page = context.pages[0] if context.pages else context.new_page()
        try:
            page.goto(adapter.login_portal, wait_until="domcontentloaded", timeout=60_000)
            _attempt_login(page, operator_code)
            if adapter.claim_portal != adapter.login_portal:
                page.goto(adapter.claim_portal, wait_until="domcontentloaded", timeout=60_000)

            departure = service["scheduledDeparture"]
            arrival = service.get("actualArrival") or service.get("scheduledArrival")
            values_filled = 0
            values_filled += _fill_label(page, list(adapter.date_labels), service["serviceDate"])
            values_filled += _fill_label(page, list(adapter.origin_labels), "Milton Keynes Central" if service["origin"] == "MKC" else "London Euston")
            values_filled += _fill_label(page, list(adapter.destination_labels), "London Euston" if service["destination"] == "EUS" else "Milton Keynes Central")
            values_filled += _fill_label(page, list(adapter.departure_labels), departure[11:16])
            if arrival:
                values_filled += _fill_label(page, list(adapter.arrival_labels), arrival[11:16])
            _choose_saved_ticket(page)
            if values_filled < 3:
                raise ClaimBrowserError("The operator changed its claim form; journey fields could not be identified.")

            for _ in range(6):
                submit_button = page.get_by_role("button", name=re.compile(r"submit( claim)?$", re.I)).first
                if submit_button.count() and submit_button.is_visible():
                    if mode == "CALIBRATE":
                        page.screenshot(path=str(shot), full_page=True)
                        return SubmissionResult(None, False, shot.name, "Final confirmation")
                    submit_button.click()
                    page.wait_for_load_state("domcontentloaded")
                    break
                next_button = page.get_by_role("button", name=re.compile(r"continue|next", re.I)).first
                if not next_button.count() or not next_button.is_visible():
                    raise ClaimBrowserError("The claim form needs information that could not be completed automatically.")
                next_button.click()
                page.wait_for_load_state("domcontentloaded")

            content = page.locator("body").inner_text()
            reference_match = re.search(r"(?:claim|reference)(?: number| ref(?:erence)?)?\s*[:#]?\s*([A-Z]{2,5}[-/][A-Z0-9/-]{5,})", content, re.I)
            success = re.search(r"claim (?:has been |was )?(?:submitted|received)|thank you.*claim", content, re.I | re.S)
            if not success and not reference_match:
                raise ClaimBrowserError("The portal did not show a submission confirmation.")
            return SubmissionResult(reference_match.group(1).upper() if reference_match else None, True, None, "Submitted")
        except ClaimBrowserError:
            page.screenshot(path=str(shot), full_page=True)
            raise
        except Exception as error:
            page.screenshot(path=str(shot), full_page=True)
            raise ClaimBrowserError(f"Browser submission failed: {type(error).__name__}") from error
        finally:
            context.close()

