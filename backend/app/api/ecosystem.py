"""Authenticated API shared by LearnFlow web and centrally connected desktop clients."""
from uuid import uuid4
from typing import Literal
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.ext.asyncio import AsyncSession
from app.db.database import get_db
from app.services.auth import CurrentLearner, get_current_learner
from app.services import ecosystem_gateway as gateway, curriculum_catalog as catalog, role_learning_automatic as automatic


def envelope(request_id: str, data=None, error: gateway.GatewayError | None = None) -> JSONResponse:
    body = {"protocol": gateway.PROTOCOL, "requestId": request_id, "ok": error is None}
    if error:
        body["error"] = {"code": error.code, "message": error.message, "retryable": error.retryable}
    else:
        body["data"] = data
    return JSONResponse(body, status_code=error.status if error else 200, headers={"Cache-Control": "no-store", "Pragma": "no-cache"})


class EcosystemRoute(APIRoute):
    def get_route_handler(self):
        original = super().get_route_handler()
        async def handler(request: Request):
            request_id = str(uuid4())
            if request.method == "POST":
                chunks = bytearray()
                async for chunk in request.stream():
                    chunks.extend(chunk)
                    if len(chunks) > 128 * 1024:
                        return envelope(request_id, error=gateway.GatewayError("request_too_large", "请求超过大小限制。", 413))
                request._body = bytes(chunks)  # replay bounded bytes to FastAPI validation
                try:
                    value = await request.json()
                    candidate = value.get("requestId") if isinstance(value, dict) else None
                    if isinstance(candidate, str) and 1 <= len(candidate) <= 128:
                        request_id = candidate
                except ValueError:
                    pass
            try:
                return await original(request)
            except gateway.GatewayError as exc:
                return envelope(request_id, error=exc)
            except RequestValidationError:
                return envelope(request_id, error=gateway.GatewayError("invalid_request", "请求不符合岗位网关契约。", 422))
            except HTTPException as exc:
                return envelope(request_id, error=gateway.GatewayError("authentication_required" if exc.status_code == 401 else "request_denied", "请登录或检查当前访问权限。", exc.status_code))
        return handler


router = APIRouter(prefix="/ecosystem", tags=["ecosystem"], route_class=EcosystemRoute)


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class RequestId(StrictModel):
    requestId: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9][A-Za-z0-9:._-]*$")


class DispatchRequest(RequestId):
    protocol: str = Field(pattern=r"^learnflow-ecosystem/v1$")
    operation: str = Field(min_length=1, max_length=64)
    payload: dict = Field(default_factory=dict)


class PackageRef(StrictModel):
    packageId: str = Field(min_length=1, max_length=256)
    packageVersion: str = Field(min_length=1, max_length=128)
    snapshotId: str = Field(min_length=1, max_length=256)
    rootHash: str = Field(pattern=r"^[a-f0-9]{64}$")


class ResolveRequest(RequestId):
    packageRef: PackageRef
    targetIds: list[str] | None = Field(default=None, max_length=200)


class CommitRequest(RequestId):
    resolutionId: str = Field(min_length=1, max_length=64)


class AutomaticRequest(RequestId):
    packageRef: PackageRef
    projectId: str = Field(min_length=1, max_length=256)
    projectVersionId: str = Field(min_length=1, max_length=256)
    sourceRunId: str = Field(min_length=1, max_length=256)
    policyVersion: Literal["role-learning-auto/v1"]


@router.get("/capabilities")
async def capabilities(current: CurrentLearner = Depends(get_current_learner)):
    available, reason = True, None
    try:
        gateway.gateway_url()
    except gateway.GatewayError as exc:
        available, reason = False, exc.message
    data = {"available": available, "protocol": gateway.PROTOCOL, "operations": sorted(gateway.PUBLIC_OPERATIONS),
            "sourceGraphAvailable": True, "identity": "server_authenticated_learner", "kernelWritePath": "none"}
    if reason:
        data["reason"] = reason
    return envelope(str(uuid4()), data)


@router.post("/dispatch")
async def dispatch(body: DispatchRequest, current: CurrentLearner = Depends(get_current_learner)):
    if body.operation not in gateway.PUBLIC_OPERATIONS:
        raise gateway.GatewayError("unsupported_operation", "此操作只能由可信学习路径服务构造。", 400)
    return envelope(body.requestId, await gateway.dispatch(current, body.operation, body.requestId, body.payload))


@router.get("/learning-path")
async def learning_path(current: CurrentLearner = Depends(get_current_learner), db: AsyncSession = Depends(get_db)):
    return envelope(str(uuid4()), {"graph": await catalog.read_graph(db, current), "namespace": catalog.namespace_for(current)})


@router.post("/learning-path/resolve")
async def resolve(body: ResolveRequest, current: CurrentLearner = Depends(get_current_learner), db: AsyncSession = Depends(get_db)):
    return envelope(body.requestId, await catalog.resolve(db, current, body.requestId, body.packageRef.model_dump(), body.targetIds))


@router.post("/learning-path/commit")
async def commit(body: CommitRequest, current: CurrentLearner = Depends(get_current_learner), db: AsyncSession = Depends(get_db)):
    return envelope(body.requestId, await catalog.commit(db, current, body.requestId, body.resolutionId))


@router.post("/learning-path/automatic")
async def automatic_mount(body: AutomaticRequest, request: Request, db: AsyncSession = Depends(get_db)):
    current = await automatic.authenticate(request, db, body.requestId)
    return envelope(body.requestId, await automatic.automatic_mount(db, current, body.model_dump()))
