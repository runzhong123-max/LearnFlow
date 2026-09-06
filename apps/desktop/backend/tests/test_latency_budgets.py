from app.core.config import Settings
from app.services.source_locator import (
    GIT_CLONE_TIMEOUT_SECONDS,
    HTTP_TOTAL_TIMEOUT_SECONDS,
    MAX_HTTP_TOTAL_TIMEOUT_SECONDS,
)


def test_interactive_model_defaults_are_long_but_bounded():
    settings = Settings(_env_file=None)

    assert settings.tutor_model_budget_seconds == 180.0
    assert settings.learning_task_plan_model_budget_seconds == 120.0
    assert settings.micro_learning_artifact_model_budget_seconds == 180.0


def test_remote_source_budgets_keep_a_bounded_outer_ceiling():
    assert HTTP_TOTAL_TIMEOUT_SECONDS == 90.0
    assert HTTP_TOTAL_TIMEOUT_SECONDS < MAX_HTTP_TOTAL_TIMEOUT_SECONDS == 180.0
    assert GIT_CLONE_TIMEOUT_SECONDS == 180.0
