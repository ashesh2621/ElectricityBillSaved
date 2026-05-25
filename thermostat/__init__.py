"""Local-LAN Aprilaire thermostat integration (M3 read / M4 write).

See `reference/integrations.md` section 3 for the connection contract.
"""

from .models import ThermostatReading
from .client import read_state, set_cool_setpoint

__all__ = ["ThermostatReading", "read_state", "set_cool_setpoint"]
