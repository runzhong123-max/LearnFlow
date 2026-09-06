from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine, async_sessionmaker
from sqlalchemy.orm import DeclarativeBase
from sqlalchemy import text, select, func, Integer, event
from pathlib import Path
from datetime import datetime, timedelta
import os
import shutil
import sqlite3

from app.core.config import settings

_sqlite = settings.database_url.startswith("sqlite")
engine = create_async_engine(
    settings.database_url,
    echo=False,
    connect_args={"timeout": 30} if _sqlite else {},
)


if _sqlite:
    @event.listens_for(engine.sync_engine, "connect")
    def _configure_sqlite_connection(dbapi_connection, _connection_record):
        """Let concurrent local workbenches wait for short writes to finish."""
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA busy_timeout=30000")
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()
async_session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


async def get_db():
    async with async_session() as session:
        try:
            yield session
        finally:
            await session.close()


# Lightweight migrations: columns added to existing models after the table
# was created. create_all() does not alter existing tables, so we add them
# explicitly (SQLite ADD COLUMN).
EXTRA_COLUMNS = {
    "projects": [
        ("learner_id", "INTEGER"),
        ("project_kind", "TEXT DEFAULT 'apprenticeship'"),
        ("project_mode", "TEXT NOT NULL DEFAULT 'learning'"),
        ("project_brief", "JSON NOT NULL DEFAULT '{}'"),
        ("visibility", "TEXT DEFAULT 'visible'"),
    ],
    "learners": [
        ("user_id", "INTEGER"),
    ],
    "user_accounts": [
        ("account_number", "INTEGER"),
        ("role", "TEXT DEFAULT 'user'"),
        ("password_version", "INTEGER DEFAULT 1"),
        ("auth_epoch", "INTEGER DEFAULT 0"),
        ("must_change_password", "BOOLEAN DEFAULT 0"),
        ("password_changed_at", "DATETIME"),
        ("password_upgraded_at", "DATETIME"),
        ("api_key_ciphertext", "TEXT"),
        ("api_key_nonce", "TEXT"),
        ("api_key_hint", "TEXT"),
        ("api_key_encryption_version", "INTEGER"),
        ("api_key_updated_at", "DATETIME"),
        ("provider_base_url", "TEXT"),
        ("provider_model", "TEXT"),
        ("vision_api_key_ciphertext", "TEXT"),
        ("vision_api_key_nonce", "TEXT"),
        ("vision_api_key_hint", "TEXT"),
        ("vision_api_key_encryption_version", "INTEGER"),
        ("vision_api_key_updated_at", "DATETIME"),
        ("vision_provider_base_url", "TEXT"),
        ("vision_provider_model", "TEXT"),
    ],
    "auth_sessions": [
        ("is_dev_login", "BOOLEAN DEFAULT 0"),
        ("auth_epoch", "INTEGER DEFAULT 0"),
        ("csrf_token_hash", "TEXT"),
        ("absolute_expires_at", "DATETIME"),
        ("idle_expires_at", "DATETIME"),
        ("revoked_reason", "TEXT"),
    ],
    "desktop_pet_context_packages": [
        ("client_context_id", "TEXT"),
    ],
    "checkpoints": [
        ("brief", "TEXT"),        # CheckpointBrief handoff contract (T2)
        ("archived", "BOOLEAN"), # T10: removed-but-kept checkpoints
        ("progress", "TEXT"),    # T10: learning progress stats
        ("learning_status", "TEXT"),
        ("legacy_completed", "BOOLEAN"),
        ("learning_contract", "TEXT"),
    ],
    "sources": [
        ("role", "TEXT"),        # T10: main | auxiliary
    ],
    "chunks": [
        ("source_version_id", "INTEGER"),
    ],
    "lectures": [
        ("plan", "TEXT"),        # T10: persisted section plan (resume stability)
        ("concept_graph", "TEXT"),  # concept map {nodes, edges}
        ("version", "INTEGER DEFAULT 1"),
    ],
    "exercises": [
        ("files", "TEXT"),        # project-mode: [{name, content, read_only}]
        ("entrypoint", "TEXT"),   # main file to run
        ("requirements", "TEXT"), # ["torch", "scikit-learn"]
        ("judge_mode", "TEXT"),  # test_cases | stdout_check
        ("judge_config", "TEXT"),# {pattern, min_accuracy} for stdout_check
        ("assessment_meta", "TEXT"),
    ],
    "concept_questions": [
        ("assessment_meta", "TEXT"),
    ],
    "tasks": [
        ("agent_action_id", "INTEGER"),
        ("learner_id", "INTEGER"),
    ],
    "agent_messages": [
        ("idempotency_key", "TEXT"),
    ],
    "evidence_events": [
        ("occurred_at", "DATETIME"),
        ("learner_seq", "INTEGER"),
        ("actor_type", "TEXT"),
    ],
    "learning_attempts": [
        ("remediation_case_id", "INTEGER"),
        ("attempt_role", "TEXT DEFAULT 'original'"),
        ("client_submission_id", "TEXT"),
    ],
    "memory_nodes": [
        ("memory_kind", "TEXT DEFAULT 'observation'"),
        ("subject_type", "TEXT DEFAULT 'global'"),
        ("subject_id", "TEXT DEFAULT ''"),
        ("project_id", "INTEGER"),
        ("checkpoint_id", "INTEGER"),
        ("session_id", "INTEGER"),
        ("salience", "REAL DEFAULT 0.5"),
        ("schema_version", "TEXT DEFAULT 'memory-item.v2'"),
    ],
    "memory_synthesis_runs": [
        ("evidence_fact_ids", "JSON DEFAULT '[]'"),
        ("base_module_node_id", "INTEGER"),
        ("target_module_version", "INTEGER DEFAULT 1"),
    ],
    "memory_modules": [
        ("version", "INTEGER DEFAULT 1"),
        ("parent_module_node_id", "INTEGER"),
        ("revision_kind", "TEXT DEFAULT 'initial'"),
        ("evidence_fact_ids", "JSON DEFAULT '[]'"),
        ("delta_fact_ids", "JSON DEFAULT '[]'"),
        ("policy_version", "TEXT DEFAULT 'memory-module-version-v1'"),
    ],
    "process_animations": [
        ("kind", "TEXT"),         # animation | static（表已存在时补列）
    ],
    "lecture_versions": [
        ("source_version", "INTEGER DEFAULT 1"),
        ("idempotency_key", "TEXT"),
    ],
    "learning_skill_runs": [
        ("learning_task_id", "INTEGER"),
    ],
}

FIVE_KERNEL_MIGRATION = "v2-five-kernel-tutor"
PROJECT_PROPOSAL_MIGRATION = "v3-evolving-project-proposals"
USER_ISOLATION_MIGRATION = "v4-user-isolation-profile-badges"
MEMORY_GRAPH_MIGRATION = "v5-inspectable-memory-graph"
DESKTOP_WORKSPACE_MIGRATION = "v6-desktop-workspace"
CHECKPOINT_TUTOR_MIGRATION = "v7-checkpoint-tutor-sessions"
MANAGED_ARTIFACT_MIGRATION = "v8-managed-learning-artifacts"
LOCAL_AGENT_BROKER_MIGRATION = "v9-local-agent-broker"
REVIEW_WORKBENCH_MIGRATION = "v10-review-workbench"
FIVE_KERNEL_MEMORY_FABRIC_MIGRATION = "v11-five-kernel-memory-fabric"
MEMORY_MODULE_VERSIONING_MIGRATION = "v12-memory-module-versioning"
MICRO_LEARNING_MIGRATION = "v13-focused-micro-learning"
CONVERSATION_SKILL_RUNTIME_MIGRATION = "v14-conversation-skill-runtime"
LEARNING_TASK_RUNTIME_MIGRATION = "v15-learning-task-runtime"
ATOMIC_LEARNING_SKILL_MIGRATION = "v16-atomic-learning-skill-runtime"
PERSONAL_CONCEPT_GRAPH_MIGRATION = "v17-personal-concept-learning-graph"
ASSESSMENT_BLUEPRINT_MIGRATION = "v18-assessment-blueprint-rubric"
AUTH_PHASE_A_MIGRATION = "v19-auth-rbac-phase-a"
DOMAIN_KNOWLEDGE_MIGRATION = "v20-domain-knowledge-supply"
DESKTOP_PET_MIGRATION = "v21-desktop-pet"


