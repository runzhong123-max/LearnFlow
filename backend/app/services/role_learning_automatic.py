"""Role production's signed, durable source-graph mounting; never learner mastery."""
from __future__ import annotations

import base64
from copy import deepcopy
import hashlib
import hmac
import json
import re
import time
from uuid import uuid4

from fastapi import HTTPException, Request
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.ecosystem import CurriculumAutomaticOperation, CurriculumCommit, CurriculumResolution
from app.models.learning import Learner, LearnerProfile, UserAccount
from app.services.auth import CurrentLearner, load_current_learner
from app.services import curriculum_catalog as catalog, ecosystem_gateway as gateway

POLICY_VERSION = "role-learning-auto/v1"
BATCH_SIZE = 25
MAX_CAS_ROUNDS = 4
_HEADER = "x-role-atlas-delegation"
_CLAIMS = {"v", "iss", "aud", "sub", "iat", "exp", "requestId", "bodyHash"}


def _reject() -> gateway.GatewayError:
    return gateway.GatewayError("delegation_denied", "岗位生产委托无效或已过期。", 403)


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate claim")
        result[key] = value
    return result


def delegated_subject(token: str, body: bytes, request_id: str, *, now: int | None = None) -> int:
    """Verify direction, exact bytes, bounded lifetime and a canonical learner ID."""
    if settings.desktop_mode or len(settings.role_atlas_gateway_secret.encode()) < 32:
        raise gateway.GatewayError("gateway_unavailable", "中央岗位挂载服务未配置。", 503)
    if len(token) > 4096 or not re.fullmatch(r"[A-Za-z0-9_-]+\.[a-f0-9]{64}", token):
        raise _reject()
    encoded, supplied = token.split(".")
    expected = hmac.new(settings.role_atlas_gateway_secret.encode(), encoded.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(supplied, expected):
        raise _reject()
    try:
        raw = base64.b64decode(encoded + "=" * (-len(encoded) % 4), altchars=b"-_", validate=True)
        if base64.urlsafe_b64encode(raw).decode().rstrip("=") != encoded:
            raise ValueError("noncanonical encoding")
        claims = json.loads(raw, object_pairs_hook=_unique_object)
    except (ValueError, UnicodeError):
        raise _reject()
    issued_now = int(time.time()) if now is None else now
    if (not isinstance(claims, dict) or set(claims) != _CLAIMS
            or type(claims.get("v")) is not int or claims["v"] != 1
            or claims.get("iss") != "role-atlas" or claims.get("aud") != "learnflow-curriculum"
            or type(claims.get("iat")) is not int or type(claims.get("exp")) is not int
            or not 0 < claims["exp"] - claims["iat"] <= 60
            or claims["iat"] > issued_now + 5 or claims["exp"] <= issued_now
            or claims.get("requestId") != request_id
            or claims.get("bodyHash") != hashlib.sha256(body).hexdigest()
            or not isinstance(claims.get("sub"), str)
            or not re.fullmatch(r"learnflow:learner:[1-9][0-9]{0,18}", claims["sub"])):
        raise _reject()
    learner_id = int(claims["sub"].rsplit(":", 1)[1])
    if learner_id > 2**63 - 1:
        raise _reject()
    return learner_id


def _pin_identity(current: CurrentLearner) -> CurrentLearner:
    # Session rollbacks expire ORM objects. Keep only already authenticated identity,
    # never profile state; these transient models are not attached to a DB session.
    learner_id = current.learner.id
    return CurrentLearner(account=UserAccount(id=current.account.id, role=current.account.role),
                          learner=Learner(id=learner_id), profile=LearnerProfile(learner_id=learner_id),
                          auth_method="role_production_delegation")


async def authenticate(request: Request, db: AsyncSession, request_id: str) -> CurrentLearner:
    # This route has no session-auth fallback and no CSRF exemption. Server callers
    # send no browser credentials or provenance; a copied browser session is useless.
    if any(name in request.headers for name in ("origin", "cookie", "authorization", "x-learnflow-desktop-token")) \
            or any(name.startswith("sec-fetch-") for name in request.headers):
        raise _reject()
    tokens = request.headers.getlist(_HEADER)
    if len(tokens) != 1:
        raise _reject()
    learner_id = delegated_subject(tokens[0], await request.body(), request_id)
    try:
        current = await load_current_learner(db, learner_id)
    except HTTPException:
        raise _reject()
    return _pin_identity(current)


async def _claim(db: AsyncSession, current: CurrentLearner, body: dict) -> CurriculumAutomaticOperation:
    body_hash = catalog.digest(body)
    query = select(CurriculumAutomaticOperation).where(
        CurriculumAutomaticOperation.learner_id == current.learner.id,
        CurriculumAutomaticOperation.request_id == body["requestId"],
    )
    row = (await db.execute(query)).scalar_one_or_none()
    if row:
        catalog.same_request(row, body_hash)
        return row
    row = CurriculumAutomaticOperation(id=str(uuid4()), learner_id=current.learner.id,
                                       request_id=body["requestId"], body_hash=body_hash)
    db.add(row)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        row = (await db.execute(query)).scalar_one()
        catalog.same_request(row, body_hash)
    return row


def _point_results(resolution: dict, receipt: dict | None, ids: list[str]) -> tuple[list[dict], list[dict]]:
    allowed = set(ids)
    unresolved = deepcopy(resolution["unresolved"])
    bindings = receipt["alignment"]["bindings"] if receipt else []
    if any(not isinstance(item, dict) or item.get("roleNodeId") not in allowed for item in bindings + unresolved):
        raise gateway.GatewayError("invalid_resolution", "岗位挂载返回了本批次之外的节点。")
    if len({b["roleNodeId"] for b in bindings}) != len(bindings) or len({item["roleNodeId"] for item in unresolved}) != len(unresolved):
        raise gateway.GatewayError("invalid_resolution", "岗位点的挂载结果重复。")
    added = {(node["namespace"], node["id"]) for node in resolution.get("extensionProposal", {}).get("nodes", [])} if receipt else set()
    points = {b["roleNodeId"]: {"roleNodeId": b["roleNodeId"],
              "status": "created" if (b["target"]["namespace"], b["target"]["id"]) in added else "existing", "target": b["target"]}
              for b in bindings}
    for item in unresolved:
        if item["roleNodeId"] in points:
            raise gateway.GatewayError("invalid_resolution", "岗位点同时被标记为已挂载和未解决。")
        points[item["roleNodeId"]] = {**item, "status": "needs_research"}
    for node_id in ids:
        if node_id not in points:
            item = {"roleNodeId": node_id, "reason": "missing_resolution", "candidates": []}
            unresolved.append(item)
            points[node_id] = {**item, "status": "needs_research"}
    return [points[node_id] for node_id in ids], unresolved


async def _batch(db: AsyncSession, current: CurrentLearner, prefix: str, package_ref: dict, ids: list[str], production_context: dict) -> tuple[dict, dict | None]:
    learner_id, commit_key = current.learner.id, prefix + ":commit"

    async def replay():
        previous = (await db.execute(select(CurriculumCommit).where(
            CurriculumCommit.learner_id == learner_id, CurriculumCommit.request_id == commit_key,
        ))).scalar_one_or_none()
        if not previous:
            return None
        saved = await db.get(CurriculumResolution, previous.resolution_id)
        receipt = await catalog.commit(db, current, commit_key, previous.resolution_id)
        return deepcopy(saved.resolution), receipt

    for _ in range(MAX_CAS_ROUNDS):
        if previous := await replay():
            return previous
        graph = await catalog.read_graph(db, current)
        # A new source revision gets a new preview key. The commit key is stable
        # across rounds, so competing deliveries can never commit this batch twice.
        round_key = prefix + ":" + catalog.digest(catalog.graph_ref(graph))[:24]
        resolved = await catalog.resolve(db, current, round_key + ":resolve", package_ref, ids, automatic=True)
        resolution = resolved["resolution"]
        proposed = resolution["alignment"]["bindings"] + resolution["pendingBindings"]
        # Reject contradictory or outside-batch coverage before any source commit.
        _point_results(resolution, {"alignment": {"bindings": proposed}}, ids)
        if not proposed:
            return resolution, None
        try:
            return resolution, await catalog.commit(db, current, commit_key, resolved["resolutionId"], production_context=production_context)
        except gateway.GatewayError as exc:
            if exc.code not in {"stale_graph", "idempotency_conflict"}:
                raise
            await db.rollback()
            current = _pin_identity(await load_current_learner(db, learner_id))
            if previous := await replay():
                return previous
            if exc.code != "stale_graph":
                raise
    raise gateway.GatewayError("stale_graph", "学习路径正在并行更新，稍后将继续自动挂载。", 409, True)


async def automatic_mount(db: AsyncSession, current: CurrentLearner, body: dict) -> dict:
    """Resume deterministic batches; successful commits outlive dropped HTTP responses."""
    current = _pin_identity(current)
    operation = await _claim(db, current, body)
    operation_id = operation.id
    # Always recheck ownership/deletion/content hashes before replaying even a final receipt.
    loaded = await gateway.dispatch(current, "package.resolve", str(uuid4()), {"packageRef": body["packageRef"]})
    if not isinstance(loaded, dict) or loaded.get("packageRef") != body["packageRef"]:
        raise gateway.GatewayError("invalid_package", "岗位制品身份不匹配。")
    if operation.response is not None:
        return deepcopy(operation.response)
    nodes = loaded.get("result", {}).get("semantic", {}).get("nodes")
    if not isinstance(nodes, list) or any(not isinstance(node, dict) for node in nodes):
        raise gateway.GatewayError("invalid_package", "岗位制品缺少语义节点。")
    ids = [node.get("id") for node in nodes if node.get("type") == "knowledge_skill"]
    if any(not isinstance(node_id, str) or not node_id for node_id in ids) or len(ids) != len(set(ids)):
        raise gateway.GatewayError("invalid_package", "岗位知识技能节点身份无效。")
    ids.sort()
    # Request aliases for the same production identity share immutable resolution/commit keys.
    identity = {key: value for key, value in body.items() if key != "requestId"}
    operation_key = "role-auto:" + catalog.digest(identity)[:48]
    receipts, points, unresolved = [], [], []
    for offset in range(0, len(ids), BATCH_SIZE):
        batch_ids = ids[offset:offset + BATCH_SIZE]
        resolution, receipt = await _batch(db, current, f"{operation_key}:{offset // BATCH_SIZE}", body["packageRef"], batch_ids, identity)
        batch_points, batch_unresolved = _point_results(resolution, receipt, batch_ids)
        points.extend(batch_points)
        unresolved.extend(batch_unresolved)
        if receipt:
            receipts.append(receipt)
    response = {"status": "partial" if unresolved and receipts else "needs_research" if unresolved or not ids else "completed",
                "packageRef": body["packageRef"], "points": points, "receipts": receipts,
                "unresolved": unresolved, "masteryUnchanged": True,
                **({"reason": "no_learning_points"} if not ids else {})}
    await db.execute(update(CurriculumAutomaticOperation).where(
        CurriculumAutomaticOperation.id == operation_id,
    ).values(response=response))
    await db.commit()
    return response
