"""Versioned curriculum source data. These are not learner kernel projections."""
from datetime import datetime
from sqlalchemy import Integer, String, JSON, DateTime, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column
from app.db.database import Base


class CurriculumGraphHead(Base):
    __tablename__ = "curriculum_graph_heads"
    learner_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    revision: Mapped[str] = mapped_column(String(128))
    graph: Mapped[dict] = mapped_column(JSON)


class CurriculumResolution(Base):
    __tablename__ = "curriculum_resolutions"
    __table_args__ = (UniqueConstraint("learner_id", "request_id"),)
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    learner_id: Mapped[int] = mapped_column(Integer, index=True)
    request_id: Mapped[str] = mapped_column(String(128))
    body_hash: Mapped[str] = mapped_column(String(64))
    resolution: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class CurriculumCommit(Base):
    __tablename__ = "curriculum_commits"
    __table_args__ = (UniqueConstraint("learner_id", "request_id"), UniqueConstraint("learner_id", "resolution_id"))
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    learner_id: Mapped[int] = mapped_column(Integer, index=True)
    request_id: Mapped[str] = mapped_column(String(128))
    resolution_id: Mapped[str] = mapped_column(String(64))
    body_hash: Mapped[str] = mapped_column(String(64))
    graph: Mapped[dict] = mapped_column(JSON)
    receipt: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class CurriculumAutomaticOperation(Base):
    """Replay handle for an authorized production run; batches use existing commits."""
    __tablename__ = "curriculum_automatic_operations"
    __table_args__ = (UniqueConstraint("learner_id", "request_id"),)
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    learner_id: Mapped[int] = mapped_column(Integer, index=True)
    request_id: Mapped[str] = mapped_column(String(128))
    body_hash: Mapped[str] = mapped_column(String(64))
    response: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