def _sqlite_path() -> Path | None:
    prefix = "sqlite+aiosqlite:///"
    if not settings.database_url.startswith(prefix):
        return None
    raw = settings.database_url[len(prefix):]
    return Path(raw).expanduser().resolve()


def _migration_applied(path: Path, version: str) -> bool:
    if not path.exists() or path.stat().st_size == 0:
        return False
    try:
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        try:
            has_table = conn.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'"
            ).fetchone()
            if not has_table:
                return False
            return conn.execute(
                "SELECT 1 FROM schema_migrations WHERE version=?", (version,)
            ).fetchone() is not None
        finally:
            conn.close()
    except sqlite3.Error:
        return False


def _backup_before_five_kernel_migration():
    path = _sqlite_path()
    if not path or not path.exists() or path.stat().st_size == 0 or _migration_applied(path, FIVE_KERNEL_MIGRATION):
        return
    backup_dir = path.parent / "backups"
    backup_dir.mkdir(parents=True, exist_ok=True)
    backup_path = backup_dir / f"{path.stem}-pre-five-kernel-v2{path.suffix}"
    if backup_path.exists():
        return
    required = path.stat().st_size + 64 * 1024 * 1024
    if shutil.disk_usage(path.parent).free < required:
        raise RuntimeError(
            f"数据库迁移需要至少 {required // (1024 * 1024)}MB 可用空间来创建安全备份"
        )
    temp_path = backup_path.with_suffix(backup_path.suffix + ".tmp")
    temp_path.unlink(missing_ok=True)
    source = sqlite3.connect(path)
    destination = sqlite3.connect(temp_path)
    try:
        source.backup(destination)
        check = destination.execute("PRAGMA quick_check").fetchone()
        if not check or check[0] != "ok":
            raise RuntimeError("数据库迁移备份完整性检查失败")
    except Exception:
        temp_path.unlink(missing_ok=True)
        raise
    finally:
        destination.close()
        source.close()
    os.replace(temp_path, backup_path)
    print(f"[migrate] backup created: {backup_path}")


def _backup_before_project_proposal_migration():
    path = _sqlite_path()
    if not path or not path.exists() or path.stat().st_size == 0:
        return
    if _migration_applied(path, PROJECT_PROPOSAL_MIGRATION):
        return
    backup_dir = path.parent / "backups"
    backup_dir.mkdir(parents=True, exist_ok=True)
    backup_path = backup_dir / f"{path.stem}-pre-project-proposals-v3{path.suffix}"
    if backup_path.exists():
        return
    required = path.stat().st_size + 64 * 1024 * 1024
    if shutil.disk_usage(path.parent).free < required:
        raise RuntimeError(
            f"数据库迁移需要至少 {required // (1024 * 1024)}MB 可用空间来创建安全备份"
        )
    temp_path = backup_path.with_suffix(backup_path.suffix + ".tmp")
    temp_path.unlink(missing_ok=True)
    source = sqlite3.connect(path)
    destination = sqlite3.connect(temp_path)
    try:
        source.backup(destination)
        check = destination.execute("PRAGMA quick_check").fetchone()
        if not check or check[0] != "ok":
            raise RuntimeError("数据库迁移备份完整性检查失败")
    except Exception:
        temp_path.unlink(missing_ok=True)
        raise
    finally:
        destination.close()
        source.close()
    os.replace(temp_path, backup_path)
    print(f"[migrate] backup created: {backup_path}")


def _backup_before_user_isolation_migration():
    path = _sqlite_path()
    if not path or not path.exists() or path.stat().st_size == 0:
        return
    if _migration_applied(path, USER_ISOLATION_MIGRATION):
        return
    backup_dir = path.parent / "backups"
    backup_dir.mkdir(parents=True, exist_ok=True)
    backup_path = backup_dir / f"{path.stem}-pre-user-isolation-v4{path.suffix}"
    if backup_path.exists():
        return
    required = path.stat().st_size + 64 * 1024 * 1024
    if shutil.disk_usage(path.parent).free < required:
        raise RuntimeError(
            f"数据库迁移需要至少 {required // (1024 * 1024)}MB 可用空间来创建安全备份"
        )
    temp_path = backup_path.with_suffix(backup_path.suffix + ".tmp")
    temp_path.unlink(missing_ok=True)
    source = sqlite3.connect(path)
    destination = sqlite3.connect(temp_path)
    try:
        source.backup(destination)
        check = destination.execute("PRAGMA quick_check").fetchone()
        if not check or check[0] != "ok":
            raise RuntimeError("数据库迁移备份完整性检查失败")
    except Exception:
        temp_path.unlink(missing_ok=True)
        raise
    finally:
        destination.close()
        source.close()
    os.replace(temp_path, backup_path)
    print(f"[migrate] backup created: {backup_path}")


def _backup_before_memory_graph_migration():
    path = _sqlite_path()
    if not path or not path.exists() or path.stat().st_size == 0:
        return
    if _migration_applied(path, MEMORY_GRAPH_MIGRATION):
        return
    backup_dir = path.parent / "backups"
    backup_dir.mkdir(parents=True, exist_ok=True)
    backup_path = backup_dir / f"{path.stem}-pre-memory-graph-v5{path.suffix}"
    if backup_path.exists():
        return
    required = path.stat().st_size + 64 * 1024 * 1024
    if shutil.disk_usage(path.parent).free < required:
        raise RuntimeError(
            f"数据库迁移需要至少 {required // (1024 * 1024)}MB 可用空间来创建安全备份"
        )
    temp_path = backup_path.with_suffix(backup_path.suffix + ".tmp")
    temp_path.unlink(missing_ok=True)
    source = sqlite3.connect(path)
    destination = sqlite3.connect(temp_path)
    try:
        source.backup(destination)
        check = destination.execute("PRAGMA quick_check").fetchone()
        if not check or check[0] != "ok":
            raise RuntimeError("数据库迁移备份完整性检查失败")
    except Exception:
        temp_path.unlink(missing_ok=True)
        raise
    finally:
        destination.close()
        source.close()
    os.replace(temp_path, backup_path)
    print(f"[migrate] backup created: {backup_path}")


def _backup_before_desktop_workspace_migration():
    path = _sqlite_path()
    if not path or not path.exists() or path.stat().st_size == 0:
        return
    if _migration_applied(path, DESKTOP_WORKSPACE_MIGRATION):
        return
    backup_dir = path.parent / "backups"
    backup_dir.mkdir(parents=True, exist_ok=True)
    backup_path = backup_dir / f"{path.stem}-pre-desktop-workspace-v6{path.suffix}"
    if backup_path.exists():
        return
    required = path.stat().st_size + 64 * 1024 * 1024
    if shutil.disk_usage(path.parent).free < required:
        raise RuntimeError(
            f"数据库迁移需要至少 {required // (1024 * 1024)}MB 可用空间来创建安全备份"
        )
    temp_path = backup_path.with_suffix(backup_path.suffix + ".tmp")
    temp_path.unlink(missing_ok=True)
    source = sqlite3.connect(path)
    destination = sqlite3.connect(temp_path)
    try:
        source.backup(destination)
        check = destination.execute("PRAGMA quick_check").fetchone()
        if not check or check[0] != "ok":
            raise RuntimeError("数据库迁移备份完整性检查失败")
    except Exception:
        temp_path.unlink(missing_ok=True)
        raise
    finally:
        destination.close()
        source.close()
    os.replace(temp_path, backup_path)
    print(f"[migrate] backup created: {backup_path}")


