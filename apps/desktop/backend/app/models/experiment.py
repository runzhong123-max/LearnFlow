"""Operational records for explicitly confirmed desktop experiment runs."""
from datetime import datetime

from sqlalchemy import Column, DateTime, ForeignKey, Integer, JSON, String, Text

from app.db.database import Base


class ExperimentRun(Base):
    __tablename__ = "experiment_runs"

    id = Column(Integer, primary_key=True, index=True)
    learner_id = Column(Integer, ForeignKey("learners.id"), nullable=False, index=True)
    project_id = Column(Integer, ForeignKey("projects.id"), nullable=False, index=True)
    workspace_id = Column(Integer, ForeignKey("project_workspaces.id"), nullable=False)
    checkpoint_id = Column(Integer, ForeignKey("checkpoints.id"), nullable=True, index=True)
    profile_id = Column(String(40), nullable=False)
    action = Column(String(20), nullable=False)
    status = Column(String(30), nullable=False, default="proposed", index=True)
    snapshot_hash = Column(String(64), nullable=False)
    manifest = Column(JSON, nullable=False, default=list)
    request = Column(JSON, nullable=False, default=dict)
    request_hash = Column(String(64), nullable=False)
    snapshot_path = Column(Text, nullable=False)
    workspace_root = Column(Text, nullable=False)
    result = Column(JSON, nullable=False, default=dict)
    idempotency_key = Column(String(160), nullable=False, unique=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    expires_at = Column(DateTime, nullable=False)
    confirmed_at = Column(DateTime, nullable=True)
    finished_at = Column(DateTime, nullable=True)
