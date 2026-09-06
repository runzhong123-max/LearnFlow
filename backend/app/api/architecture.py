"""Compatibility import for the shared architecture API."""
import sys
from learnflow_core.api import architecture as _implementation
sys.modules[__name__] = _implementation