def _backup_before_checkpoint_tutor_migration():
    path = _sqlite_path()
    if (
        not path or not path.exists() or path.stat().st_size == 0
        or _migration_applied(path, CHECKPOINT_TUTOR_MIGRATION)
    ):
        return
    backup_dir = path.parent / "backups"
    backup_dir.mkdir(parents=True, exist_ok=True)
    backup_path = backup_dir / f"{path.stem}-pre-checkpoint-tutor-v7{path.suffix}"
    if backup_path.exists():
        return
    required = path.stat().st_size + 64 * 1024 * 1024
    if shutil.disk_usage(path.parent).free < required:
        raise RuntimeError(
            f"数据库迁移需要至少 {required // (1024 * 1024)}MB 可用空间来创建安全备份"
        )
    temp_path = backup_path.with_suffix(backup_path.suffix + ".tmp")
    temp_path.unlink(missing_ok=True)
    source = sqlite3.connect(path)
    destination = sqlite3.connect(temp_path)
    try:
        source.backup(destination)
        check = destination.execute("PRAGMA quick_check").fetchone()
        if not check or check[0] != "ok":
            raise RuntimeError("数据库迁移备份完整性检查失败")
    except Exception:
        temp_path.unlink(missing_ok=True)
        raise
    finally:
        destination.close()
        source.close()
    os.replace(temp_path, backup_path)
    print(f"[migrate] backup created: {backup_path}")


def _backup_before_managed_artifact_migration():
    path = _sqlite_path()
    if (
        not path or not path.exists() or path.stat().st_size == 0
        or _migration_applied(path, MANAGED_ARTIFACT_MIGRATION)
    ):
        return
    backup_dir = path.parent / "backups"
    backup_dir.mkdir(parents=True, exist_ok=True)
    backup_path = backup_dir / f"{path.stem}-pre-managed-artifacts-v8{path.suffix}"
    if backup_path.exists():
        return
    required = path.stat().st_size + 64 * 1024 * 1024
    if shutil.disk_usage(path.parent).free < required:
        raise RuntimeError(
            f"数据库迁移需要至少 {required // (1024 * 1024)}MB 可用空间来创建安全备份"
        )
    temp_path = backup_path.with_suffix(backup_path.suffix + ".tmp")
    temp_path.unlink(missing_ok=True)
    source = sqlite3.connect(path)
    destination = sqlite3.connect(temp_path)
    try:
        source.backup(destination)
        check = destination.execute("PRAGMA quick_check").fetchone()
        if not check or check[0] != "ok":
            raise RuntimeError("数据库迁移备份完整性检查失败")
    except Exception:
        temp_path.unlink(missing_ok=True)
        raise
    finally:
        destination.close()
        source.close()
    os.replace(temp_path, backup_path)
    print(f"[migrate] backup created: {backup_path}")


def _backup_before_review_workbench_migration():
    path = _sqlite_path()
    if (
        not path or not path.exists() or path.stat().st_size == 0
        or _migration_applied(path, REVIEW_WORKBENCH_MIGRATION)
    ):
        return
    backup_dir = path.parent / "backups"
    backup_dir.mkdir(parents=True, exist_ok=True)
    backup_path = path.parent / "backups" / f"{path.stem}-pre-review-v10{path.suffix}"
    if backup_path.exists():
        return
    required = path.stat().st_size + 64 * 1024 * 1024
    if shutil.disk_usage(path.parent).free < required:
        raise RuntimeError(
            f"数据库迁移需要至少 {required // (1024 * 1024)}MB 可用空间来创建安全备份"
        )
    temp_path = backup_path.with_suffix(backup_path.suffix + ".tmp")
    temp_path.unlink(missing_ok=True)
    source = sqlite3.connect(path)
    destination = sqlite3.connect(temp_path)
    try:
        source.backup(destination)
        check = destination.execute("PRAGMA quick_check").fetchone()
        if not check or check[0] != "ok":
            raise RuntimeError("数据库迁移备份完整性检查失败")
    except Exception:
        temp_path.unlink(missing_ok=True)
        raise
    finally:
        destination.close()
        source.close()
    os.replace(temp_path, backup_path)
    print(f"[migrate] backup created: {backup_path}")


def _backup_before_five_kernel_memory_fabric_migration():
    path = _sqlite_path()
    if (
        not path or not path.exists() or path.stat().st_size == 0
        or _migration_applied(path, FIVE_KERNEL_MEMORY_FABRIC_MIGRATION)
    ):
        return
    backup_dir = path.parent / "backups"
    backup_dir.mkdir(parents=True, exist_ok=True)
    backup_path = backup_dir / f"{path.stem}-pre-five-kernel-memory-v11{path.suffix}"
    if backup_path.exists():
        return
    required = path.stat().st_size + 64 * 1024 * 1024
    if shutil.disk_usage(path.parent).free < required:
        raise RuntimeError(
            f"数据库迁移需要至少 {required // (1024 * 1024)}MB 可用空间来创建安全备份"
        )
    temp_path = backup_path.with_suffix(backup_path.suffix + ".tmp")
    temp_path.unlink(missing_ok=True)
    source = sqlite3.connect(path)
    destination = sqlite3.connect(temp_path)
    try:
        source.backup(destination)
        check = destination.execute("PRAGMA quick_check").fetchone()
        if not check or check[0] != "ok":
            raise RuntimeError("数据库迁移备份完整性检查失败")
    except Exception:
        temp_path.unlink(missing_ok=True)
        raise
    finally:
        destination.close()
        source.close()
    os.replace(temp_path, backup_path)
    print(f"[migrate] backup created: {backup_path}")


def _backup_before_memory_module_versioning_migration():
    path = _sqlite_path()
    if (
        not path or not path.exists() or path.stat().st_size == 0
        or _migration_applied(path, MEMORY_MODULE_VERSIONING_MIGRATION)
    ):
        return
    backup_dir = path.parent / "backups"
    backup_dir.mkdir(parents=True, exist_ok=True)
    backup_path = backup_dir / f"{path.stem}-pre-memory-module-v12{path.suffix}"
    if backup_path.exists():
        return
    required = path.stat().st_size + 64 * 1024 * 1024
    if shutil.disk_usage(path.parent).free < required:
        raise RuntimeError(
            f"数据库迁移需要至少 {required // (1024 * 1024)}MB 可用空间来创建安全备份"
        )
    temp_path = backup_path.with_suffix(backup_path.suffix + ".tmp")
    temp_path.unlink(missing_ok=True)
    source = sqlite3.connect(path)
    destination = sqlite3.connect(temp_path)
    try:
        source.backup(destination)
        check = destination.execute("PRAGMA quick_check").fetchone()
        if not check or check[0] != "ok":
            raise RuntimeError("数据库迁移备份完整性检查失败")
    except Exception:
        temp_path.unlink(missing_ok=True)
        raise
    finally:
        destination.close()
        source.close()
    os.replace(temp_path, backup_path)
    print(f"[migrate] backup created: {backup_path}")


def _backup_before_auth_phase_a_migration():
    path = _sqlite_path()
    if (
        not path or not path.exists() or path.stat().st_size == 0
        or _migration_applied(path, AUTH_PHASE_A_MIGRATION)
    ):
        return
    backup_dir = path.parent / "backups"
    backup_dir.mkdir(parents=True, exist_ok=True)
    backup_path = backup_dir / f"{path.stem}-pre-auth-phase-a-v19{path.suffix}"
    if backup_path.exists():
        return
    required = path.stat().st_size + 64 * 1024 * 1024
    if shutil.disk_usage(path.parent).free < required:
        raise RuntimeError(
            f"数据库迁移需要至少 {required // (1024 * 1024)}MB 可用空间来创建安全备份"
        )
    temp_path = backup_path.with_suffix(backup_path.suffix + ".tmp")
    temp_path.unlink(missing_ok=True)
    source = sqlite3.connect(path)
    destination = sqlite3.connect(temp_path)
    try:
        source.backup(destination)
        check = destination.execute("PRAGMA quick_check").fetchone()
        if not check or check[0] != "ok":
            raise RuntimeError("数据库迁移备份完整性检查失败")
    except Exception:
        temp_path.unlink(missing_ok=True)
        raise
    finally:
        destination.close()
        source.close()
    os.replace(temp_path, backup_path)
    print(f"[migrate] backup created: {backup_path}")


