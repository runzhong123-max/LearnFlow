"""Compatibility import; shared project implementation."""
import sys
from learnflow_core import practice_cases as _implementation
sys.modules[__name__] = _implementation
