from datetime import datetime

from sqlalchemy import (
    Column, Integer, String, Text, JSON, Float, ForeignKey, DateTime, Boolean,
    CheckConstraint, Index, UniqueConstraint, text,
)
from sqlalchemy.orm import synonym

from app.db.database import Base


class Learner(Base):
    __tablename__ = "learners"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("user_accounts.id"), nullable=True, unique=True, index=True)
    key = Column(String(100), nullable=False, unique=True, index=True)
    display_name = Column(String(255), default="本地学习者")
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


def _next_account_number(context) -> int:
    """Allocate a stable public account number without relying on process state.

    SQLite serializes the sequence-row update, so concurrent app processes cannot
    hand out the same positive number.  Number zero is reserved for the exact,
    non-demo ``ryan`` account and is assigned explicitly by registration/backfill.
    The fallback here also preserves that rule for internal account creators such
    as the seeded demo service.
    """
    connection = context.connection
    params = context.get_current_parameters()
    normalized = str(params.get("username_normalized") or "").strip().casefold()
    is_legacy_demo = bool(params.get("is_legacy_demo"))
    if normalized == "ryan" and not is_legacy_demo:
        occupied = connection.execute(text(
            "SELECT 1 FROM user_accounts WHERE account_number = 0 LIMIT 1"
        )).scalar_one_or_none()
        if occupied is None:
            return 0

    if connection.dialect.name == "sqlite":
        connection.execute(text(
            "INSERT OR IGNORE INTO auth_account_number_sequences "
            "(id, next_number, updated_at) "
            "SELECT 1, "
            "COALESCE(MAX(CASE WHEN account_number >= 1 THEN account_number END), 0) + 1, "
            "CURRENT_TIMESTAMP FROM user_accounts"
        ))
    else:
        existing = connection.execute(text(
            "SELECT next_number FROM auth_account_number_sequences WHERE id = 1"
        )).scalar_one_or_none()
        if existing is None:
            maximum = connection.execute(text(
                "SELECT COALESCE(MAX(account_number), 0) FROM user_accounts "
                "WHERE account_number >= 1"
            )).scalar_one()
            connection.execute(
                text(
                    "INSERT INTO auth_account_number_sequences "
                    "(id, next_number, updated_at) VALUES (1, :next_number, CURRENT_TIMESTAMP)"
                ),
                {"next_number": int(maximum or 0) + 1},
            )
    allocated = connection.execute(text(
        "UPDATE auth_account_number_sequences "
        "SET next_number = next_number + 1, updated_at = CURRENT_TIMESTAMP "
        "WHERE id = 1 RETURNING next_number - 1"
    )).scalar_one()
    return int(allocated)


class AuthAccountNumberSequence(Base):
    __tablename__ = "auth_account_number_sequences"

    id = Column(Integer, primary_key=True)
    next_number = Column(Integer, nullable=False, default=1)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class LearnerEventSequence(Base):
    """Transactionally allocated per-learner EvidenceEvent sequence."""

    __tablename__ = "learner_event_sequences"

    learner_id = Column(Integer, ForeignKey("learners.id"), primary_key=True)
    next_sequence = Column(Integer, nullable=False, default=1)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class UserAccount(Base):
    __tablename__ = "user_accounts"
    __table_args__ = (
        CheckConstraint("role IN ('user', 'admin')", name="ck_user_accounts_role"),
        CheckConstraint(
            "(api_key_ciphertext IS NULL AND api_key_nonce IS NULL "
            "AND api_key_hint IS NULL AND api_key_encryption_version IS NULL) OR "
            "(api_key_ciphertext IS NOT NULL AND api_key_nonce IS NOT NULL "
            "AND api_key_hint IS NOT NULL AND api_key_encryption_version IS NOT NULL)",
            name="ck_user_accounts_api_key_envelope",
        ),
        CheckConstraint(
            "(vision_api_key_ciphertext IS NULL AND vision_api_key_nonce IS NULL "
            "AND vision_api_key_hint IS NULL AND vision_api_key_encryption_version IS NULL) OR "
            "(vision_api_key_ciphertext IS NOT NULL AND vision_api_key_nonce IS NOT NULL "
            "AND vision_api_key_hint IS NOT NULL AND vision_api_key_encryption_version IS NOT NULL)",
            name="ck_user_accounts_vision_api_key_envelope",
        ),
    )

    id = Column(Integer, primary_key=True)
    account_number = Column(
        Integer, nullable=False, unique=True, index=True, default=_next_account_number,
    )
    username = Column(String(32), nullable=False)
    username_normalized = Column(String(32), nullable=False, unique=True, index=True)
    normalized_username = synonym("username_normalized")
    password_hash = Column(Text, nullable=True)
    password_version = Column(Integer, default=1, nullable=False)
    auth_epoch = Column(Integer, default=0, nullable=False)
    must_change_password = Column(Boolean, default=False, nullable=False)
    role = Column(String(20), default="user", nullable=False, index=True)
    status = Column(String(20), default="active", nullable=False, index=True)
    is_legacy_demo = Column(Boolean, default=False, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    last_login_at = Column(DateTime, nullable=True)
    password_changed_at = Column(DateTime, nullable=True)
    password_upgraded_at = Column(DateTime, nullable=True)
    # Per-account provider credentials are envelope-encrypted.  Plaintext is
    # never represented by a mapped attribute and the deployment KEK lives
    # only in environment-backed Settings.
    api_key_ciphertext = Column(Text, nullable=True)
    api_key_nonce = Column(String(32), nullable=True)
    api_key_hint = Column(String(32), nullable=True)
    api_key_encryption_version = Column(Integer, nullable=True)
    api_key_updated_at = Column(DateTime, nullable=True)
    provider_base_url = Column(String(2048), nullable=True)
    provider_model = Column(String(200), nullable=True)
    vision_api_key_ciphertext = Column(Text, nullable=True)
    vision_api_key_nonce = Column(String(32), nullable=True)
    vision_api_key_hint = Column(String(32), nullable=True)
    vision_api_key_encryption_version = Column(Integer, nullable=True)
    vision_api_key_updated_at = Column(DateTime, nullable=True)
    vision_provider_base_url = Column(String(2048), nullable=True)
    vision_provider_model = Column(String(200), nullable=True)


class AuthSession(Base):
    __tablename__ = "auth_sessions"

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("user_accounts.id"), nullable=False, index=True)
    token_hash = Column(String(64), nullable=False, unique=True, index=True)
    is_dev_login = Column(Boolean, default=False, nullable=False)
    auth_epoch = Column(Integer, default=0, nullable=False, index=True)
    csrf_token_hash = Column(String(64), nullable=False)
    absolute_expires_at = Column(DateTime, nullable=False, index=True)
    idle_expires_at = Column(DateTime, nullable=False, index=True)
    # Compatibility projection retained for clients and migrations that still
    # refer to the former single expiry.  New sessions set it to the absolute
    # deadline and authorization checks enforce all three boundaries.
    expires_at = Column(DateTime, nullable=False, index=True)
    last_seen_at = Column(DateTime, default=datetime.utcnow)
    revoked_at = Column(DateTime, nullable=True, index=True)
    revoked_reason = Column(String(80), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class AuthLoginAttempt(Base):
    __tablename__ = "auth_login_attempts"
    __table_args__ = (
        Index("ix_auth_login_attempts_account_time", "account_key_hash", "attempted_at"),
        Index("ix_auth_login_attempts_ip_time", "ip_key_hash", "attempted_at"),
    )

    id = Column(Integer, primary_key=True)
    # Raw usernames and network addresses are intentionally not retained.
    account_key_hash = Column(String(64), nullable=False)
    ip_key_hash = Column(String(64), nullable=False)
    attempted_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)


