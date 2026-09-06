import os
import tempfile
from pathlib import Path


_test_dir = Path(tempfile.mkdtemp(prefix="learnflow-tutor-tests-"))
os.environ["DATABASE_URL"] = f"sqlite+aiosqlite:///{_test_dir / 'test.db'}"
os.environ["LLM_API_KEY"] = ""
# The production default is closed. The repository integration suite opts in
# explicitly because its shared setup uses the loopback-only passwordless
# account switcher to select the migrated demo learner.
os.environ["DEV_TEST_LOGIN_ENABLED"] = "true"
# Background consolidation is tested explicitly. Keeping it stopped in the
# shared TestClient fixture prevents races with assertions on queued runs.
os.environ["MEMORY_AUTO_SYNTHESIS_ENABLED"] = "false"
