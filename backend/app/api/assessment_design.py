"""Compatibility import for the shared assessment_design API."""
import sys
from learnflow_core.api import assessment_design as _implementation
sys.modules[__name__] = _implementation