class LearnerProfile(Base):
    __tablename__ = "learner_profiles"

    learner_id = Column(Integer, ForeignKey("learners.id"), primary_key=True)
    education_stage = Column(String(40), default="other")
    background = Column(Text, default="")
    focus_areas = Column(JSON, default=list)
    weekly_hours = Column(Integer, default=5)
    preferred_modes = Column(JSON, default=list)
    career_goal = Column(Text, default="")
    career_goal_status = Column(String(20), default="exploring")
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class LearningLifeEvent(Base):
    __tablename__ = "learning_life_events"
    __table_args__ = (
        UniqueConstraint("learner_id", "dedupe_key", name="uq_life_event_learner_key"),
    )

    id = Column(Integer, primary_key=True)
    learner_id = Column(Integer, ForeignKey("learners.id"), nullable=False, index=True)
    event_type = Column(String(50), nullable=False, index=True)
    status = Column(String(20), default="active", nullable=False, index=True)
    title = Column(String(255), nullable=False)
    summary = Column(Text, default="")
    payload = Column(JSON, default=dict)
    source_event_id = Column(Integer, ForeignKey("evidence_events.id"), nullable=True, index=True)
    project_id = Column(Integer, ForeignKey("projects.id"), nullable=True, index=True)
    confidence = Column(Float, default=1.0)
    dedupe_key = Column(String(160), nullable=False)
    occurred_at = Column(DateTime, default=datetime.utcnow, index=True)
    corrected_at = Column(DateTime, nullable=True)


class LearnerBadge(Base):
    __tablename__ = "learner_badges"
    __table_args__ = (
        UniqueConstraint("learner_id", "award_key", name="uq_badge_learner_award"),
    )

    id = Column(Integer, primary_key=True)
    learner_id = Column(Integer, ForeignKey("learners.id"), nullable=False, index=True)
    badge_type = Column(String(50), nullable=False, index=True)
    title = Column(String(255), nullable=False)
    description = Column(Text, default="")
    icon_key = Column(String(50), default="award")
    color_token = Column(String(30), default="indigo")
    award_key = Column(String(160), nullable=False)
    life_event_id = Column(Integer, ForeignKey("learning_life_events.id"), nullable=False, index=True)
    project_id = Column(Integer, ForeignKey("projects.id"), nullable=True, index=True)
    meta_data = Column(JSON, default=dict)
    awarded_at = Column(DateTime, default=datetime.utcnow, index=True)


