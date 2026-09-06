"""Compatibility import; implementation lives in packages/learning-core."""
import sys
from learnflow_core import five_kernel_context as _implementation

# Preserve module identity, private imports and monkeypatch targets.
sys.modules[__name__] = _implementation
