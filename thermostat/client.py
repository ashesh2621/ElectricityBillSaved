"""Local-LAN client for one Aprilaire thermostat, built on `pyaprilaire`.

Connection contract (see `reference/integrations.md` section 3):
- S86WMUPR / 8800-series expose an automation socket on TCP **port 8000** once the
  device is set to Connection Type = Automation. (port 7001 is only the dev mock.)
- The protocol speaks **Celsius**; we convert at this boundary via `models`.
- HARD CONSTRAINT: only ONE automation connection per thermostat at a time. Parallel
  connects can hang the device until a physical power-cycle. `_device_lock` serializes
  access across processes so two CLI runs never collide.
"""

from __future__ import annotations

import asyncio
import fcntl
import hashlib
import logging
import os
import sys
import tempfile
from contextlib import contextmanager
from typing import Any, Iterator

import structlog
from pyaprilaire.client import AprilaireClient
from pyaprilaire.const import Attribute

from .models import (
    FAN_MODE_NAMES,
    MODE_NAMES,
    ThermostatReading,
    celsius_to_fahrenheit,
    fahrenheit_to_celsius,
)

logger = structlog.get_logger()

READ_TIMEOUT_S: float = 12.0
_SETTLE_S: float = 1.0
# Device clamps if heat/cool are too close (~2°F). Keep a safety margin.
MIN_DEADBAND_F: float = 3.0


def configure_logging() -> None:
    """Route structured logs to stderr so CLI stdout stays clean for results."""
    logging.basicConfig(level=logging.WARNING, stream=sys.stderr)
    structlog.configure(
        processors=[
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.JSONRenderer(),
        ],
        logger_factory=structlog.PrintLoggerFactory(file=sys.stderr),
    )


@contextmanager
def _device_lock(host: str) -> Iterator[None]:
    """Serialize automation access to a single thermostat across processes."""
    digest = hashlib.sha1(host.encode()).hexdigest()[:12]
    lock_path = os.path.join(tempfile.gettempdir(), f"aprilaire-{digest}.lock")
    handle = open(lock_path, "w")
    try:
        fcntl.flock(handle, fcntl.LOCK_EX)
        yield
    finally:
        fcntl.flock(handle, fcntl.LOCK_UN)
        handle.close()


async def _open(host: str, port: int) -> tuple[AprilaireClient, dict[str, Any]]:
    """Open a one-shot automation connection; return the client and its live data dict."""
    data: dict[str, Any] = {}

    def _on_data(new_data: dict[str, Any]) -> None:
        data.update(new_data)

    client = AprilaireClient(
        host,
        port,
        data_received_callback=_on_data,
        logger=logging.getLogger("pyaprilaire"),
    )
    await client.start_listen_once()
    return client, data


async def _await_keys(data: dict[str, Any], keys: list[str], timeout: float) -> bool:
    """Poll the live data dict until all `keys` are present or `timeout` elapses."""
    loop = asyncio.get_event_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        if all(key in data for key in keys):
            return True
        await asyncio.sleep(0.1)
    return False


def _to_reading(host: str, data: dict[str, Any]) -> ThermostatReading:
    """Build a Fahrenheit `ThermostatReading` from the raw Celsius data dict."""

    def to_f(celsius: Any) -> float | None:
        return celsius_to_fahrenheit(celsius) if celsius is not None else None

    mode = data.get(Attribute.MODE)
    fan_mode = data.get(Attribute.FAN_MODE)
    return ThermostatReading(
        host=host,
        indoor_temperature_f=to_f(data.get(Attribute.INDOOR_TEMPERATURE_CONTROLLING_SENSOR_VALUE)),
        indoor_humidity_pct=data.get(Attribute.INDOOR_HUMIDITY_CONTROLLING_SENSOR_VALUE),
        cool_setpoint_f=to_f(data.get(Attribute.COOL_SETPOINT)),
        heat_setpoint_f=to_f(data.get(Attribute.HEAT_SETPOINT)),
        mode=mode,
        mode_name=MODE_NAMES.get(mode) if mode is not None else None,
        fan_mode=fan_mode,
        fan_mode_name=FAN_MODE_NAMES.get(fan_mode) if fan_mode is not None else None,
    )