class MemoryArchive(Base):
    __tablename__ = "memory_archives"
    __table_args__ = (
        UniqueConstraint(
            "learner_id", "kernel_name", "memory_scope", "memory_key",
            name="uq_memory_archive_path",
        ),
    )

    id = Column(Integer, primary_key=True)
    learner_id = Column(Integer, ForeignKey("learners.id"), nullable=False, index=True)
    kernel_name = Column(String(30), nullable=False, index=True)
    memory_scope = Column(String(20), nullable=False)
    memory_key = Column(String(160), nullable=False)
    archived_value = Column(JSON, default=dict)
    reason = Column(Text, default="")
    status = Column(String(20), default="archived", nullable=False, index=True)
    evidence_id = Column(Integer, ForeignKey("evidence_events.id"), nullable=True, index=True)
    archived_at = Column(DateTime, default=datetime.utcnow)
    restored_at = Column(DateTime, nullable=True)


class EvidenceEvent(Base):
    __tablename__ = "evidence_events"
    __table_args__ = (
        UniqueConstraint("learner_id", "learner_seq", name="uq_evidence_learner_seq"),
    )

    id = Column(Integer, primary_key=True)
    learner_id = Column(Integer, ForeignKey("learners.id"), nullable=False, index=True)
    project_id = Column(Integer, ForeignKey("projects.id"), nullable=True, index=True)
    checkpoint_id = Column(Integer, ForeignKey("checkpoints.id"), nullable=True, index=True)
    session_id = Column(Integer, ForeignKey("agent_sessions.id"), nullable=True, index=True)
    event_type = Column(String(80), nullable=False, index=True)
    source = Column(String(40), nullable=False, default="system")
    context_id = Column(String(255), default="")
    payload = Column(JSON, default=dict)
    artifact_refs = Column(JSON, default=list)
    confidence = Column(Float, default=1.0)
    provenance = Column(JSON, default=dict)
    client_event_id = Column(String(160), nullable=True, unique=True, index=True)
    occurred_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
    learner_seq = Column(Integer, nullable=True, index=True)
    actor_type = Column(String(30), default="system", nullable=False, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)


class LearningAttempt(Base):
    __tablename__ = "learning_attempts"

    id = Column(Integer, primary_key=True)
    learner_id = Column(Integer, ForeignKey("learners.id"), nullable=False, index=True)
    project_id = Column(Integer, ForeignKey("projects.id"), nullable=True, index=True)
    checkpoint_id = Column(Integer, ForeignKey("checkpoints.id"), nullable=False, index=True)
    item_type = Column(String(30), nullable=False)  # concept | exercise | freeform
    item_id = Column(Integer, nullable=True, index=True)
    status = Column(String(30), default="started", index=True)
    submission = Column(JSON, default=dict)
    result = Column(JSON, default=dict)
    assistance_level = Column(String(30), default="none")
    remediation_case_id = Column(
        Integer, ForeignKey("remediation_cases.id"), nullable=True, index=True,
    )
    attempt_role = Column(String(30), default="original", index=True)
    client_submission_id = Column(String(160), nullable=True, unique=True, index=True)
    started_at = Column(DateTime, default=datetime.utcnow)
    submitted_at = Column(DateTime, nullable=True)
    evaluated_at = Column(DateTime, nullable=True)


class RemediationCase(Base):
    """Explicit wrong-answer remediation state machine.

    A case starts from one evaluated attempt and remains linked to every retry,
    explanation-mode decision, transfer variant, and evidence writeback.
    Strategy selection is deterministic; generated text is a presentation of
    already-verified evidence rather than an LLM-owned decision.
    """

    __tablename__ = "remediation_cases"
    __table_args__ = (
        UniqueConstraint("source_attempt_id", name="uq_remediation_source_attempt"),
    )

    id = Column(Integer, primary_key=True)
    learner_id = Column(Integer, ForeignKey("learners.id"), nullable=False, index=True)
    project_id = Column(Integer, ForeignKey("projects.id"), nullable=True, index=True)
    checkpoint_id = Column(Integer, ForeignKey("checkpoints.id"), nullable=False, index=True)
    source_attempt_id = Column(
        Integer, ForeignKey("learning_attempts.id"), nullable=False, index=True,
    )
    item_type = Column(String(30), nullable=False, index=True)
    item_id = Column(Integer, nullable=True, index=True)
    status = Column(String(30), default="explaining", nullable=False, index=True)
    error_fingerprint = Column(String(64), nullable=False, index=True)
    error_class = Column(String(50), nullable=False)
    misconception_tag = Column(String(100), default="")
    evidence = Column(JSON, default=dict)
    evidence_event_ids = Column(JSON, default=list)
    strategy = Column(JSON, default=dict)
    current_delivery_mode = Column(String(40), default="contrast")
    ineffective_modes = Column(JSON, default=list)
    explanation_history = Column(JSON, default=list)
    retry_attempt_id = Column(Integer, ForeignKey("learning_attempts.id"), nullable=True)
    variant_attempt_id = Column(Integer, ForeignKey("learning_attempts.id"), nullable=True)
    variant_payload = Column(JSON, default=dict)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    completed_at = Column(DateTime, nullable=True)


