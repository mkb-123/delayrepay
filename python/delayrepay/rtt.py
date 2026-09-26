from __future__ import annotations

import json
import logging
import os
import time
from datetime import datetime, timezone
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

LOGGER = logging.getLogger("delayrepay.rtt")


class RttError(RuntimeError):
    pass


class RttClient:
    base_url = "https://data.rtt.io"

    def __init__(self) -> None:
        self.access_token = os.environ.get("RTT_ACCESS_TOKEN", "").strip()
        self.fixed_access_token = bool(self.access_token)
        self.refresh_token = os.environ.get("RTT_REFRESH_TOKEN", "").strip()
        self.api_version = os.environ.get("RTT_API_VERSION", "2026-07-25")
        self.interval = int(os.environ.get("RTT_MIN_INTERVAL_MS", "1500")) / 1000
        self.timeout = int(os.environ.get("RTT_REQUEST_TIMEOUT_MS", "15000")) / 1000
        self.next_request = 0.0
        self.access_expiry = 0.0
        if not self.access_token and not self.refresh_token:
            raise RttError("RTT is not configured; set RTT_ACCESS_TOKEN or RTT_REFRESH_TOKEN in .env")

    def _request(self, path: str, token: str, retries: int = 2) -> Any:
        wait = self.next_request - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        self.next_request = time.monotonic() + self.interval
        request = Request(
            self.base_url + path,
            headers={"Authorization": f"Bearer {token}", "Version": self.api_version, "Accept": "application/json"},
        )
        endpoint = path.split("?", 1)[0]
        LOGGER.info("RTT request: %s", endpoint)
        try:
            with urlopen(request, timeout=self.timeout) as response:
                LOGGER.info("RTT response: %s %s", endpoint, response.status)
                if response.status == 204:
                    return {"services": []}
                return json.load(response)
        except HTTPError as error:
            if error.code == 429 and retries:
                delay = int(error.headers.get("Retry-After", os.environ.get("RTT_RATE_LIMIT_WAIT_MS", "10000")))
                if delay > 1000:
                    delay /= 1000
                time.sleep(delay)
                LOGGER.warning("RTT rate limited; retrying %s after %.1f seconds", endpoint, delay)
                return self._request(path, token, retries - 1)
            if error.code == 404:
                raise RttError("RTT service not found") from error
            raise RttError(f"RTT request failed ({error.code})") from error
        except (URLError, TimeoutError, json.JSONDecodeError) as error:
            raise RttError("RTT network or response error") from error

    def _token(self) -> str:
        if self.fixed_access_token:
            return self.access_token
        if self.access_token and self.access_expiry > time.time() + 60:
            return self.access_token
        value = self._request("/api/get_access_token", self.refresh_token)
        try:
            self.access_token = value["token"]
            self.access_expiry = datetime.fromisoformat(value["validUntil"].replace("Z", "+00:00")).timestamp()
        except (KeyError, TypeError, ValueError) as error:
            raise RttError("RTT returned an invalid authentication response") from error
        return self.access_token

    def lineup(self, station: str, date: str, start: str, end: str) -> dict[str, Any]:
        query = urlencode({"code": f"gb-nr:{station}", "timeFrom": f"{date}T{start}:00", "timeTo": f"{date}T{end}:00", "timeTolerance": "false"})
        return self._request(f"/rtt/location?{query}", self._token())

    def service(self, unique_identity: str) -> dict[str, Any]:
        return self._request(f"/rtt/service?{urlencode({'uniqueIdentity': unique_identity})}", self._token())
