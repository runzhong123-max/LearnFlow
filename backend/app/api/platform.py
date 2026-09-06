"""Compatibility import for the shared platform protocol."""
import sys
from learnflow_core.api import platform as _implementation
sys.modules[__name__] = _implementation