async def _ensure_columns():
    async with engine.begin() as conn:
        for table, cols in EXTRA_COLUMNS.items():
            result = await conn.execute(text(f"PRAGMA table_info({table})"))
            existing = {row[1] for row in result.fetchall()}
            for col, coltype in cols:
                if col not in existing:
                    await conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {col} {coltype}"))
                    print(f"[migrate] added column {table}.{col} ({coltype})")

        indexes = [
            ("ix_projects_learner_id", "projects", "learner_id"),
            ("ix_projects_project_kind", "projects", "project_kind"),
            ("ix_projects_visibility", "projects", "visibility"),
            ("ix_learners_user_id", "learners", "user_id"),
            ("ix_user_accounts_role", "user_accounts", "role"),
            ("ix_auth_sessions_auth_epoch", "auth_sessions", "auth_epoch"),
            ("ix_auth_sessions_absolute_expires_at", "auth_sessions", "absolute_expires_at"),
            ("ix_auth_sessions_idle_expires_at", "auth_sessions", "idle_expires_at"),
            ("ix_checkpoints_learning_status", "checkpoints", "learning_status"),
            ("ix_tasks_agent_action_id", "tasks", "agent_action_id"),
            ("ix_tasks_learner_id", "tasks", "learner_id"),
            ("ix_agent_messages_idempotency_key", "agent_messages", "idempotency_key"),
            ("ix_evidence_events_occurred_at", "evidence_events", "occurred_at"),
            ("ix_evidence_events_learner_seq", "evidence_events", "learner_seq"),
            ("ix_evidence_events_actor_type", "evidence_events", "actor_type"),
            ("ix_learning_attempts_remediation_case_id", "learning_attempts", "remediation_case_id"),
            ("ix_learning_attempts_attempt_role", "learning_attempts", "attempt_role"),
            ("ix_learning_attempts_client_submission_id", "learning_attempts", "client_submission_id"),
            ("ix_memory_nodes_memory_kind", "memory_nodes", "memory_kind"),
            ("ix_memory_nodes_subject_type", "memory_nodes", "subject_type"),
            ("ix_memory_nodes_subject_id", "memory_nodes", "subject_id"),
            ("ix_memory_nodes_project_id", "memory_nodes", "project_id"),
            ("ix_memory_nodes_checkpoint_id", "memory_nodes", "checkpoint_id"),
            ("ix_memory_nodes_session_id", "memory_nodes", "session_id"),
            ("ix_memory_nodes_salience", "memory_nodes", "salience"),
            ("ix_memory_synthesis_runs_base_module_node_id", "memory_synthesis_runs", "base_module_node_id"),
            ("ix_memory_modules_version", "memory_modules", "version"),
            ("ix_memory_modules_parent_module_node_id", "memory_modules", "parent_module_node_id"),
            ("ix_memory_modules_revision_kind", "memory_modules", "revision_kind"),
            ("ix_lecture_versions_idempotency_key", "lecture_versions", "idempotency_key"),
        ]
        for name, table, column in indexes:
            unique = "UNIQUE " if name in {
                "ix_agent_messages_idempotency_key",
                "ix_learning_attempts_client_submission_id",
                "ix_lecture_versions_idempotency_key",
            } else ""
            await conn.execute(text(
                f"CREATE {unique}INDEX IF NOT EXISTS {name} ON {table} ({column})"
            ))

        await conn.execute(text(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_evidence_learner_seq_idx "
            "ON evidence_events (learner_id, learner_seq)"
        ))
        await conn.execute(text(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_session_checkpoint_scope_idx "
            "ON agent_sessions (learner_id, project_id, checkpoint_id) "
            "WHERE session_type = 'checkpoint' AND status = 'active'"
        ))
        await conn.execute(text(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_desktop_pet_context_learner_client_idx "
            "ON desktop_pet_context_packages (learner_id, client_context_id) "
            "WHERE client_context_id IS NOT NULL"
        ))


async def _backfill_five_kernel():
    from app.models.project import Project, Roadmap, Checkpoint, Lecture
    from app.models.learning import (
        Learner, EvidenceEvent, KernelState, AgentSession, AgentMessage,
        SchemaMigration,
    )

    async with async_session() as db:
        applied = (await db.execute(
            select(SchemaMigration).where(SchemaMigration.version == FIVE_KERNEL_MIGRATION)
        )).scalar_one_or_none()
        if applied:
            return

        learner = (await db.execute(
            select(Learner).where(Learner.key == "local-default")
        )).scalar_one_or_none()
        if not learner:
            learner = Learner(key="local-default", display_name="本地学习者")
            db.add(learner)
            await db.flush()

        projects = (await db.execute(select(Project))).scalars().all()
        migration_event_ids = set((await db.execute(
            select(EvidenceEvent.client_event_id).where(
                EvidenceEvent.client_event_id.like("migration:%")
            )
        )).scalars().all())
        for project in projects:
            project.learner_id = learner.id
            event_id = f"migration:project:{project.id}"
            if event_id not in migration_event_ids:
                db.add(EvidenceEvent(
                    learner_id=learner.id,
                    project_id=project.id,
                    event_type="project_imported",
                    source="migration",
                    context_id=f"project:{project.id}",
                    payload={"name": project.name, "description": project.description or ""},
                    confidence=1.0,
                    provenance={"migration": FIVE_KERNEL_MIGRATION},
                    client_event_id=event_id,
                    created_at=project.created_at,
                ))

        existing_kernels = set((await db.execute(
            select(KernelState.kernel_name).where(KernelState.learner_id == learner.id)
        )).scalars().all())
        for kernel_name in ("structure", "knowledge", "human", "value", "practice"):
            if kernel_name not in existing_kernels:
                db.add(KernelState(
                    learner_id=learner.id,
                    kernel_name=kernel_name,
                    short_term={}, long_term={}, action_chain=[], evidence_refs=[], confidence=0.0,
                ))

        lectures = set((await db.execute(select(Lecture.checkpoint_id))).scalars().all())
        checkpoints = (await db.execute(select(Checkpoint))).scalars().all()
        for cp in checkpoints:
            progress = dict(cp.progress or {})
            if not cp.learning_status:
                if cp.completed:
                    cp.learning_status = "verification_due"
                elif cp.id in lectures or progress:
                    cp.learning_status = "in_progress"
                else:
                    cp.learning_status = "not_started"
            if cp.legacy_completed is None:
                cp.legacy_completed = bool(cp.completed)

            brief = dict(cp.brief or {})
            concepts = brief.get("key_concepts") or brief.get("concepts") or []
            if not cp.learning_contract:
                cp.learning_contract = {
                    "concept_ids": concepts,
                    "knowledge_target": {"checkpoint_id": cp.id},
                    "practice_target": {"requires_generation": True},
                    "exit_criteria": ["knowledge_verified", "independent_practice"],
                    "source": "migration",
                }
            roadmap = await db.get(Roadmap, cp.roadmap_id)
            project_id = roadmap.project_id if roadmap else None
            event_id = f"migration:checkpoint:{cp.id}"
            if event_id not in migration_event_ids:
                db.add(EvidenceEvent(
                    learner_id=learner.id,
                    project_id=project_id,
                    checkpoint_id=cp.id,
                    event_type="checkpoint_imported",
                    source="migration",
                    context_id=f"project:{project_id}/checkpoint:{cp.id}",
                    payload={
                        "title": cp.title,
                        "legacy_completed": bool(cp.completed),
                        "has_lecture": cp.id in lectures,
                        "aggregate_progress": progress,
                    },
                    confidence=0.4 if cp.completed else 0.8,
                    provenance={"migration": FIVE_KERNEL_MIGRATION, "aggregate_only": True},
                    client_event_id=event_id,
                    created_at=cp.created_at,
                ))

        global_session = (await db.execute(select(AgentSession).where(
            AgentSession.learner_id == learner.id,
            AgentSession.session_type == "global",
            AgentSession.project_id.is_(None),
        ).limit(1))).scalar_one_or_none()
        if not global_session:
            db.add(AgentSession(
                learner_id=learner.id,
                session_type="global",
                title="学习 Tutor",
                status="active",
            ))

        roadmaps = (await db.execute(select(Roadmap))).scalars().all()
        imported_sessions = (await db.execute(select(AgentSession).where(
            AgentSession.learner_id == learner.id,
            AgentSession.session_type == "project",
        ))).scalars().all()
        imported_project_ids = {
            session.project_id for session in imported_sessions
            if (session.context_summary or {}).get("imported_from") == "roadmap.conversation_history"
        }
        for roadmap in roadmaps:
            history = list(roadmap.conversation_history or [])
            if not history or roadmap.project_id in imported_project_ids:
                continue
            session = AgentSession(
                learner_id=learner.id,
                session_type="project",
                project_id=roadmap.project_id,
                title="项目 Tutor",
                status="active",
                context_summary={"imported_from": "roadmap.conversation_history"},
            )
            db.add(session)
            await db.flush()
            for message in history:
                role = message.get("role") if isinstance(message, dict) else "assistant"
                content = message.get("content", "") if isinstance(message, dict) else str(message)
                if content:
                    db.add(AgentMessage(
                        session_id=session.id,
                        role=role if role in ("user", "assistant") else "assistant",
                        content=content,
                        meta_data={"provenance": "legacy_roadmap_history"},
                    ))

        db.add(SchemaMigration(version=FIVE_KERNEL_MIGRATION))
        await db.commit()
        print(f"[migrate] applied {FIVE_KERNEL_MIGRATION}")


