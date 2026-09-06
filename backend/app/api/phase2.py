"""Compatibility import for the shared phase2 API."""
import sys
from learnflow_core.api import phase2 as _implementation
sys.modules[__name__] = _implementation