class ReviewSchedule(Base):
    """Rebuildable spaced-review projection for one learner-owned item.

    This row is operational scheduling state, not a parallel mastery source of
    truth.  LearningAttempt and EvidenceEvent remain authoritative evidence.
    """

    __tablename__ = "review_schedules"
    __table_args__ = (
        UniqueConstraint(
            "learner_id", "item_type", "item_id",
            name="uq_review_schedule_learner_item",
        ),
    )

    id = Column(Integer, primary_key=True)
    learner_id = Column(Integer, ForeignKey("learners.id"), nullable=False, index=True)
    project_id = Column(Integer, ForeignKey("projects.id"), nullable=True, index=True)
    checkpoint_id = Column(Integer, ForeignKey("checkpoints.id"), nullable=False, index=True)
    item_type = Column(String(30), nullable=False, index=True)  # concept | exercise
    item_id = Column(Integer, nullable=False, index=True)
    subject_key = Column(String(255), nullable=False, default="", index=True)
    phase = Column(String(30), nullable=False, default="active", index=True)
    due_at = Column(DateTime, nullable=False, default=datetime.utcnow, index=True)
    interval_level = Column(Integer, nullable=False, default=0)
    successful_reviews = Column(Integer, nullable=False, default=0)
    lapse_count = Column(Integer, nullable=False, default=0)
    defer_count = Column(Integer, nullable=False, default=0)
    last_grade = Column(String(20), default="")
    last_attempt_id = Column(Integer, ForeignKey("learning_attempts.id"), nullable=True, index=True)
    last_event_id = Column(Integer, ForeignKey("evidence_events.id"), nullable=True, index=True)
    last_question_form = Column(String(40), default="original")
    last_reviewed_at = Column(DateTime, nullable=True, index=True)
    suspended_at = Column(DateTime, nullable=True)
    policy_version = Column(String(40), nullable=False, default="review-policy-v1")
    version = Column(Integer, nullable=False, default=1)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)


class LearningTask(Base):
    """Learner-visible, resumable unit of learning work.

    A LearningTask coordinates a goal, queue position and adaptive plan.  It is
    deliberately separate from the background ``Task`` execution ledger and
    from mastery state.  Graded attempts and EvidenceEvent remain the only
    authority for learning evidence.
    """

    __tablename__ = "learning_tasks"
    __table_args__ = (
        UniqueConstraint(
            "learner_id", "client_request_id",
            name="uq_learning_task_learner_request",
        ),
        UniqueConstraint(
            "learner_id", "checkpoint_id",
            name="uq_learning_task_learner_checkpoint",
        ),
    )

    id = Column(Integer, primary_key=True)
    learner_id = Column(Integer, ForeignKey("learners.id"), nullable=False, index=True)
    session_id = Column(Integer, ForeignKey("agent_sessions.id"), nullable=True, index=True)
    project_id = Column(Integer, ForeignKey("projects.id"), nullable=True, index=True)
    checkpoint_id = Column(Integer, ForeignKey("checkpoints.id"), nullable=True, index=True)
    micro_learning_run_id = Column(
        Integer, ForeignKey("micro_learning_runs.id"), nullable=True, index=True,
    )
    origin_kind = Column(String(30), nullable=False, default="manual", index=True)
    created_by = Column(String(30), nullable=False, default="user")
    title = Column(String(255), nullable=False)
    objective = Column(Text, nullable=False)
    status = Column(String(30), nullable=False, default="queued", index=True)
    priority = Column(Integer, nullable=False, default=0, index=True)
    queue_position = Column(Integer, nullable=False, default=1000, index=True)
    estimated_minutes = Column(Integer, nullable=False, default=20)
    due_at = Column(DateTime, nullable=True, index=True)
    source_refs = Column(JSON, default=list)
    success_criteria = Column(JSON, default=list)
    plan = Column(JSON, default=dict)
    current_phase_id = Column(String(80), default="")
    plan_version = Column(Integer, nullable=False, default=1)
    execution_state = Column(JSON, default=dict)
    artifact_refs = Column(JSON, default=list)
    review_handoff = Column(JSON, default=dict)
    action_log = Column(JSON, default=list)
    client_request_id = Column(String(160), nullable=False)
    version = Column(Integer, nullable=False, default=1)
    accepted_at = Column(DateTime, nullable=True)
    started_at = Column(DateTime, nullable=True)
    completed_at = Column(DateTime, nullable=True)
    canceled_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)


class LearningTaskPlanRevision(Base):
    """Immutable history for AI- or learner-directed task plans."""

    __tablename__ = "learning_task_plan_revisions"
    __table_args__ = (
        UniqueConstraint(
            "learning_task_id", "version",
            name="uq_learning_task_plan_revision",
        ),
    )

    id = Column(Integer, primary_key=True)
    learning_task_id = Column(
        Integer, ForeignKey("learning_tasks.id"), nullable=False, index=True,
    )
    version = Column(Integer, nullable=False)
    source = Column(String(30), nullable=False, default="system")
    reason = Column(Text, default="")
    plan = Column(JSON, default=dict)
    evidence_refs = Column(JSON, default=list)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)