async def _mark_project_proposal_migration():
    from app.models.learning import SchemaMigration

    async with async_session() as db:
        applied = (await db.execute(
            select(SchemaMigration).where(
                SchemaMigration.version == PROJECT_PROPOSAL_MIGRATION
            )
        )).scalar_one_or_none()
        if applied:
            return
        db.add(SchemaMigration(version=PROJECT_PROPOSAL_MIGRATION))
        await db.commit()
        print(f"[migrate] applied {PROJECT_PROPOSAL_MIGRATION}")


async def _backfill_user_isolation():
    from app.models.learning import (
        EvidenceEvent, Learner, UserAccount, LearnerProfile, LearningLifeEvent,
        LearnerBadge, LearningProjectProposal, SchemaMigration,
    )
    from app.models.project import Project, Roadmap, Checkpoint, Task

    async with async_session() as db:
        applied = (await db.execute(select(SchemaMigration).where(
            SchemaMigration.version == USER_ISOLATION_MIGRATION
        ))).scalar_one_or_none()
        if applied:
            return

        legacy_learner = (await db.execute(
            select(Learner).where(Learner.key == "local-default")
        )).scalar_one_or_none()
        legacy_account = (await db.execute(
            select(UserAccount).where(UserAccount.username_normalized == "legacy-demo")
        )).scalar_one_or_none()
        if not legacy_account:
            legacy_account = UserAccount(
                username="legacy-demo",
                username_normalized="legacy-demo",
                password_hash=None,
                is_legacy_demo=True,
            )
            db.add(legacy_account)
            await db.flush()
        if not legacy_learner:
            legacy_learner = Learner(
                user_id=legacy_account.id,
                key="local-default",
                display_name="现有学习者",
            )
            db.add(legacy_learner)
            await db.flush()
        else:
            legacy_learner.user_id = legacy_account.id
            if legacy_learner.display_name == "本地学习者":
                legacy_learner.display_name = "现有学习者"

        orphan_learners = (await db.execute(select(Learner).where(
            Learner.user_id.is_(None), Learner.id != legacy_learner.id,
        ))).scalars().all()
        for learner in orphan_learners:
            normalized = f"legacy-learner-{learner.id}"
            account = (await db.execute(select(UserAccount).where(
                UserAccount.username_normalized == normalized,
            ))).scalar_one_or_none()
            if not account:
                account = UserAccount(
                    username=normalized,
                    username_normalized=normalized,
                    password_hash=None,
                    is_legacy_demo=True,
                )
                db.add(account)
                await db.flush()
            learner.user_id = account.id
            if not await db.get(LearnerProfile, learner.id):
                db.add(LearnerProfile(
                    learner_id=learner.id,
                    education_stage="other",
                    background="由 LearnFlow 单用户版本迁移",
                    focus_areas=[],
                    weekly_hours=5,
                    preferred_modes=["explanation", "project", "practice"],
                    career_goal="",
                    career_goal_status="exploring",
                ))

        profile = await db.get(LearnerProfile, legacy_learner.id)
        if not profile:
            project_names = list((await db.execute(
                select(Project.name).where(Project.learner_id == legacy_learner.id).limit(5)
            )).scalars().all())
            db.add(LearnerProfile(
                learner_id=legacy_learner.id,
                education_stage="other",
                background="由 LearnFlow 单用户版本迁移",
                focus_areas=project_names or ["自主学习"],
                weekly_hours=5,
                preferred_modes=["explanation", "project", "practice"],
                career_goal="",
                career_goal_status="exploring",
            ))

        projects = (await db.execute(select(Project))).scalars().all()
        for project in projects:
            if project.learner_id is None:
                project.learner_id = legacy_learner.id

        tasks = (await db.execute(select(Task))).scalars().all()
        proposals_by_task = {
            item.source_task_id: item.learner_id
            for item in (await db.execute(select(LearningProjectProposal))).scalars().all()
            if item.source_task_id
        }
        project_owner = {project.id: project.learner_id for project in projects}
        for task in tasks:
            if task.learner_id:
                continue
            task.learner_id = project_owner.get(task.project_id) or proposals_by_task.get(task.id) or legacy_learner.id

        for project in projects:
            counts = (await db.execute(
                select(
                    func.count(Checkpoint.id),
                    func.sum((Checkpoint.learning_status == "completed").cast(Integer)),
                )
                .select_from(Roadmap)
                .join(Checkpoint, Checkpoint.roadmap_id == Roadmap.id)
                .where(Roadmap.project_id == project.id, Checkpoint.archived.is_(False))
            )).one()
            total, completed = counts[0] or 0, counts[1] or 0
            if total == 0 or completed != total:
                continue
            dedupe_key = f"project:{project.id}:completed"
            life_event = (await db.execute(select(LearningLifeEvent).where(
                LearningLifeEvent.learner_id == project.learner_id,
                LearningLifeEvent.dedupe_key == dedupe_key,
            ))).scalar_one_or_none()
            if not life_event:
                evidence_key = f"{project.learner_id}:migration:v4:project:{project.id}:completed"
                evidence = (await db.execute(select(EvidenceEvent).where(
                    EvidenceEvent.learner_id == project.learner_id,
                    EvidenceEvent.client_event_id == evidence_key,
                ))).scalar_one_or_none()
                if not evidence:
                    evidence = EvidenceEvent(
                        learner_id=project.learner_id,
                        project_id=project.id,
                        event_type="project_completed",
                        source="migration",
                        context_id=f"project:{project.id}",
                        payload={"project_id": project.id, "name": project.name, "migrated": True},
                        confidence=0.6,
                        provenance={"migration": USER_ISOLATION_MIGRATION},
                        client_event_id=evidence_key,
                    )
                    db.add(evidence)
                    await db.flush()
                life_event = LearningLifeEvent(
                    learner_id=project.learner_id,
                    event_type="project_completed",
                    title=f"完成学习项目：{project.name}",
                    summary="由多用户迁移根据已验证检查点补记",
                    payload={"project_id": project.id, "migrated": True},
                    project_id=project.id,
                    source_event_id=evidence.id,
                    confidence=1.0,
                    dedupe_key=dedupe_key,
                )
                db.add(life_event)
                await db.flush()
            existing_badge = (await db.execute(select(LearnerBadge).where(
                LearnerBadge.learner_id == project.learner_id,
                LearnerBadge.award_key == dedupe_key,
            ))).scalar_one_or_none()
            if not existing_badge:
                db.add(LearnerBadge(
                    learner_id=project.learner_id,
                    badge_type="project_completed",
                    title=f"完成「{project.name}」",
                    description="完成项目中的全部独立验证",
                    icon_key="trophy",
                    color_token="emerald",
                    award_key=dedupe_key,
                    life_event_id=life_event.id,
                    project_id=project.id,
                    meta_data={"migrated": True},
                ))

        db.add(SchemaMigration(version=USER_ISOLATION_MIGRATION))
        await db.commit()
        print(f"[migrate] applied {USER_ISOLATION_MIGRATION}")


