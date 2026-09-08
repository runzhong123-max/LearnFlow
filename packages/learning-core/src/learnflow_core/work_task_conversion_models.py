"""Learner-owned operational drafts; never a second learner-state authority."""
from datetime import datetime
from sqlalchemy import Column, Integer, String, JSON, ForeignKey, DateTime, UniqueConstraint
from app.db.database import Base


class WorkTaskConversion(Base):
    __tablename__ = "work_task_conversions"
    __table_args__ = (UniqueConstraint("learner_id", "client_action_id", name="uq_work_conversion_create"),
                      UniqueConstraint("learner_id", "role_launch_id", name="uq_work_conversion_role_launch"),)
    id = Column(String(80), primary_key=True)
    learner_id = Column(Integer, ForeignKey("learners.id"), nullable=False, index=True)
    client_action_id = Column(String(120), nullable=False)
    request_hash = Column(String(64), nullable=False)
    role_launch_id = Column(String(120), nullable=True)
    revision = Column(Integer, nullable=False, default=1)
    root_hash = Column(String(64), nullable=False)
    state = Column(String(30), nullable=False, default="draft")
    original_input = Column(String(12000), nullable=False)
    brief = Column(JSON, nullable=False, default=dict)
    source_refs = Column(JSON, nullable=False, default=list)
    messages = Column(JSON, nullable=False, default=list)
    candidate = Column(JSON, nullable=True)
    generation = Column(JSON, nullable=True)
    project_id = Column(Integer, ForeignKey("projects.id"), nullable=True)
    session_id = Column(Integer, ForeignKey("agent_sessions.id"), nullable=True)
    selection = Column(JSON, nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at = Column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)


class WorkTaskConversionRevision(Base):
    __tablename__ = "work_task_conversion_revisions"
    __table_args__ = (UniqueConstraint("conversion_id", "revision", name="uq_work_conversion_revision"),)
    id = Column(Integer, primary_key=True)
    conversion_id = Column(String(80), ForeignKey("work_task_conversions.id"), nullable=False, index=True)
    revision = Column(Integer, nullable=False)
    root_hash = Column(String(64), nullable=False)
    snapshot = Column(JSON, nullable=False)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)


class WorkTaskConversionAction(Base):
    __tablename__ = "work_task_conversion_actions"
    __table_args__ = (UniqueConstraint("conversion_id", "client_action_id", name="uq_work_conversion_action"),)
    id = Column(Integer, primary_key=True)
    conversion_id = Column(String(80), ForeignKey("work_task_conversions.id"), nullable=False, index=True)
    client_action_id = Column(String(120), nullable=False)
    request_hash = Column(String(64), nullable=False)
    kind = Column(String(40), nullable=False)
    result = Column(JSON, nullable=False, default=dict)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)


class WorkTaskConversionTicket(Base):
    __tablename__ = "work_task_conversion_tickets"
    id = Column(String(80), primary_key=True)
    token_hash = Column(String(64), nullable=False, unique=True, index=True)
    learner_id = Column(Integer, ForeignKey("learners.id"), nullable=False, index=True)
    conversion_id = Column(String(80), ForeignKey("work_task_conversions.id"), nullable=False, index=True)
    root_hash = Column(String(64), nullable=False)
    selection = Column(JSON, nullable=False, default=dict)
    expires_at = Column(DateTime, nullable=False)
    consumed_at = Column(DateTime, nullable=True)
    result = Column(JSON, nullable=True)
