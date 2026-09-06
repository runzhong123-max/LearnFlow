"""Compatibility import for the shared learner_state API."""
import sys
from learnflow_core.api import learner_state as _implementation
sys.modules[__name__] = _implementation
