"""Additive project candidates and explicitly device-reported operation artifacts."""
from datetime import datetime
from sqlalchemy import Column, Integer, String, Text, JSON, ForeignKey, DateTime, UniqueConstraint
from app.db.database import Base


class ProjectGuidanceCandidate(Base):
    __tablename__ = "project_guidance_candidates"
    __table_args__ = (UniqueConstraint("learner_id", "client_action_id", name="uq_project_guidance_request"),)
    id = Column(String(80), primary_key=True)
    learner_id = Column(Integer, ForeignKey("learners.id"), nullable=False, index=True)
    client_action_id = Column(String(120), nullable=False)
    request_hash = Column(String(64), nullable=False)
    root_hash = Column(String(64), nullable=False)
    candidate = Column(JSON, nullable=False)
    project_id = Column(Integer, ForeignKey("projects.id"), nullable=True, unique=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class ProjectDeviceReport(Base):
    __tablename__ = "project_device_reports"
    __table_args__ = (UniqueConstraint("project_id", "client_action_id", name="uq_project_device_report_request"),)
    id = Column(Integer, primary_key=True)
    learner_id = Column(Integer, ForeignKey("learners.id"), nullable=False, index=True)
    project_id = Column(Integer, ForeignKey("projects.id"), nullable=False, index=True)
    checkpoint_id = Column(Integer, ForeignKey("checkpoints.id"), nullable=False, index=True)
    client_action_id = Column(String(120), nullable=False)
    report_hash = Column(String(64), nullable=False)
    report = Column(JSON, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