class AssessmentBlueprint(Base):
    """Versioned, learner-scoped proposal for what an assessment should measure.

    A blueprint constrains item generation.  It is not an attempt, score or
    mastery source and therefore never writes KernelState directly.
    """

    __tablename__ = "assessment_blueprints"
    __table_args__ = (
        UniqueConstraint(
            "learner_id", "client_request_id",
            name="uq_assessment_blueprint_learner_request",
        ),
    )

    id = Column(Integer, primary_key=True)
    learner_id = Column(Integer, ForeignKey("learners.id"), nullable=False, index=True)
    learning_task_id = Column(Integer, ForeignKey("learning_tasks.id"), nullable=False, index=True)
    project_id = Column(Integer, ForeignKey("projects.id"), nullable=True, index=True)
    checkpoint_id = Column(Integer, ForeignKey("checkpoints.id"), nullable=False, index=True)
    title = Column(String(255), nullable=False)
    purpose = Column(String(30), nullable=False, default="practice", index=True)
    target_subjects = Column(JSON, default=list)
    item_mix = Column(JSON, default=list)
    difficulty_distribution = Column(JSON, default=dict)
    success_policy = Column(JSON, default=dict)
    source_refs = Column(JSON, default=list)
    status = Column(String(30), nullable=False, default="draft", index=True)
    schema_version = Column(String(50), nullable=False, default="assessment-blueprint.v1")
    version = Column(Integer, nullable=False, default=1)
    created_by = Column(String(40), nullable=False, default="learning_design_agent")
    client_request_id = Column(String(160), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)


class AssessmentRubric(Base):
    """Deterministic grading contract attached to one assessment blueprint."""

    __tablename__ = "assessment_rubrics"
    __table_args__ = (
        UniqueConstraint("blueprint_id", "version", name="uq_assessment_rubric_version"),
    )

    id = Column(Integer, primary_key=True)
    blueprint_id = Column(Integer, ForeignKey("assessment_blueprints.id"), nullable=False, index=True)
    title = Column(String(255), nullable=False)
    criteria = Column(JSON, default=list)
    performance_levels = Column(JSON, default=list)
    scoring_policy = Column(JSON, default=dict)
    evidence_contract = Column(JSON, default=dict)
    learner_visibility = Column(JSON, default=dict)
    status = Column(String(30), nullable=False, default="draft", index=True)
    schema_version = Column(String(50), nullable=False, default="assessment-rubric.v1")
    version = Column(Integer, nullable=False, default=1)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)


class MicroLearningRun(Base):
    """Persistent projection for one focused, checkpoint-scoped learning loop.

    The run coordinates presentation and resume behavior.  It is not a second
    source of mastery truth: graded LearningAttempt and EvidenceEvent rows stay
    authoritative, and the run summary is rebuilt from those records.
    """

    __tablename__ = "micro_learning_runs"
    __table_args__ = (
        UniqueConstraint(
            "learner_id", "client_request_id",
            name="uq_micro_learning_run_learner_request",
        ),
    )

    id = Column(Integer, primary_key=True)
    learner_id = Column(Integer, ForeignKey("learners.id"), nullable=False, index=True)
    project_id = Column(Integer, ForeignKey("projects.id"), nullable=False, index=True)
    checkpoint_id = Column(Integer, ForeignKey("checkpoints.id"), nullable=False, index=True)
    session_id = Column(Integer, ForeignKey("agent_sessions.id"), nullable=True, index=True)
    goal = Column(Text, nullable=False)
    source_text = Column(Text, default="")
    source_type = Column(String(30), default="topic", nullable=False)
    status = Column(String(30), default="active", nullable=False, index=True)
    state = Column(String(40), default="learning_card", nullable=False, index=True)
    skill_plan = Column(JSON, default=dict)
    learning_card = Column(JSON, default=dict)
    teach_back = Column(JSON, default=dict)
    verification = Column(JSON, default=dict)
    summary = Column(JSON, default=dict)
    action_log = Column(JSON, default=list)
    client_request_id = Column(String(160), nullable=False)
    version = Column(Integer, default=1, nullable=False)
    started_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    completed_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)


class LearningSkillRun(Base):
    """Recoverable, session-scoped orchestration for conversational Skills.

    This row records workflow position and attachments only.  It is not an
    assessment or mastery source: verified evidence remains in
    LearningAttempt, EvidenceEvent, RemediationCase and ReviewSchedule.
    """

    __tablename__ = "learning_skill_runs"
    __table_args__ = (
        UniqueConstraint(
            "learner_id", "client_request_id",
            name="uq_learning_skill_run_learner_request",
        ),
    )

    id = Column(Integer, primary_key=True)
    learner_id = Column(Integer, ForeignKey("learners.id"), nullable=False, index=True)
    session_id = Column(Integer, ForeignKey("agent_sessions.id"), nullable=False, index=True)
    skill_id = Column(String(80), nullable=False, index=True)
    skill_version = Column(String(60), nullable=False, default="conversation-skill-runtime-v1")
    goal = Column(Text, nullable=False)
    status = Column(String(30), nullable=False, default="active", index=True)
    state = Column(String(50), nullable=False, index=True)
    step_index = Column(Integer, nullable=False, default=1)
    turn_count = Column(Integer, nullable=False, default=0)
    turn_budget = Column(Integer, nullable=False, default=5)
    run_data = Column(JSON, default=dict)
    action_log = Column(JSON, default=list)
    learning_task_id = Column(
        Integer, ForeignKey("learning_tasks.id"), nullable=True, index=True,
    )
    micro_learning_run_id = Column(
        Integer, ForeignKey("micro_learning_runs.id"), nullable=True, index=True,
    )
    client_request_id = Column(String(160), nullable=False)
    version = Column(Integer, nullable=False, default=1)
    started_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    completed_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)


