"""CLI: set the cool setpoint on an Aprilaire thermostat.

Defaults to the 2nd-floor unit (`APRILAIRE_2F_HOST` in .env). Override with --host.
The current heat setpoint is preserved; the heat/cool deadband is enforced.

Usage:
    python set_temperature.py --cool 74              # 2nd floor (from .env)
    python set_temperature.py --cool 74 --host 192.168.1.50
    python set_temperature.py --cool 74 --host localhost --port 7001   # mock
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys

from dotenv import load_dotenv

from thermostat.client import configure_logging, set_cool_setpoint


def main() -> int:
    load_dotenv()
    configure_logging()

    parser = argparse.ArgumentParser(description="Set an Aprilaire thermostat's cool setpoint (°F).")
    parser.add_argument("--cool", type=float, required=True, help="Target cool setpoint in °F")
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

    try:
        reading = asyncio.run(set_cool_setpoint(args.host, args.port, args.cool))
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    print(f"\n{args.floor} thermostat ({args.host}:{args.port}) updated")
    print(f"  cool setpoint -> {reading.cool_setpoint_f}°F")
    print(f"  heat setpoint :  {reading.heat_setpoint_f}°F (unchanged)")
    print(f"  indoor temp   :  {reading.indoor_temperature_f}°F   mode: {reading.mode_name}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
