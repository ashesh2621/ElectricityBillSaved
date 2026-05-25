"""CLI: read or adjust an Aprilaire thermostat via the Healthy Air cloud.

Keeps the phone app working; no LAN access or Automation mode needed.
Reads credentials + device IDs from .env (see .env.example).

Usage:
    python cloud_thermostat.py read                 # 2nd floor
    python cloud_thermostat.py read --floor 1
    python cloud_thermostat.py set --cool 76        # 2nd floor cool setpoint -> 76°F
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys

from aiohttp import ClientSession
from dotenv import load_dotenv

from thermostat.cloud_client import AprilaireCloudClient
from thermostat.models import ThermostatReading


def _device_id(floor: str) -> str | None:
    return os.environ.get("APRILAIRE_2F_DEVICE_ID" if floor == "2" else "APRILAIRE_1F_DEVICE_ID")


def _print(reading: ThermostatReading, floor: str) -> None:
    print(f"\n{floor} floor thermostat (cloud)")
    print(f"  indoor temp   : {reading.indoor_temperature_f}°F")
    print(f"  humidity      : {reading.indoor_humidity_pct}%")
    print(f"  cool setpoint : {reading.cool_setpoint_f}°F")
    print(f"  heat setpoint : {reading.heat_setpoint_f}°F")
    print(f"  mode          : {reading.mode_name}   fan: {reading.fan_mode_name}\n")


async def _run(args: argparse.Namespace) -> int:
    email = os.environ.get("APRILAIRE_CLOUD_EMAIL")
    password = os.environ.get("APRILAIRE_CLOUD_PASSWORD")
    location_id = os.environ.get("APRILAIRE_LOCATION_ID")
    device_id = _device_id(args.floor)
    if not all([email, password, location_id, device_id]):
        print("error: missing APRILAIRE_CLOUD_* / IDs in .env", file=sys.stderr)
        return 2

    async with ClientSession() as session:
        client = AprilaireCloudClient(email, password, session)
        if args.command == "read":
            reading = await client.read_state(device_id, location_id)
        else:
            try:
                reading = await client.set_cool_setpoint(device_id, location_id, args.cool)
            except ValueError as exc:
                print(f"error: {exc}", file=sys.stderr)
                return 1
            print(f"cool setpoint set to {args.cool}°F", file=sys.stderr)
        _print(reading, args.floor)
    return 0


def main() -> int:
    load_dotenv()
    parser = argparse.ArgumentParser(description="Read/adjust an Aprilaire thermostat via the cloud.")
    sub = parser.add_subparsers(dest="command", required=True)

    read_p = sub.add_parser("read", help="Read current state")
    read_p.add_argument("--floor", choices=["1", "2"], default="2")

    set_p = sub.add_parser("set", help="Set the cool setpoint (°F)")
    set_p.add_argument("--cool", type=float, required=True)
    set_p.add_argument("--floor", choices=["1", "2"], default="2")

    args = parser.parse_args()
    return asyncio.run(_run(args))


if __name__ == "__main__":
    raise SystemExit(main())
