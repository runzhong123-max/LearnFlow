"""Host application bootstrap for the monorepo source checkout."""
from pathlib import Path
import sys

# Editable/wheel installs work independently. Source checkout needs no pip install.
# Frozen builds collect learnflow_core explicitly and use their bundled package.
if not getattr(sys, "frozen", False):
    _shared_src = Path(__file__).resolve().parents[2] / "packages" / "learning-core" / "src"
    if (_shared_src / "learnflow_core" / "__init__.py").is_file():
        sys.path.insert(0, str(_shared_src))