async def _repair_missing_auth_account_numbers(db: AsyncSession) -> int:
    """Repair accounts inserted by a pre-v19 process after the migration ran.

    Rolling local upgrades can briefly leave an old server connected to a
    database whose nullable compatibility column already exists.  Such a
    process can insert an account without a public number.  Reconciliation is
    deliberately idempotent and preserves zero exclusively for the exact Ryan
    account; all other rows receive monotonically increasing positive numbers.
    """
    from app.models.learning import AuthAccountNumberSequence, UserAccount

    missing = list((await db.execute(
        select(UserAccount)
        .where(UserAccount.account_number.is_(None))
        .order_by(UserAccount.created_at.asc(), UserAccount.id.asc())
    )).scalars().all())
    if not missing:
        return 0

    maximum = (await db.execute(
        select(func.max(UserAccount.account_number)).where(
            UserAccount.account_number >= 1,
        )
    )).scalar_one_or_none()
    sequence = await db.get(AuthAccountNumberSequence, 1)
    next_number = max(
        1,
        int(maximum or 0) + 1,
        int(sequence.next_number or 1) if sequence is not None else 1,
    )
    zero_owner = (await db.execute(
        select(UserAccount.id).where(UserAccount.account_number == 0)
    )).scalar_one_or_none()

    for account in missing:
        is_ryan = (
            account.username_normalized == "ryan"
            and not bool(account.is_legacy_demo)
        )
        if is_ryan and zero_owner is None:
            account.account_number = 0
            account.role = "admin"
            zero_owner = account.id
            continue
        account.account_number = next_number
        account.role = account.role or "user"
        next_number += 1

    if sequence is None:
        db.add(AuthAccountNumberSequence(id=1, next_number=next_number))
    else:
        sequence.next_number = next_number
    await db.flush()
    return len(missing)


async def _backfill_auth_phase_a():
    """Install deterministic account numbers, RBAC defaults, and session bounds.

    Legacy sessions cannot satisfy the new session-bound CSRF contract because
    their raw token is intentionally unavailable.  They are therefore revoked
    rather than silently grandfathered into a weaker authorization path.
    """
    from app.models.learning import (
        AuthAccountNumberSequence, AuthSession, SchemaMigration, UserAccount,
    )

    async with async_session() as db:
        applied = (await db.execute(select(SchemaMigration).where(
            SchemaMigration.version == AUTH_PHASE_A_MIGRATION
        ))).scalar_one_or_none()
        if applied:
            repaired = await _repair_missing_auth_account_numbers(db)
            if repaired:
                await db.commit()
                print(f"[migrate] repaired {repaired} missing account numbers")
            return

        accounts = list((await db.execute(
            select(UserAccount).order_by(UserAccount.created_at.asc(), UserAccount.id.asc())
        )).scalars().all())

        # Move every row out of the public range first.  This makes a retry
        # deterministic even when a previous attempt stopped after assigning a
        # subset and a uniqueness index already exists.
        for account in accounts:
            account.account_number = -(int(account.id) + 1)
        await db.flush()

        ryan_account = next((
            account for account in accounts
            if account.username_normalized == "ryan" and not bool(account.is_legacy_demo)
        ), None)
        next_number = 1
        for account in accounts:
            if account is ryan_account:
                account.account_number = 0
                account.role = "admin"
            else:
                account.account_number = next_number
                account.role = "user"
                next_number += 1
            has_password = bool(account.password_hash)
            account.password_version = (
                max(int(account.password_version or 0), 1) if has_password else 0
            )
            account.auth_epoch = int(account.auth_epoch or 0)
            account.must_change_password = not has_password
        await db.flush()

        sequence = await db.get(AuthAccountNumberSequence, 1)
        if sequence is None:
            sequence = AuthAccountNumberSequence(id=1, next_number=next_number)
            db.add(sequence)
        else:
            sequence.next_number = next_number

        epochs = {account.id: int(account.auth_epoch or 0) for account in accounts}
        now = datetime.utcnow()
        sessions = list((await db.execute(select(AuthSession))).scalars().all())
        for session in sessions:
            absolute = session.absolute_expires_at or session.expires_at
            if absolute is None:
                absolute = (session.created_at or now) + timedelta(days=settings.auth_session_days)
            last_seen = session.last_seen_at or session.created_at or now
            idle = session.idle_expires_at or min(
                absolute,
                last_seen + timedelta(minutes=settings.auth_session_idle_minutes),
            )
            session.absolute_expires_at = absolute
            session.idle_expires_at = min(absolute, idle)
            session.expires_at = absolute
            session.auth_epoch = epochs.get(session.user_id, 0)
            if not session.csrf_token_hash and session.revoked_at is None:
                session.revoked_at = now
                session.revoked_reason = "auth_phase_a_migration"

        await db.flush()
        await db.execute(text(
            "CREATE UNIQUE INDEX IF NOT EXISTS ix_user_accounts_account_number "
            "ON user_accounts (account_number)"
        ))
        await db.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_user_accounts_role ON user_accounts (role)"
        ))
        db.add(SchemaMigration(version=AUTH_PHASE_A_MIGRATION))
        await db.commit()
        print(
            f"[migrate] applied {AUTH_PHASE_A_MIGRATION}: "
            f"{len(accounts)} accounts, {len(sessions)} legacy sessions inspected"
        )


async def _backfill_inspectable_memory_graph():
    from app.models.learning import SchemaMigration
    from app.services.memory_graph import backfill_memory_graph

    async with async_session() as db:
        applied = (await db.execute(select(SchemaMigration).where(
            SchemaMigration.version == MEMORY_GRAPH_MIGRATION
        ))).scalar_one_or_none()
        if applied:
            return
        counts = await backfill_memory_graph(db)
        db.add(SchemaMigration(version=MEMORY_GRAPH_MIGRATION))
        await db.commit()
        print(f"[migrate] applied {MEMORY_GRAPH_MIGRATION}: {counts}")


async def _mark_desktop_workspace_migration():
    from app.models.learning import SchemaMigration

    async with async_session() as db:
        applied = (await db.execute(select(SchemaMigration).where(
            SchemaMigration.version == DESKTOP_WORKSPACE_MIGRATION
        ))).scalar_one_or_none()
        if applied:
            return
        db.add(SchemaMigration(version=DESKTOP_WORKSPACE_MIGRATION))
        await db.commit()
        print(f"[migrate] applied {DESKTOP_WORKSPACE_MIGRATION}")


async def _mark_checkpoint_tutor_migration():
    from app.models.learning import SchemaMigration

    async with async_session() as db:
        applied = (await db.execute(select(SchemaMigration).where(
            SchemaMigration.version == CHECKPOINT_TUTOR_MIGRATION
        ))).scalar_one_or_none()
        if applied:
            return
        db.add(SchemaMigration(version=CHECKPOINT_TUTOR_MIGRATION))
        await db.commit()
        print(f"[migrate] applied {CHECKPOINT_TUTOR_MIGRATION}")


