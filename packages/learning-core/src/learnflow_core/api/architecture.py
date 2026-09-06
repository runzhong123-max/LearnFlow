from fastapi import APIRouter

from app.services.architecture_registry import (
    registry_manifest,
    registry_validation_report,
)


router = APIRouter(prefix="/architecture", tags=["Architecture Authority"])


@router.get("/registry")
async def get_architecture_registry():
    return registry_manifest()


@router.get("/validate")
async def validate_architecture_registry():
    return registry_validation_report()
