"""Compatibility import for the shared learning_files API."""
import sys
from learnflow_core.api import learning_files as _implementation
sys.modules[__name__] = _implementation
