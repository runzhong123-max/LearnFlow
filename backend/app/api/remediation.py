"""Compatibility import for the shared remediation API."""
import sys
from learnflow_core.api import remediation as _implementation
sys.modules[__name__] = _implementation
