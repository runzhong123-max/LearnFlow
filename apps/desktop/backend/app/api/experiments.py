"""Desktop-only, user-confirmed experiment operations; never grading endpoints."""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.workspace import _owned_workspace, require_desktop_token
from app.db.database import get_db
from app.models.experiment import ExperimentRun
from app.models.project import Roadmap
from app.schemas.experiment import (
    ExperimentRunConfirmRequest, ExperimentRunListResponse,
    ExperimentRunPreviewRequest, ExperimentRunResponse,
)
from app.services.auth import CurrentLearner, get_current_learner, require_owned_checkpoint, require_owned_project
from app.services.experiment_runner import confirm_run, experiment_profiles, preview_run
from app.services.workspace_files import WorkspaceError


router = APIRouter(
    prefix="/projects/{project_id}/experiments",
    dependencies=[Depends(require_desktop_token)],
)


def _raise_error(exc: WorkspaceError):
    raise HTTPException(exc.status_code, {"code": exc.code, "message": exc.detail}) from exc


async def _owned_run(db: AsyncSession, learner_id: int, project_id: int, run_id: int) -> ExperimentRun:
    await require_owned_project(db, learner_id, project_id)
    run = (await db.execute(select(ExperimentRun).where(
        ExperimentRun.id == run_id, ExperimentRun.learner_id == learner_id,
        ExperimentRun.project_id == project_id,
    ))).scalar_one_or_none()
    if not run:
        raise HTTPException(404, "Experiment run not found")
    return run


@router.get("/profiles")
async def list_experiment_profiles(
    project_id: int, current: CurrentLearner = Depends(get_current_learner),
    db: AsyncSession = Depends(get_db),
):
    await require_owned_project(db, current.learner.id, project_id)
    try:
        return experiment_profiles()
    except WorkspaceError as exc:
        _raise_error(exc)


@router.post("/runs/preview", response_model=ExperimentRunResponse)
async def preview_experiment_run(
    project_id: int, data: ExperimentRunPreviewRequest,
    current: CurrentLearner = Depends(get_current_learner), db: AsyncSession = Depends(get_db),
):
    workspace = await _owned_workspace(db, current.learner.id, project_id)
    if workspace.status != "linked":
        raise HTTPException(409, "Project workspace is not linked")
    if data.checkpoint_id:
        checkpoint = await require_owned_checkpoint(db, current.learner.id, data.checkpoint_id)
        roadmap = await db.get(Roadmap, checkpoint.roadmap_id)
        if not roadmap or roadmap.project_id != project_id:
            raise HTTPException(404, "Checkpoint not found in project")
    try:
        return await preview_run(db, workspace, data)
    except WorkspaceError as exc:
        _raise_error(exc)


@router.post("/runs/{run_id}/confirm", response_model=ExperimentRunResponse)
async def confirm_experiment_run(
    project_id: int, run_id: int, data: ExperimentRunConfirmRequest,
    current: CurrentLearner = Depends(get_current_learner), db: AsyncSession = Depends(get_db),
):
    run = await _owned_run(db, current.learner.id, project_id, run_id)
    try:
        return await confirm_run(db, run, data.snapshot_hash)
    except WorkspaceError as exc:
        _raise_error(exc)


@router.get("/runs", response_model=ExperimentRunListResponse)
async def list_experiment_runs(
    project_id: int, current: CurrentLearner = Depends(get_current_learner),
    db: AsyncSession = Depends(get_db),
):
    await require_owned_project(db, current.learner.id, project_id)
    runs = list((await db.execute(select(ExperimentRun).where(
        ExperimentRun.learner_id == current.learner.id, ExperimentRun.project_id == project_id,
    ).order_by(ExperimentRun.id.desc()).limit(30))).scalars().all())
    return {"runs": runs}


@router.get("/runs/{run_id}", response_model=ExperimentRunResponse)
async def get_experiment_run(
    project_id: int, run_id: int, current: CurrentLearner = Depends(get_current_learner),
    db: AsyncSession = Depends(get_db),
):
    return await _owned_run(db, current.learner.id, project_id, run_id)
