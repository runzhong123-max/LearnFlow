"""Compatibility import for the shared local_agent API."""
import sys
from learnflow_core.api import local_agent as _implementation
sys.modules[__name__] = _implementation
