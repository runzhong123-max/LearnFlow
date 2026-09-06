"""Compatibility import for the shared micro_learning API."""
import sys
from learnflow_core.api import micro_learning as _implementation
sys.modules[__name__] = _implementation
