"""Compatibility route; shared learner-owned work task conversion API."""
import sys
from learnflow_core.api import work_task_conversions as _implementation
sys.modules[__name__] = _implementation
