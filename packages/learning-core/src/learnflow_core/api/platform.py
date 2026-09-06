"""Read-only protocol discovery; not an agent tool or evidence writer."""
from fastapi import APIRouter
from app.core.config import settings
from learnflow_core.api import SHARED_API_MODULES
from learnflow_core.registry_core import SHARED_CORE_VERSION

router = APIRouter()

@router.get("/platform")
async def platform_manifest():
    return {
        "protocol": "learnflow-platform/v1",
        "api_prefix": "/api",
        "shared_core_version": SHARED_CORE_VERSION,
        "host": "desktop_local" if settings.desktop_mode else "learning_platform",
        "state_authority": "device_local" if settings.desktop_mode else "server",
        "shared_api_modules": list(SHARED_API_MODULES),
        "memory_worker": "embedded" if settings.memory_worker_embedded else "external",
        "offline_sync": "not_available",
        "file_upload_policy": "explicit_user_selection",
    }
