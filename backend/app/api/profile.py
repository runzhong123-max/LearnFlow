"""Compatibility import for the shared profile API."""
import sys
from learnflow_core.api import profile as _implementation
sys.modules[__name__] = _implementation
