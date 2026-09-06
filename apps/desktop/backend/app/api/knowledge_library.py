"""Compatibility import for the shared knowledge_library API."""
import sys
from learnflow_core.api import knowledge_library as _implementation
sys.modules[__name__] = _implementation
