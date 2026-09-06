"""Compatibility import for the shared learning_task_integrations API."""
import sys
from learnflow_core.api import learning_task_integrations as _implementation
sys.modules[__name__] = _implementation
