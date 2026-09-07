"""Compatibility import; shared project implementation."""
import sys
from learnflow_core import project_workflows as _implementation
sys.modules[__name__] = _implementation
