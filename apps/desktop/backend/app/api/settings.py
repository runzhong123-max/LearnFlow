"""Compatibility import for the shared settings API."""
import sys
from learnflow_core.api import settings as _implementation
sys.modules[__name__] = _implementation