class KernelState(Base):
    __tablename__ = "kernel_states"
    __table_args__ = (
        UniqueConstraint("learner_id", "kernel_name", name="uq_kernel_learner_name"),
    )

    id = Column(Integer, primary_key=True)
    learner_id = Column(Integer, ForeignKey("learners.id"), nullable=False, index=True)
    kernel_name = Column(String(30), nullable=False, index=True)
    short_term = Column(JSON, default=dict)
    long_term = Column(JSON, default=dict)
    action_chain = Column(JSON, default=list)
    evidence_refs = Column(JSON, default=list)
    confidence = Column(Float, default=0.0)
    version = Column(Integer, default=1)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class KernelHead(Base):
    """Bounded, rebuildable hot projection for one learner kernel.

    KernelState remains the compatibility projection and EvidenceEvent remains
    authoritative.  A head only keeps small references and facets needed for
    low-latency context assembly; evicting a reference never deletes memory.
    """

    __tablename__ = "kernel_heads"
    __table_args__ = (
        UniqueConstraint("learner_id", "kernel_name", name="uq_kernel_head_learner_name"),
    )

    id = Column(Integer, primary_key=True)
    learner_id = Column(Integer, ForeignKey("learners.id"), nullable=False, index=True)
    kernel_name = Column(String(30), nullable=False, index=True)
    summary = Column(Text, default="", nullable=False)
    focus_refs = Column(JSON, default=list)
    alert_refs = Column(JSON, default=list)
    working_refs = Column(JSON, default=list)
    stable_refs = Column(JSON, default=list)
    facets = Column(JSON, default=dict)
    token_estimate = Column(Integer, default=0, nullable=False)
    source_kernel_version = Column(Integer, default=0, nullable=False)
    version = Column(Integer, default=1, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class KernelMutation(Base):
    __tablename__ = "kernel_mutations"

    id = Column(Integer, primary_key=True)
    learner_id = Column(Integer, ForeignKey("learners.id"), nullable=False, index=True)
    event_id = Column(Integer, ForeignKey("evidence_events.id"), nullable=True, index=True)
    kernel_name = Column(String(30), nullable=False, index=True)
    mutation_type = Column(String(30), default="short_term")
    status = Column(String(30), default="applied")  # applied | proposed | rejected
    patch = Column(JSON, default=dict)
    reason = Column(Text, default="")
    before_version = Column(Integer, default=0)
    after_version = Column(Integer, default=0)
    created_at = Column(DateTime, default=datetime.utcnow)


class MemoryNode(Base):
    __tablename__ = "memory_nodes"

    id = Column(Integer, primary_key=True)
    learner_id = Column(Integer, ForeignKey("learners.id"), nullable=False, index=True)
    node_type = Column(String(20), nullable=False, index=True)  # fact | module | claim
    kernel_name = Column(String(30), nullable=False, index=True)
    memory_kind = Column(String(50), nullable=False, default="observation", index=True)
    subject_key = Column(String(255), nullable=False, default="global", index=True)
    subject_type = Column(String(50), nullable=False, default="global", index=True)
    subject_id = Column(String(255), nullable=False, default="", index=True)
    project_id = Column(Integer, ForeignKey("projects.id"), nullable=True, index=True)
    checkpoint_id = Column(Integer, ForeignKey("checkpoints.id"), nullable=True, index=True)
    session_id = Column(Integer, ForeignKey("agent_sessions.id"), nullable=True, index=True)
    text = Column(Text, nullable=False, default="")
    payload = Column(JSON, default=dict)
    confidence = Column(Float, default=0.0)
    salience = Column(Float, default=0.5, nullable=False, index=True)
    schema_version = Column(String(40), default="memory-item.v2", nullable=False)
    status = Column(String(30), default="active", nullable=False, index=True)
    valid_from = Column(DateTime, nullable=True, index=True)
    valid_to = Column(DateTime, nullable=True, index=True)
    occurred_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class MemorySynthesisRun(Base):
    __tablename__ = "memory_synthesis_runs"
    __table_args__ = (
        UniqueConstraint("learner_id", "input_fingerprint", name="uq_memory_run_input"),
    )

    id = Column(Integer, primary_key=True)
    learner_id = Column(Integer, ForeignKey("learners.id"), nullable=False, index=True)
    kernel_name = Column(String(30), nullable=False, index=True)
    subject_key = Column(String(255), nullable=False, default="global", index=True)
    status = Column(String(30), default="queued", nullable=False, index=True)
    trigger_reason = Column(String(80), default="threshold")
    candidate_fact_ids = Column(JSON, default=list)
    evidence_fact_ids = Column(JSON, default=list)
    base_module_node_id = Column(Integer, ForeignKey("memory_modules.node_id"), nullable=True, index=True)
    target_module_version = Column(Integer, default=1, nullable=False)
    input_fingerprint = Column(String(64), nullable=False, index=True)
    prompt_version = Column(String(40), default="memory-synthesis-v1")
    model_name = Column(String(100), default="deterministic")
    raw_output = Column(JSON, default=dict)
    validation_errors = Column(JSON, default=list)
    usage = Column(JSON, default=dict)
    attempt_count = Column(Integer, default=0)
    due_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
    started_at = Column(DateTime, nullable=True)
    finished_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class MemoryFact(Base):
    __tablename__ = "memory_facts"
    __table_args__ = (
        UniqueConstraint("source_mutation_id", "fact_ordinal", name="uq_memory_fact_mutation_ordinal"),
    )

    node_id = Column(Integer, ForeignKey("memory_nodes.id"), primary_key=True)
    source_event_id = Column(Integer, ForeignKey("evidence_events.id"), nullable=False, index=True)
    source_mutation_id = Column(Integer, ForeignKey("kernel_mutations.id"), nullable=False, index=True)
    fact_ordinal = Column(Integer, nullable=False)
    predicate = Column(String(255), nullable=False, index=True)
    object_value = Column(JSON, default=dict)
    evidence_grade = Column(String(30), default="observed", nullable=False, index=True)
    consumption_status = Column(String(30), default="eligible", nullable=False, index=True)
    consumed_by_module_id = Column(Integer, ForeignKey("memory_modules.node_id"), nullable=True, index=True)
    reservation_run_id = Column(Integer, ForeignKey("memory_synthesis_runs.id"), nullable=True, index=True)
    project_id = Column(Integer, ForeignKey("projects.id"), nullable=True, index=True)
    checkpoint_id = Column(Integer, ForeignKey("checkpoints.id"), nullable=True, index=True)
    session_id = Column(Integer, ForeignKey("agent_sessions.id"), nullable=True, index=True)


class MemoryModule(Base):
    __tablename__ = "memory_modules"

    node_id = Column(Integer, ForeignKey("memory_nodes.id"), primary_key=True)
    synthesis_run_id = Column(Integer, ForeignKey("memory_synthesis_runs.id"), nullable=True, index=True)
    module_type = Column(String(40), default="synthesis")
    summary = Column(Text, nullable=False)
    time_start = Column(DateTime, nullable=False, index=True)
    time_end = Column(DateTime, nullable=False, index=True)
    input_fingerprint = Column(String(64), nullable=False, unique=True, index=True)
    immutable = Column(Boolean, default=True, nullable=False)
    version = Column(Integer, default=1, nullable=False, index=True)
    parent_module_node_id = Column(Integer, ForeignKey("memory_modules.node_id"), nullable=True, index=True)
    revision_kind = Column(String(40), default="initial", nullable=False, index=True)
    evidence_fact_ids = Column(JSON, default=list)
    delta_fact_ids = Column(JSON, default=list)
    policy_version = Column(String(40), default="memory-module-version-v1", nullable=False)


class MemoryClaim(Base):
    __tablename__ = "memory_claims"

    node_id = Column(Integer, ForeignKey("memory_nodes.id"), primary_key=True)
    module_node_id = Column(Integer, ForeignKey("memory_modules.node_id"), nullable=False, index=True)
    claim_ordinal = Column(Integer, nullable=False)
    predicate = Column(String(255), nullable=False)
    value = Column(JSON, default=dict)
    verification_status = Column(String(30), default="supported", nullable=False, index=True)


class MemoryEdge(Base):
    __tablename__ = "memory_edges"
    __table_args__ = (
        UniqueConstraint(
            "source_node_id", "target_node_id", "relation_type",
            name="uq_memory_edge_relation",
        ),
    )

    id = Column(Integer, primary_key=True)
    learner_id = Column(Integer, ForeignKey("learners.id"), nullable=False, index=True)
    source_node_id = Column(Integer, ForeignKey("memory_nodes.id"), nullable=False, index=True)
    target_node_id = Column(Integer, ForeignKey("memory_nodes.id"), nullable=False, index=True)
    relation_type = Column(String(40), nullable=False, index=True)
    origin = Column(String(30), default="deterministic", nullable=False)
    confidence = Column(Float, default=1.0)
    evidence_event_id = Column(Integer, ForeignKey("evidence_events.id"), nullable=True, index=True)
    payload = Column(JSON, default=dict)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)