async def read_state(host: str, port: int, timeout: float = READ_TIMEOUT_S) -> ThermostatReading:
    """Read current temperature, humidity, setpoints, and mode from a thermostat.

    Args:
        host: LAN IP/hostname of the thermostat (must be in Automation mode).
        port: Automation socket port (8000 for S86WMUPR / 8800-series).
        timeout: Seconds to wait for the device to report its state.

    Returns:
        A `ThermostatReading` with values in Fahrenheit.

    Raises:
        TimeoutError: If the device does not report state within `timeout`.
    """
    logger.info("thermostat_read_started", host=host, port=port)
    with _device_lock(host):
        client, data = await _open(host, port)
        try:
            await client.read_sensors()
            await client.read_control()
            ready = await _await_keys(
                data,
                [Attribute.COOL_SETPOINT, Attribute.INDOOR_TEMPERATURE_CONTROLLING_SENSOR_VALUE],
                timeout,
            )
            if not ready:
                logger.error(
                    "thermostat_read_timeout",
                    host=host,
                    received_keys=list(data.keys()),
                    fix_suggestion="Confirm the unit is in Automation mode and reachable on this port.",
                )
                raise TimeoutError(f"No state from {host}:{port} within {timeout}s")
        finally:
            client.stop_listen()
    reading = _to_reading(host, data)
    logger.info(
        "thermostat_read_completed",
        host=host,
        indoor_temperature_f=reading.indoor_temperature_f,
        cool_setpoint_f=reading.cool_setpoint_f,
        mode=reading.mode_name,
    )
    return reading


async def set_cool_setpoint(
    host: str, port: int, cool_f: float, timeout: float = READ_TIMEOUT_S
) -> ThermostatReading:
    """Set the cool setpoint (°F), preserving the current heat setpoint.

    Reads the current setpoints first to (a) preserve the heat setpoint, which
    `update_setpoint` requires, and (b) enforce the heat/cool deadband.

    Args:
        host: LAN IP/hostname of the thermostat (must be in Automation mode).
        port: Automation socket port (8000 for S86WMUPR / 8800-series).
        cool_f: Desired cool setpoint in Fahrenheit.
        timeout: Seconds to wait for read/confirm round-trips.

    Returns:
        A fresh `ThermostatReading` read back after the write.

    Raises:
        TimeoutError: If the device never reports its setpoints.
        ValueError: If `cool_f` violates the minimum heat/cool deadband.
    """
    logger.info("thermostat_set_started", host=host, port=port, cool_setpoint_f=cool_f)
    with _device_lock(host):
        client, data = await _open(host, port)
        try:
            await client.read_control()
            ready = await _await_keys(data, [Attribute.COOL_SETPOINT, Attribute.HEAT_SETPOINT], timeout)
            if not ready:
                logger.error(
                    "thermostat_set_read_timeout",
                    host=host,
                    fix_suggestion="Confirm the unit is in Automation mode and reachable on this port.",
                )
                raise TimeoutError(f"Could not read current setpoints from {host}:{port}")

            heat_c = data[Attribute.HEAT_SETPOINT]
            heat_f = celsius_to_fahrenheit(heat_c)
            if cool_f < heat_f + MIN_DEADBAND_F:
                raise ValueError(
                    f"cool setpoint {cool_f}°F too close to heat {heat_f}°F; "
                    f"need a gap of at least {MIN_DEADBAND_F}°F"
                )

            data.pop(Attribute.INDOOR_TEMPERATURE_CONTROLLING_SENSOR_VALUE, None)
            await client.update_setpoint(fahrenheit_to_celsius(cool_f), heat_c)
            await asyncio.sleep(_SETTLE_S)
            await client.read_control()
            await client.read_sensors()
            await _await_keys(
                data,
                [Attribute.COOL_SETPOINT, Attribute.INDOOR_TEMPERATURE_CONTROLLING_SENSOR_VALUE],
                timeout,
            )
        finally:
            client.stop_listen()
    reading = _to_reading(host, data)
    logger.info("thermostat_set_completed", host=host, cool_setpoint_f=reading.cool_setpoint_f)
    return reading
