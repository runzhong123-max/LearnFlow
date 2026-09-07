"""Compatibility import; shared workflow API."""
import sys
from learnflow_core.api import project_workflows as _implementation
sys.modules[__name__] = _implementation