class AgentSession(Base):
    __tablename__ = "agent_sessions"

    id = Column(Integer, primary_key=True)
    learner_id = Column(Integer, ForeignKey("learners.id"), nullable=False, index=True)
    session_type = Column(String(30), default="global", index=True)
    project_id = Column(Integer, ForeignKey("projects.id"), nullable=True, index=True)
    checkpoint_id = Column(Integer, ForeignKey("checkpoints.id"), nullable=True, index=True)
    pending_action_id = Column(Integer, nullable=True)
    title = Column(String(255), default="学习 Tutor")
    status = Column(String(30), default="active", index=True)
    context_summary = Column(JSON, default=dict)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class AgentMessage(Base):
    __tablename__ = "agent_messages"

    id = Column(Integer, primary_key=True)
    session_id = Column(Integer, ForeignKey("agent_sessions.id"), nullable=False, index=True)
    role = Column(String(30), nullable=False)
    content = Column(Text, nullable=False)
    meta_data = Column(JSON, default=dict)
    idempotency_key = Column(String(160), nullable=True, unique=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)


class AgentAction(Base):
    __tablename__ = "agent_actions"

    id = Column(Integer, primary_key=True)
    session_id = Column(Integer, ForeignKey("agent_sessions.id"), nullable=False, index=True)
    learner_id = Column(Integer, ForeignKey("learners.id"), nullable=False, index=True)
    project_id = Column(Integer, ForeignKey("projects.id"), nullable=True, index=True)
    checkpoint_id = Column(Integer, ForeignKey("checkpoints.id"), nullable=True, index=True)
    capability = Column(String(80), nullable=False, index=True)
    status = Column(String(30), default="pending_confirmation", index=True)
    side_effect = Column(String(30), default="none")
    confirmation_policy = Column(String(30), default="none")
    target = Column(JSON, default=dict)
    result = Column(JSON, default=dict)
    evidence_target = Column(JSON, default=dict)
    next_affordances = Column(JSON, default=list)
    task_id = Column(Integer, ForeignKey("tasks.id"), nullable=True, index=True)
    idempotency_key = Column(String(160), nullable=True, unique=True, index=True)
    error = Column(JSON, default=dict)
    created_at = Column(DateTime, default=datetime.utcnow)
    started_at = Column(DateTime, nullable=True)
    finished_at = Column(DateTime, nullable=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class LearningProjectProposal(Base):
    __tablename__ = "learning_project_proposals"
    __table_args__ = (
        UniqueConstraint("session_id", "proposal_key", name="uq_project_proposal_session_key"),
    )

    id = Column(Integer, primary_key=True)
    learner_id = Column(Integer, ForeignKey("learners.id"), nullable=False, index=True)
    session_id = Column(Integer, ForeignKey("agent_sessions.id"), nullable=False, index=True)
    proposal_key = Column(String(100), nullable=False, index=True)
    proposal_type = Column(String(30), default="build", index=True)
    status = Column(String(30), default="draft", index=True)
    action_type = Column(String(30), default="create")  # create | enter_existing
    target_project_id = Column(Integer, ForeignKey("projects.id"), nullable=True, index=True)
    accepted_project_id = Column(Integer, ForeignKey("projects.id"), nullable=True, index=True)
    accepted_action_id = Column(Integer, ForeignKey("agent_actions.id"), nullable=True, index=True)
    artifact = Column(JSON, default=dict)
    revision = Column(Integer, default=1)
    locked_fields = Column(JSON, default=list)
    message_refs = Column(JSON, default=list)
    evidence_refs = Column(JSON, default=list)
    last_change_summary = Column(Text, default="")
    source_status = Column(String(30), default="idle", index=True)
    source_task_id = Column(Integer, ForeignKey("tasks.id"), nullable=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, index=True)


class ProjectProposalRevision(Base):
    __tablename__ = "project_proposal_revisions"
    __table_args__ = (
        UniqueConstraint("proposal_id", "revision", name="uq_project_proposal_revision"),
    )

    id = Column(Integer, primary_key=True)
    proposal_id = Column(
        Integer, ForeignKey("learning_project_proposals.id"), nullable=False, index=True,
    )
    revision = Column(Integer, nullable=False)
    source = Column(String(30), default="tutor")  # tutor | user | resource_search | system
    patch = Column(JSON, default=dict)
    snapshot = Column(JSON, default=dict)
    change_summary = Column(Text, default="")
    message_id = Column(Integer, ForeignKey("agent_messages.id"), nullable=True, index=True)
    evidence_id = Column(Integer, ForeignKey("evidence_events.id"), nullable=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)


class SchemaMigration(Base):
    __tablename__ = "schema_migrations"

    id = Column(Integer, primary_key=True)
    version = Column(String(100), nullable=False, unique=True)
    applied_at = Column(DateTime, default=datetime.utcnow)


class DesktopPetCapability(Base):
    """Short-lived, least-privilege credentials for the Tauri pet WebView.

    The raw capability is never stored.  It remains valid only while the
    parent desktop auth session and account epoch remain valid.
    """

    __tablename__ = "desktop_pet_capabilities"
    __table_args__ = (
        Index("ix_desktop_pet_capabilities_active", "auth_session_id", "expires_at"),
    )

    id = Column(Integer, primary_key=True)
    auth_session_id = Column(Integer, ForeignKey("auth_sessions.id"), nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("user_accounts.id"), nullable=False, index=True)
    learner_id = Column(Integer, ForeignKey("learners.id"), nullable=False, index=True)
    token_hash = Column(String(64), nullable=False, unique=True, index=True)
    scopes = Column(JSON, default=list, nullable=False)
    auth_epoch = Column(Integer, default=0, nullable=False, index=True)
    expires_at = Column(DateTime, nullable=False, index=True)
    revoked_at = Column(DateTime, nullable=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class DesktopPetContextPackage(Base):
    """TTL-bound external context explicitly confirmed for one Tutor turn.

    Raw content is temporary and is removed as soon as a package is consumed
    or expires.  The remaining receipt is operational provenance, not a
    learning artifact or evidence event.
    """

    __tablename__ = "desktop_pet_context_packages"
    __table_args__ = (
        Index("ix_desktop_pet_context_expiry", "learner_id", "status", "expires_at"),
    )

    id = Column(String(64), primary_key=True)
    learner_id = Column(Integer, ForeignKey("learners.id"), nullable=False, index=True)
    client_context_id = Column(String(160), nullable=True)
    session_id = Column(Integer, ForeignKey("agent_sessions.id"), nullable=True, index=True)
    kind = Column(String(40), nullable=False)
    status = Column(String(24), nullable=False, default="pending", index=True)
    content = Column(Text, nullable=True)
    content_sha256 = Column(String(64), nullable=False)
    source = Column(JSON, default=dict, nullable=False)
    confirmed_at = Column(DateTime, nullable=True)
    consumed_at = Column(DateTime, nullable=True)
    consumed_by_turn_id = Column(String(160), nullable=True)
    expires_at = Column(DateTime, nullable=False, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
