"""Compatibility import for the shared workspace API."""
import sys
from learnflow_core.api import workspace as _implementation
sys.modules[__name__] = _implementation
