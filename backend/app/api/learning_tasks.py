"""Compatibility import for the shared learning_tasks API."""
import sys
from learnflow_core.api import learning_tasks as _implementation
sys.modules[__name__] = _implementation
