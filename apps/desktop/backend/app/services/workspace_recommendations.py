"""Compatibility import for the shared device-local file recommender."""
import sys
from learnflow_core import workspace_recommendations as _implementation
sys.modules[__name__] = _implementation
