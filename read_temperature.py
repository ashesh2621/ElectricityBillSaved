"""CLI: read and print the current state of an Aprilaire thermostat.

Defaults to the 2nd-floor unit (`APRILAIRE_2F_HOST` in .env). Override with --host.

Usage:
    python read_temperature.py                 # 2nd floor (from .env)
    python read_temperature.py --host 192.168.1.50
    python read_temperature.py --host localhost --port 7001   # against the mock
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys

from dotenv import load_dotenv

from thermostat.client import configure_logging, read_state


def main() -> int:
    load_dotenv()
    configure_logging()

    parser = argparse.ArgumentParser(description="Read an Aprilaire thermostat's current state.")
    parser.add_argument("--host", default=os.environ.get("APRILAIRE_2F_HOST"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("APRILAIRE_PORT", "8000")))
    parser.add_argument("--floor", default="2nd floor", help="Label used in the output only")
    args = parser.parse_args()

    if not args.host:
        print(
            "error: no host. Set APRILAIRE_2F_HOST in .env or pass --host <ip>",
            file=sys.stderr,
        )
        return 2

    reading = asyncio.run(read_state(args.host, args.port))

    print(f"\n{args.floor} thermostat ({args.host}:{args.port})")
    print(f"  indoor temp   : {reading.indoor_temperature_f}°F")
    print(f"  humidity      : {reading.indoor_humidity_pct}%")
    print(f"  cool setpoint : {reading.cool_setpoint_f}°F")
    print(f"  heat setpoint : {reading.heat_setpoint_f}°F")
    print(f"  mode          : {reading.mode_name}   fan: {reading.fan_mode_name}\n")
    print(reading.model_dump_json(indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
