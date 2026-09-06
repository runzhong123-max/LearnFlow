"""Compatibility import for the shared health API."""
import sys
from learnflow_core.api import health as _implementation
sys.modules[__name__] = _implementation
