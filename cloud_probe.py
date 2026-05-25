"""One-shot probe of the AprilAire "Healthy Air" cloud (aprilaire.io).

Logs in with your Healthy Air app credentials, then dumps the account hierarchy
and each device's status/settings. Purpose: confirm the S86WMUPR thermostats live
in this cloud and discover their field schema (temp / setpoints / mode), so we can
build cloud-based read+control that leaves the phone app fully working.

Credentials come from .env (never hardcoded, never logged):
    APRILAIRE_CLOUD_EMAIL
    APRILAIRE_CLOUD_PASSWORD

Cognito config + endpoints are the same ones the Healthy Air Android app uses
(as mapped by the billda/ha-aprilaire-cloud project).

Usage:
    .venv/bin/python cloud_probe.py
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from typing import Any

from aiohttp import ClientSession, ClientTimeout
from dotenv import load_dotenv
from pycognito import Cognito

COGNITO_REGION = "us-west-2"
COGNITO_USER_POOL_ID = "us-west-2_skfkpmVv6"
COGNITO_CLIENT_ID = "3aiakr6qdoqtajv7qgtapecerg"
ACCOUNT_API = "https://account.aprilaire.io"
DEVICE_API = "https://device.aprilaire.io"

_REQUEST_TIMEOUT = ClientTimeout(total=20)
_MAX_DEVICES = 15
_POLITE_DELAY_S = 0.3


def _authenticate(email: str, password: str) -> str:
    """Authenticate against Cognito and return a bearer id_token (blocking)."""
    cognito = Cognito(
        user_pool_id=COGNITO_USER_POOL_ID,
        client_id=COGNITO_CLIENT_ID,
        user_pool_region=COGNITO_REGION,
        username=email,
    )
    cognito.authenticate(password=password)
    return cognito.id_token


async def _get_json(session: ClientSession, token: str, url: str) -> tuple[int, Any]:
    """GET a URL with the bearer token; return (status, parsed body-or-text)."""
    async with session.get(
        url, headers={"Authorization": f"Bearer {token}"}, timeout=_REQUEST_TIMEOUT
    ) as response:
        text = await response.text()
        if not text:
            return response.status, {}
        try:
            return response.status, json.loads(text)
        except json.JSONDecodeError:
            return response.status, text


def _extract_device_ids(node: Any, found: list[str]) -> list[str]:
    """Recursively collect any value under a key that looks like a device id."""
    if isinstance(node, dict):
        for key, value in node.items():
            if key.lower() in {"deviceid", "device_id"} and isinstance(value, (str, int)):
                device_id = str(value)
                if device_id not in found:
                    found.append(device_id)
            else:
                _extract_device_ids(value, found)
    elif isinstance(node, list):
        for item in node:
            _extract_device_ids(item, found)
    return found


def _dump(label: str, status: int, body: Any) -> None:
    print(f"\n===== {label}  (HTTP {status}) =====")
    print(json.dumps(body, indent=2) if isinstance(body, (dict, list)) else str(body))


async def main() -> int:
    load_dotenv()
    email = os.environ.get("APRILAIRE_CLOUD_EMAIL")
    password = os.environ.get("APRILAIRE_CLOUD_PASSWORD")
    if not email or not password:
        print(
            "error: set APRILAIRE_CLOUD_EMAIL and APRILAIRE_CLOUD_PASSWORD in .env",
            file=sys.stderr,
        )
        return 2

    print(f"authenticating as {email} ...", file=sys.stderr)
    try:
        token = await asyncio.get_running_loop().run_in_executor(
            None, _authenticate, email, password
        )
    except Exception as exc:  # noqa: BLE001 - surface any auth failure verbatim
        print(f"auth failed: {exc}", file=sys.stderr)
        return 1
    print("authenticated OK", file=sys.stderr)

    async with ClientSession() as session:
        status, user = await _get_json(session, token, f"{ACCOUNT_API}/user")
        _dump("ACCOUNT /user", status, user)

        status, hierarchy = await _get_json(session, token, f"{DEVICE_API}/hierarchy")
        _dump("DEVICE /hierarchy", status, hierarchy)

        device_ids = _extract_device_ids(hierarchy, [])
        print(f"\n>>> discovered {len(device_ids)} device id(s): {device_ids}", file=sys.stderr)

        for device_id in device_ids[:_MAX_DEVICES]:
            for suffix in ("status", "settings"):
                await asyncio.sleep(_POLITE_DELAY_S)
                status, body = await _get_json(
                    session, token, f"{DEVICE_API}/{device_id}/{suffix}"
                )
                _dump(f"DEVICE {device_id} /{suffix}", status, body)

    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
