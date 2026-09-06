"""Compatibility import for the shared memory API."""
import sys
from learnflow_core.api import memory as _implementation
sys.modules[__name__] = _implementation
