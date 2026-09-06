"""Compatibility import for the shared review API."""
import sys
from learnflow_core.api import review as _implementation
sys.modules[__name__] = _implementation
