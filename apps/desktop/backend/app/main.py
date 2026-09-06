import asyncio
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.core.config import settings
from app.db.database import init_db
from app.api.health import router as health_router
from app.api.projects import router as projects_router
from app.api.phase1 import router as phase1_router
from app.api.phase2 import router as phase2_router
from app.api.phase3 import router as phase3_router
from app.api.tasks import router as tasks_router
from app.api.settings import router as settings_router
from app.api.agent import router as agent_router, events_router
from app.api.auth import router as auth_router, dev_router
from app.api.profile import router as profile_router
from app.api.memory import router as memory_router
from app.api.remediation import router as remediation_router
from app.api.review import router as review_router
from app.api.architecture import router as architecture_router
from app.api.workspace import router as workspace_router
from app.api.local_agent import router as local_agent_router
from app.api.micro_learning import router as micro_learning_router
from app.api.learning_tasks import router as learning_tasks_router
from app.api.learner_state import router as learner_state_router
from app.api.knowledge_library import router as knowledge_library_router
from app.api.learning_files import router as learning_files_router
from app.api.vnext_projects import router as vnext_projects_router
from app.api.assessment_design import router as assessment_design_router
from app.api.pet import router as pet_router
from app.api.learning_task_integrations import router as learning_task_integrations_router
from app.api.experiments import router as experiments_router
from app.api.project_workflows import router as project_workflows_router
from app.services.auth import enforce_browser_request_security


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    from app.services.task_manager import mark_stale_tasks_failed
    from app.services.local_agent_broker import mark_interrupted_runs_failed
    from app.services.experiment_runner import mark_interrupted_experiment_runs
    from app.services.memory_worker import memory_worker_loop
    await mark_stale_tasks_failed()
    await mark_interrupted_runs_failed()
    await mark_interrupted_experiment_runs()
    stop_memory_worker = asyncio.Event()
    memory_task = asyncio.create_task(memory_worker_loop(stop_memory_worker))
    try:
        yield
    finally:
        stop_memory_worker.set()
        try:
            await asyncio.wait_for(memory_task, timeout=3)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            memory_task.cancel()


app = FastAPI(
    title=settings.app_name,
    version=settings.app_version,
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def browser_request_security(request: Request, call_next):
    try:
        await enforce_browser_request_security(request)
    except HTTPException as exc:
        return JSONResponse(
            status_code=exc.status_code,
            content={"detail": exc.detail},
            headers=exc.headers,
        )
    response = await call_next(request)
    if request.url.path == "/api/auth/model-credential/internal/resolve":
        response.headers["Cache-Control"] = "no-store"
        response.headers["Pragma"] = "no-cache"
    return response

app.include_router(health_router)
app.include_router(projects_router, prefix="/api")
app.include_router(phase1_router, prefix="/api")
app.include_router(phase2_router, prefix="/api")
app.include_router(phase3_router, prefix="/api")
app.include_router(tasks_router, prefix="/api")
app.include_router(settings_router, prefix="/api")
app.include_router(agent_router, prefix="/api")
app.include_router(events_router, prefix="/api")
app.include_router(auth_router, prefix="/api")
app.include_router(dev_router, prefix="/api")
app.include_router(profile_router, prefix="/api")
app.include_router(memory_router, prefix="/api")
app.include_router(remediation_router, prefix="/api")
app.include_router(review_router, prefix="/api")
app.include_router(architecture_router, prefix="/api")
app.include_router(workspace_router, prefix="/api")
app.include_router(local_agent_router, prefix="/api")
app.include_router(micro_learning_router, prefix="/api")
app.include_router(learning_tasks_router, prefix="/api")
app.include_router(learner_state_router, prefix="/api")
app.include_router(knowledge_library_router, prefix="/api")
app.include_router(learning_files_router, prefix="/api")
app.include_router(vnext_projects_router, prefix="/api")
app.include_router(assessment_design_router, prefix="/api")
app.include_router(pet_router, prefix="/api")
app.include_router(learning_task_integrations_router, prefix="/api")
app.include_router(experiments_router, prefix="/api")
app.include_router(project_workflows_router, prefix="/api")
