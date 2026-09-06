"""Compatibility import for the shared tasks API."""
import sys
from learnflow_core.api import tasks as _implementation
sys.modules[__name__] = _implementation
