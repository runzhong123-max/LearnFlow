"""Compatibility import for the shared phase3 API."""
import sys
from learnflow_core.api import phase3 as _implementation
sys.modules[__name__] = _implementation