async def _migrate_managed_artifacts():
    from app.models.learning import SchemaMigration
    from app.models.project import ArtifactAnnotation, Checkpoint, Lecture, LectureNote, Project, Roadmap

    async with async_session() as db:
        applied = (await db.execute(select(SchemaMigration).where(
            SchemaMigration.version == MANAGED_ARTIFACT_MIGRATION
        ))).scalar_one_or_none()
        if applied:
            return
        legacy_notes = list((await db.execute(select(LectureNote))).scalars().all())
        for note in legacy_notes:
            existing = (await db.execute(select(ArtifactAnnotation).where(
                ArtifactAnnotation.legacy_note_id == note.id,
            ))).scalar_one_or_none()
            if existing:
                continue
            ownership = (await db.execute(
                select(Project.learner_id, Lecture.id, Lecture.version)
                .join(Roadmap, Roadmap.project_id == Project.id)
                .join(Checkpoint, Checkpoint.roadmap_id == Roadmap.id)
                .join(Lecture, Lecture.checkpoint_id == Checkpoint.id)
                .where(Checkpoint.id == note.checkpoint_id)
            )).one_or_none()
            if not ownership or ownership[0] is None:
                continue
            db.add(ArtifactAnnotation(
                learner_id=ownership[0], checkpoint_id=note.checkpoint_id,
                artifact_type="lecture", artifact_id=ownership[1],
                artifact_version=ownership[2] or 1,
                anchor={"section_index": note.section_index, "selection": note.selection or ""},
                body=note.note or "", status="anchored", legacy_note_id=note.id,
                created_at=note.created_at, updated_at=note.updated_at,
            ))
        db.add(SchemaMigration(version=MANAGED_ARTIFACT_MIGRATION))
        await db.commit()
        print(f"[migrate] applied {MANAGED_ARTIFACT_MIGRATION}: {len(legacy_notes)} legacy notes inspected")


async def _mark_local_agent_broker_migration():
    from app.models.learning import SchemaMigration

    async with async_session() as db:
        applied = (await db.execute(select(SchemaMigration).where(
            SchemaMigration.version == LOCAL_AGENT_BROKER_MIGRATION
        ))).scalar_one_or_none()
        if applied:
            return
        db.add(SchemaMigration(version=LOCAL_AGENT_BROKER_MIGRATION))
        await db.commit()
        print(f"[migrate] applied {LOCAL_AGENT_BROKER_MIGRATION}")


async def _backfill_review_workbench():
    from app.models.learning import SchemaMigration
    from app.services.review import rebuild_review_schedules

    async with async_session() as db:
        applied = (await db.execute(select(SchemaMigration).where(
            SchemaMigration.version == REVIEW_WORKBENCH_MIGRATION
        ))).scalar_one_or_none()
        if applied:
            return
        count = await rebuild_review_schedules(db)
        db.add(SchemaMigration(version=REVIEW_WORKBENCH_MIGRATION))
        await db.commit()
        print(f"[migrate] applied {REVIEW_WORKBENCH_MIGRATION}: {count} attempts projected")


async def _backfill_five_kernel_memory_fabric():
    from app.models.learning import SchemaMigration
    from app.services.five_kernel_context import backfill_memory_fabric

    async with async_session() as db:
        applied = (await db.execute(select(SchemaMigration).where(
            SchemaMigration.version == FIVE_KERNEL_MEMORY_FABRIC_MIGRATION
        ))).scalar_one_or_none()
        if applied:
            return
        counts = await backfill_memory_fabric(db)
        db.add(SchemaMigration(version=FIVE_KERNEL_MEMORY_FABRIC_MIGRATION))
        await db.commit()
        print(f"[migrate] applied {FIVE_KERNEL_MEMORY_FABRIC_MIGRATION}: {counts}")


async def _backfill_memory_module_versioning():
    from app.models.learning import SchemaMigration
    from app.services.memory_graph import backfill_module_versions

    async with async_session() as db:
        applied = (await db.execute(select(SchemaMigration).where(
            SchemaMigration.version == MEMORY_MODULE_VERSIONING_MIGRATION
        ))).scalar_one_or_none()
        if applied:
            return
        counts = await backfill_module_versions(db)
        await db.execute(text(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_current_memory_module_idx "
            "ON memory_nodes (learner_id, kernel_name, subject_key) "
            "WHERE node_type = 'module' AND status = 'active'"
        ))
        db.add(SchemaMigration(version=MEMORY_MODULE_VERSIONING_MIGRATION))
        await db.commit()
        print(f"[migrate] applied {MEMORY_MODULE_VERSIONING_MIGRATION}: {counts}")


async def _mark_micro_learning_migration():
    """Record the additive run-table migration after create_all created it."""
    from app.models.learning import SchemaMigration

    async with async_session() as db:
        applied = (await db.execute(select(SchemaMigration).where(
            SchemaMigration.version == MICRO_LEARNING_MIGRATION
        ))).scalar_one_or_none()
        if applied:
            return
        db.add(SchemaMigration(version=MICRO_LEARNING_MIGRATION))
        await db.commit()
        print(f"[migrate] applied {MICRO_LEARNING_MIGRATION}")


async def _mark_conversation_skill_runtime_migration():
    """Record the additive SkillRun table after create_all created it."""
    from app.models.learning import SchemaMigration

    async with async_session() as db:
        applied = (await db.execute(select(SchemaMigration).where(
            SchemaMigration.version == CONVERSATION_SKILL_RUNTIME_MIGRATION
        ))).scalar_one_or_none()
        if applied:
            return
        db.add(SchemaMigration(version=CONVERSATION_SKILL_RUNTIME_MIGRATION))
        await db.commit()
        print(f"[migrate] applied {CONVERSATION_SKILL_RUNTIME_MIGRATION}")


async def _mark_assessment_blueprint_migration():
    """Record additive AssessmentBlueprint and Rubric tables."""
    from app.models.learning import SchemaMigration

    async with async_session() as db:
        applied = (await db.execute(select(SchemaMigration).where(
            SchemaMigration.version == ASSESSMENT_BLUEPRINT_MIGRATION
        ))).scalar_one_or_none()
        if applied:
            return
        db.add(SchemaMigration(version=ASSESSMENT_BLUEPRINT_MIGRATION))
        await db.commit()
        print(f"[migrate] applied {ASSESSMENT_BLUEPRINT_MIGRATION}")


async def _backfill_domain_knowledge_supply():
    """Create immutable version 1 records for legacy processed sources."""
    from app.models.learning import SchemaMigration
    from app.models.project import Chunk, Source, SourceVersion
    from app.services.domain_knowledge import inspect_source_chunks, source_content_hash

    async with async_session() as db:
        applied = (await db.execute(select(SchemaMigration).where(
            SchemaMigration.version == DOMAIN_KNOWLEDGE_MIGRATION
        ))).scalar_one_or_none()
        if applied:
            return
        created = 0
        sources = list((await db.execute(select(Source).where(
            Source.status.in_({"processed", "quarantined"}),
        ).order_by(Source.id))).scalars().all())
        for source in sources:
            chunks = list((await db.execute(select(Chunk).where(
                Chunk.source_id == source.id,
            ).order_by(Chunk.index))).scalars().all())
            if not chunks:
                continue
            payload = [{
                "index": item.index, "content": item.content,
                "meta": dict(item.meta_data or {}),
            } for item in chunks]
            digest = source_content_hash(payload)
            version = (await db.execute(select(SourceVersion).where(
                SourceVersion.source_id == source.id,
                SourceVersion.content_hash == digest,
            ))).scalar_one_or_none()
            if not version:
                inspection = inspect_source_chunks(payload)
                version = SourceVersion(
                    source_id=source.id, version=1, content_hash=digest,
                    source_role="learner_context", authority_tier="learner_owned",
                    freshness_class="stable",
                    status="quarantined" if inspection["quarantined"] else "active",
                    health={"status": "blocked" if inspection["quarantined"] else "healthy"},
                    provenance={"source_id": source.id, "migration": DOMAIN_KNOWLEDGE_MIGRATION},
                    inspection=inspection,
                )
                db.add(version)
                await db.flush()
                created += 1
            for chunk in chunks:
                if chunk.source_version_id is None:
                    chunk.source_version_id = version.id
            source.meta_data = {**dict(source.meta_data or {}), "active_source_version_id": version.id}
        db.add(SchemaMigration(version=DOMAIN_KNOWLEDGE_MIGRATION))
        await db.commit()
        print(f"[migrate] applied {DOMAIN_KNOWLEDGE_MIGRATION}: {created} source versions")


