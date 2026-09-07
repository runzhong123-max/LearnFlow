"""Compatibility import; shared project guidance API."""
import sys
from learnflow_core.api import project_guidance as _implementation
sys.modules[__name__] = _implementation
