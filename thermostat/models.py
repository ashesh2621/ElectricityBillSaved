"""Pydantic models and unit helpers for Aprilaire thermostat reads.

The Aprilaire automation protocol transmits temperatures in Celsius. This module
is the single boundary where we convert to/from Fahrenheit so the rest of the app
(and the user, in Houston) can think in °F.
"""

from __future__ import annotations

from pydantic import BaseModel, Field

# Raw Aprilaire mode integer -> human label. Source: aprilaire-ha climate.py.
# 4 is an auxiliary/second-stage heat that still presents as "heat".
MODE_NAMES: dict[int, str] = {1: "off", 2: "heat", 3: "cool", 4: "heat_aux", 5: "auto"}
FAN_MODE_NAMES: dict[int, str] = {1: "on", 2: "auto", 3: "circulate"}


def celsius_to_fahrenheit(celsius: float) -> float:
    """Convert Celsius to Fahrenheit, rounded to one decimal.

    Example:
        >>> celsius_to_fahrenheit(25.0)
        77.0
    """
    return round(celsius * 9 / 5 + 32, 1)


def fahrenheit_to_celsius(fahrenheit: float) -> float:
    """Convert Fahrenheit to Celsius, rounded to one decimal.

    Example:
        >>> fahrenheit_to_celsius(77.0)
        25.0
    """
    return round((fahrenheit - 32) * 5 / 9, 1)


class ThermostatReading(BaseModel):
    """A point-in-time snapshot of one Aprilaire thermostat, in Fahrenheit."""

    host: str = Field(..., description="LAN host/IP the reading came from")
    indoor_temperature_f: float | None = Field(None, description="Current indoor temperature (°F)")
    indoor_humidity_pct: int | None = Field(None, description="Current indoor relative humidity (%)")
    cool_setpoint_f: float | None = Field(None, description="Active cool setpoint (°F)")
    heat_setpoint_f: float | None = Field(None, description="Active heat setpoint (°F)")
    mode: int | None = Field(None, description="Raw Aprilaire mode integer")
    mode_name: str | None = Field(None, description="Human-readable mode (off/heat/cool/heat_aux/auto)")
    fan_mode: int | None = Field(None, description="Raw Aprilaire fan-mode integer")
    fan_mode_name: str | None = Field(None, description="Human-readable fan mode (on/auto/circulate)")
