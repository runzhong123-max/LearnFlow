"""Compatibility import for the shared phase1 API."""
import sys
from learnflow_core.api import phase1 as _implementation
sys.modules[__name__] = _implementation
