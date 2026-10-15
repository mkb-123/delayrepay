from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any


PORTALS = {
    "VT": "https://delayrepay.avantiwestcoast.co.uk/",
    "LM": "https://londonnorthwesternrailway.delayrepaycompensation.com/index.cfm?action=myclaims.add",
}


class ClaimBrowserError(RuntimeError):
    state = "NEEDS_ATTENTION"


class LoginRequired(ClaimBrowserError):
    state = "NEEDS_LOGIN"


@dataclass
class SubmissionResult:
    reference: str | None


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


def login(root: Path, operator_code: str) -> None:
    if operator_code not in PORTALS:
        raise ValueError(f"Unsupported operator: {operator_code}")
    with _playwright()() as playwright:
        context = playwright.chromium.launch_persistent_context(
            str(profile_dir(root, operator_code)), headless=False,
        )
        page = context.pages[0] if context.pages else context.new_page()
        page.goto(PORTALS[operator_code], wait_until="domcontentloaded")
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


def submit(root: Path, service: dict[str, Any]) -> SubmissionResult:
    operator_code = service["operatorCode"]
    if operator_code not in PORTALS:
        raise ClaimBrowserError(f"No claim browser is configured for operator {operator_code}.")
    screenshots = root / "claim-screenshots"
    screenshots.mkdir(parents=True, exist_ok=True)
    safe_id = re.sub(r"[^A-Za-z0-9_.-]", "_", service["serviceId"])
    with _playwright()() as playwright:
        context = playwright.chromium.launch_persistent_context(
            str(profile_dir(root, operator_code)), headless=True,
        )
        page = context.pages[0] if context.pages else context.new_page()
        try:
            page.goto(PORTALS[operator_code], wait_until="domcontentloaded", timeout=60_000)
            if _looks_logged_out(page):
                raise LoginRequired(f"{service['operatorName']} login has expired. Run claim-login for {operator_code}.")

            departure = service["scheduledDeparture"]
            arrival = service.get("actualArrival") or service.get("scheduledArrival")
            values_filled = 0
            values_filled += _fill_label(page, [r"date.*journey", r"travel date", r"departure date"], service["serviceDate"])
            values_filled += _fill_label(page, [r"from", r"origin", r"departure station"], "Milton Keynes Central" if service["origin"] == "MKC" else "London Euston")
            values_filled += _fill_label(page, [r"to", r"destination", r"arrival station"], "London Euston" if service["destination"] == "EUS" else "Milton Keynes Central")
            values_filled += _fill_label(page, [r"scheduled departure", r"departure time"], departure[11:16])
            if arrival:
                values_filled += _fill_label(page, [r"actual arrival", r"arrival time"], arrival[11:16])
            _choose_saved_ticket(page)
            if values_filled < 3:
                raise ClaimBrowserError("The operator changed its claim form; journey fields could not be identified.")

            for _ in range(6):
                submit_button = page.get_by_role("button", name=re.compile(r"submit( claim)?$", re.I)).first
                if submit_button.count() and submit_button.is_visible():
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
            return SubmissionResult(reference_match.group(1).upper() if reference_match else None)
        except ClaimBrowserError:
            page.screenshot(path=str(screenshots / f"{safe_id}.png"), full_page=True)
            raise
        except Exception as error:
            page.screenshot(path=str(screenshots / f"{safe_id}.png"), full_page=True)
            raise ClaimBrowserError(f"Browser submission failed: {type(error).__name__}") from error
        finally:
            context.close()

