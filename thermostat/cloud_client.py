"""Cloud client for Aprilaire thermostats via the Healthy Air cloud (aprilaire.io).

This is the scalable, app-preserving path: it talks to the same cloud the phone app
uses, so customers keep their app and no LAN access is required.

Confirmed against live S86WMUPR units:
- Setpoints + mode: REST  GET /{deviceId}/settings  -> thermostatPZ1.{cool,heat,mode,fan}
- Live temp/humidity: WebSocket ThermostatStatus -> tempSensors[].reading (°C), humSensors[].reading (%)
- Write setpoint: REST  PATCH /{deviceId}/settings  {"thermostatPZ1": {"cool": <°C>}}

All temperatures on the wire are Celsius; we convert at the °F boundary.
Auth is AWS Cognito (same public app pool as the Healthy Air app).
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

from aiohttp import ClientSession, ClientTimeout
from pycognito import Cognito

from .models import ThermostatReading, celsius_to_fahrenheit, fahrenheit_to_celsius

COGNITO_REGION = "us-west-2"
COGNITO_USER_POOL_ID = "us-west-2_skfkpmVv6"
COGNITO_CLIENT_ID = "3aiakr6qdoqtajv7qgtapecerg"
DEVICE_API = "https://device.aprilaire.io"
WEBSOCKET_URL = "wss://socket.aprilaire.io/"

_REQUEST_TIMEOUT = ClientTimeout(total=20)
_WS_BURST_TIMEOUT_S = 12.0
_CONFIRM_ATTEMPTS = 6
_CONFIRM_INTERVAL_S = 1.5
MIN_DEADBAND_F = 3.0


class AprilaireCloudError(Exception):
    """Any failure talking to the Aprilaire cloud."""


class AprilaireCloudClient:
    """Minimal async client for reading and writing one account's thermostats."""

    def __init__(self, email: str, password: str, session: ClientSession) -> None:
        self._email = email
        self._password = password
        self._session = session
        self._id_token: str | None = None

    async def _token(self) -> str:
        """Return a bearer id_token, authenticating on first use."""
        if self._id_token is not None:
            return self._id_token

        def _authenticate() -> str:
            cognito = Cognito(
                user_pool_id=COGNITO_USER_POOL_ID,
                client_id=COGNITO_CLIENT_ID,
                user_pool_region=COGNITO_REGION,
                username=self._email,
            )
            cognito.authenticate(password=self._password)
            return cognito.id_token

        try:
            self._id_token = await asyncio.get_running_loop().run_in_executor(None, _authenticate)
        except Exception as exc:  # noqa: BLE001 - surface auth failure verbatim
            raise AprilaireCloudError(f"Cognito authentication failed: {exc}") from exc
        return self._id_token

    async def _request_json(self, method: str, path: str, payload: dict[str, Any] | None = None) -> Any:
        token = await self._token()
        headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        async with self._session.request(
            method, f"{DEVICE_API}{path}", headers=headers, json=payload, timeout=_REQUEST_TIMEOUT
        ) as response:
            text = await response.text()
            if response.status >= 400:
                raise AprilaireCloudError(f"{method} {path} -> HTTP {response.status}: {text[:200]}")
            if not text:
                return {}
            return json.loads(text)

    async def _live_thermostat_status(self, device_id: str, location_id: str) -> dict[str, Any]:
        """Subscribe to the location WebSocket and return the device's ThermostatStatus frame."""
        token = await self._token()
        async with self._session.ws_connect(
            WEBSOCKET_URL, heartbeat=None, autoping=False, receive_timeout=None
        ) as ws:
            await ws.send_json(
                {"action": "subscribe", "message": {"token": token, "locationId": location_id}}
            )
            loop = asyncio.get_running_loop()
            deadline = loop.time() + _WS_BURST_TIMEOUT_S
            while loop.time() < deadline:
                try:
                    msg = await asyncio.wait_for(ws.receive(), timeout=deadline - loop.time())
                except asyncio.TimeoutError:
                    break
                if msg.type.name in {"CLOSED", "CLOSING", "ERROR"}:
                    break
                if msg.data in ("pong", '"pong"', "ok", '"ok"'):
                    continue
                try:
                    data = json.loads(msg.data)
                except (json.JSONDecodeError, TypeError):
                    continue
                for item in data if isinstance(data, list) else [data]:
                    if (
                        isinstance(item, dict)
                        and item.get("deviceId") == device_id
                        and item.get("_type") == "ThermostatStatus"
                    ):
                        return item
        raise AprilaireCloudError(f"No ThermostatStatus for {device_id} within {_WS_BURST_TIMEOUT_S}s")

    async def read_state(self, device_id: str, location_id: str) -> ThermostatReading:
        """Read setpoints/mode (REST) + live temperature/humidity (WebSocket)."""
        settings = await self._request_json("GET", f"/{device_id}/settings")
        pz = settings["thermostatPZ1"]
        status = await self._live_thermostat_status(device_id, location_id)

        temp_c = _first_reading(status.get("tempSensors"))
        humidity = _first_reading(status.get("humSensors"))
        return ThermostatReading(
            host=device_id,
            indoor_temperature_f=celsius_to_fahrenheit(temp_c) if temp_c is not None else None,
            indoor_humidity_pct=int(humidity) if humidity is not None else None,
            cool_setpoint_f=celsius_to_fahrenheit(pz["cool"]),
            heat_setpoint_f=celsius_to_fahrenheit(pz["heat"]),
            mode=None,
            mode_name=pz.get("mode"),
            fan_mode=None,
            fan_mode_name=pz.get("fan"),
        )

    async def set_cool_setpoint(
        self, device_id: str, location_id: str, cool_f: float
    ) -> ThermostatReading:
        """Set the cool setpoint (°F), enforcing the heat/cool deadband, then read back."""
        settings = await self._request_json("GET", f"/{device_id}/settings")
        pz = settings["thermostatPZ1"]
        heat_f = celsius_to_fahrenheit(pz["heat"])
        # The heat/cool deadband only applies in auto mode, where both setpoints
        # are active at once. In dedicated cool/heat mode they're independent.
        if pz.get("mode") == "auto" and cool_f < heat_f + MIN_DEADBAND_F:
            raise ValueError(
                f"cool setpoint {cool_f}°F too close to heat {heat_f}°F in auto mode; "
                f"need a gap of at least {MIN_DEADBAND_F}°F"
            )
        target_c = fahrenheit_to_celsius(cool_f)
        await self._request_json(
            "PATCH", f"/{device_id}/settings", payload={"thermostatPZ1": {"cool": target_c}}
        )
        # The cloud is eventually-consistent: an immediate GET may still return the
        # old value. Poll /settings until the change reflects (or give up) before
        # the (slower) full read_state.
        for _ in range(_CONFIRM_ATTEMPTS):
            await asyncio.sleep(_CONFIRM_INTERVAL_S)
            settings = await self._request_json("GET", f"/{device_id}/settings")
            if abs(settings["thermostatPZ1"]["cool"] - target_c) < 0.1:
                break
        return await self.read_state(device_id, location_id)


def _first_reading(sensors: Any) -> float | None:
    """Return the first sensor's `reading`, or None."""
    if isinstance(sensors, list) and sensors and isinstance(sensors[0], dict):
        return sensors[0].get("reading")
    return None
