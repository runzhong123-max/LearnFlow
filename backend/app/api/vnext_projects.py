"""Compatibility import; shared formal project API."""
import sys
from learnflow_core.api import vnext_projects as _implementation
sys.modules[__name__] = _implementation
