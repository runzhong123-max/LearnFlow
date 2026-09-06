from datetime import datetime, timedelta

from app.models.learning import EvidenceEvent, LearningAttempt, ReviewSchedule
from app.services.review_proficiency import build_concept_proficiency


def _schedule(**values):
    defaults = {
        "id": 1,
        "learner_id": 1,
        "checkpoint_id": 1,
        "item_type": "concept",
        "item_id": 1,
        "subject_key": "bayes-rule",
        "interval_level": 0,
        "successful_reviews": 0,
        "lapse_count": 0,
        "last_grade": "",
    }
    return ReviewSchedule(**{**defaults, **values})


def _attempt(attempt_id: int, *, passed: bool, assistance: str = "none", role: str = "review"):
    now = datetime.utcnow()
    return LearningAttempt(
        id=attempt_id,
        learner_id=1,
        checkpoint_id=1,
        item_type="concept",
        item_id=1,
        status="evaluated",
        result={"correct": passed},
        assistance_level=assistance,
        attempt_role=role,
        submitted_at=now,
        evaluated_at=now,
    )


def _event(event_id: int, attempt_id: int, form: str):
    return EvidenceEvent(
        id=event_id,
        learner_id=1,
        checkpoint_id=1,
        event_type="review_attempt_evaluated",
        source="review",
        payload={"attempt_id": attempt_id, "question_form": form},
    )


def test_proficiency_hard_caps_prevent_one_answer_or_assistance_from_becoming_mastery():
    schedule = _schedule()
    assisted = build_concept_proficiency(schedule, [_attempt(1, passed=True, assistance="hint")], [])
    independent = build_concept_proficiency(schedule, [_attempt(2, passed=True)], [])

    assert assisted["score"] <= 40
    assert {item["code"] for item in assisted["caps"]} >= {"assisted_only", "no_transfer_variant"}
    assert independent["score"] <= 65
    assert independent["next_evidence"].startswith("完成一题已校验变式")


def test_dsr_cold_start_retrievability_reaches_target_at_stability_horizon():
    now = datetime.utcnow()
    schedule = _schedule(
        interval_level=2,
        successful_reviews=2,
        last_reviewed_at=now - timedelta(days=7),
    )
    attempts = [_attempt(1, passed=True), _attempt(2, passed=True, role="variant")]
    projection = build_concept_proficiency(
        schedule,
        attempts,
        [_event(1, 1, "original"), _event(2, 2, "validated_variant")],
        now=now,
    )

    assert projection["memory_state"]["stability_days"] == 7
    assert projection["memory_state"]["retrievability"] == 0.9
    assert projection["memory_state"]["calibration"] == "cold_start_schedule_proxy_not_user_trained"
    assert projection["authority"] == "rebuildable_read_model_from_graded_evidence"
