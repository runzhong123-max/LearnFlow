from fastapi import APIRouter

router = APIRouter()


@router.get("/health")
async def health_check():
    return {"status": "ok", "service": "LearnFlow"}


@router.get("/ready")
async def readiness_check():
    from fastapi.responses import JSONResponse
    from sqlalchemy import text
    from app.db.database import async_session
    try:
        async with async_session() as db:
            await db.execute(text("SELECT 1"))
    except Exception:
        return JSONResponse({"status": "unavailable"}, status_code=503)
    return {"status": "ready", "service": "LearnFlow"}