async def _backfill_learning_task_runtime():
    """Create learner-visible task projections for existing checkpoints/runs."""
    from app.models.learning import SchemaMigration
    from app.services.learning_tasks import backfill_learning_tasks

    async with async_session() as db:
        applied = (await db.execute(select(SchemaMigration).where(
            SchemaMigration.version == LEARNING_TASK_RUNTIME_MIGRATION
        ))).scalar_one_or_none()
        if applied:
            return
        counts = await backfill_learning_tasks(db)
        db.add(SchemaMigration(version=LEARNING_TASK_RUNTIME_MIGRATION))
        await db.commit()
        print(f"[migrate] applied {LEARNING_TASK_RUNTIME_MIGRATION}: {counts}")


async def _backfill_atomic_learning_skill_runtime():
    """Link legacy SkillRuns to the LearningTask already owned by their micro run."""
    from app.models.learning import LearningSkillRun, LearningTask, SchemaMigration

    async with async_session() as db:
        applied = (await db.execute(select(SchemaMigration).where(
            SchemaMigration.version == ATOMIC_LEARNING_SKILL_MIGRATION
        ))).scalar_one_or_none()
        if applied:
            return
        linked = 0
        runs = list((await db.execute(select(LearningSkillRun).where(
            LearningSkillRun.learning_task_id.is_(None),
            LearningSkillRun.micro_learning_run_id.is_not(None),
        ))).scalars().all())
        for run in runs:
            task = (await db.execute(select(LearningTask).where(
                LearningTask.learner_id == run.learner_id,
                LearningTask.micro_learning_run_id == run.micro_learning_run_id,
            ).limit(1))).scalar_one_or_none()
            if task:
                run.learning_task_id = task.id
                linked += 1
        db.add(SchemaMigration(version=ATOMIC_LEARNING_SKILL_MIGRATION))
        await db.commit()
        print(f"[migrate] applied {ATOMIC_LEARNING_SKILL_MIGRATION}: {linked} SkillRuns linked")


async def _backfill_personal_concept_graph():
    """Project existing profile background into self-reported concept history.

    This is an additive EvidenceEvent backfill.  It intentionally records only
    exposure and explicit gaps; profile prose never becomes mastery evidence.
    """
    from app.models.learning import LearnerProfile, SchemaMigration
    from app.services.learning_runtime import record_event
    from app.services.personal_concept_graph import (
        concept_client_event_id, extract_self_report, normalize_observation,
    )

    async with async_session() as db:
        applied = (await db.execute(select(SchemaMigration).where(
            SchemaMigration.version == PERSONAL_CONCEPT_GRAPH_MIGRATION
        ))).scalar_one_or_none()
        if applied:
            return
        profiles = list((await db.execute(select(LearnerProfile))).scalars().all())
        created = 0
        for profile in profiles:
            raw_text = str(profile.background or "").strip()
            if not raw_text:
                continue
            drafts, _ = extract_self_report(raw_text)
            if not drafts:
                continue
            parent = await record_event(
                db,
                learner_id=profile.learner_id,
                event_type="learner_concept_statement_recorded",
                source="profile",
                payload={
                    "raw_text": raw_text,
                    "source_tag": "profile_background_backfill",
                    "verification": "unverified",
                    "mastery_inference": False,
                    "extracted_concept_count": len(drafts),
                    "extracted_relation_count": 0,
                },
                provenance={"self_report": True, "projection_backfill": True, "mastery_unchanged": True},
                client_event_id=concept_client_event_id(
                    f"concept-graph-v17:{profile.learner_id}", "statement",
                ),
            )
            for index, draft in enumerate(drafts):
                concept = normalize_observation(draft)
                await record_event(
                    db,
                    learner_id=profile.learner_id,
                    event_type="learner_concept_observation_recorded",
                    source="profile",
                    payload={
                        "statement_event_id": parent.id,
                        "raw_text": raw_text,
                        "source_tag": "profile_background_backfill",
                        "verification": "unverified",
                        "mastery_inference": False,
                        "memory_subject_key": f"concept:{concept['concept_key']}",
                        "concept_key": concept["concept_key"],
                        "concept_name": concept["name"],
                        "concept_aliases": concept["aliases"],
                        "concept_origin": concept["origin"],
                        "official_node_id": concept["official_node_id"],
                        "observation_type": concept["observation_type"],
                        "statement": concept["statement"],
                        "question_ref": concept["question_ref"],
                    },
                    provenance={"self_report": True, "projection_backfill": True, "mastery_unchanged": True},
                    client_event_id=concept_client_event_id(
                        f"concept-graph-v17:{profile.learner_id}",
                        "knowledge", index, concept["concept_key"],
                    ),
                )
                created += 1
        db.add(SchemaMigration(version=PERSONAL_CONCEPT_GRAPH_MIGRATION))
        await db.commit()
        print(f"[migrate] applied {PERSONAL_CONCEPT_GRAPH_MIGRATION}: {created} concept observations")


async def _mark_desktop_pet_migration():
    """Record the additive desktop-pet tables after create_all created them."""
    from app.models.learning import SchemaMigration

    async with async_session() as db:
        applied = (await db.execute(select(SchemaMigration).where(
            SchemaMigration.version == DESKTOP_PET_MIGRATION
        ))).scalar_one_or_none()
        if applied:
            return
        db.add(SchemaMigration(version=DESKTOP_PET_MIGRATION))
        await db.commit()
        print(f"[migrate] applied {DESKTOP_PET_MIGRATION}")


async def init_db():
    _backup_before_five_kernel_migration()
    _backup_before_project_proposal_migration()
    _backup_before_user_isolation_migration()
    _backup_before_memory_graph_migration()
    _backup_before_desktop_workspace_migration()
    _backup_before_checkpoint_tutor_migration()
    _backup_before_managed_artifact_migration()
    _backup_before_review_workbench_migration()
    _backup_before_five_kernel_memory_fabric_migration()
    _backup_before_memory_module_versioning_migration()
    _backup_before_auth_phase_a_migration()
    async with engine.begin() as conn:
        from app.models import project, learning  # noqa: F401
        await conn.run_sync(Base.metadata.create_all)
    await _ensure_columns()
    await _backfill_five_kernel()
    await _mark_project_proposal_migration()
    await _backfill_user_isolation()
    await _backfill_auth_phase_a()
    await _backfill_inspectable_memory_graph()
    await _mark_desktop_workspace_migration()
    await _mark_checkpoint_tutor_migration()
    await _migrate_managed_artifacts()
    await _mark_local_agent_broker_migration()
    await _backfill_review_workbench()
    await _backfill_five_kernel_memory_fabric()
    await _backfill_memory_module_versioning()
    await _mark_micro_learning_migration()
    await _mark_conversation_skill_runtime_migration()
    await _backfill_learning_task_runtime()
    await _backfill_atomic_learning_skill_runtime()
    await _backfill_personal_concept_graph()
    await _mark_assessment_blueprint_migration()
    await _backfill_domain_knowledge_supply()
    await _mark_desktop_pet_migration()
