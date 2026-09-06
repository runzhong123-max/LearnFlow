"""Compatibility import for the shared projects API."""
import sys
from learnflow_core.api import projects as _implementation
sys.modules[__name__] = _implementation
