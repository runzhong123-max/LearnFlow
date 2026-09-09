"""Atomic source-catalog extensions, independent of personal learning state."""
from __future__ import annotations
from copy import deepcopy
import hashlib
import json
from pathlib import Path
from uuid import uuid4
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.ext.asyncio import AsyncSession
from app.models.ecosystem import CurriculumGraphHead, CurriculumResolution, CurriculumCommit
from app.services import ecosystem_gateway as gateway
from app.services.auth import CurrentLearner
from app.services.learning_runtime import record_event


def namespace_for(current: CurrentLearner) -> str:
    return "learnflow:extension:" + hashlib.sha256(gateway.subject_for(current).encode()).hexdigest()[:20]


def official_graph() -> dict:
    path = Path(__file__).resolve().parents[1] / "contracts" / "official-learning-path.v2.json"
    try:
        graph = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise gateway.GatewayError("source_graph_unavailable", "官方学习路径源图不可用。", 503)
    return graph


def graph_ref(graph: dict) -> dict:
    return {"graphId": graph.get("graphId"), "revision": graph.get("revision")}


def digest(value: object) -> str:
    return hashlib.sha256(gateway.canonical_bytes(value)).hexdigest()


async def read_graph(db: AsyncSession, current: CurrentLearner) -> dict:
    head = await db.get(CurriculumGraphHead, current.learner.id)
    return deepcopy(head.graph) if head else official_graph()


async def _ensure_head(db: AsyncSession, current: CurrentLearner) -> dict:
    head = await db.get(CurriculumGraphHead, current.learner.id)
    if head:
        return deepcopy(head.graph)
    graph = official_graph()
    try:
        async with db.begin_nested():
            db.add(CurriculumGraphHead(learner_id=current.learner.id, revision=graph["revision"], graph=graph))
            await db.flush()
        await db.commit()
    except IntegrityError:
        await db.rollback()
    return await read_graph(db, current)


def same_request(row, body_hash: str):
    if row.body_hash != body_hash:
        raise gateway.GatewayError("idempotency_conflict", "同一请求标识不能用于不同内容。", 409)


async def resolve(db: AsyncSession, current: CurrentLearner, request_id: str, package_ref: dict, target_ids: list[str] | None, *, automatic: bool = False) -> dict:
    request_body = {"packageRef": package_ref, "targetIds": target_ids}
    if automatic:
        request_body["policyVersion"] = "role-learning-auto/v1"
    body_hash = digest(request_body)
    previous = (await db.execute(select(CurriculumResolution).where(
        CurriculumResolution.learner_id == current.learner.id, CurriculumResolution.request_id == request_id,
    ))).scalar_one_or_none()
    if previous:
        same_request(previous, body_hash)
        # Permissions may have been revoked since the stored preview was created.
        await gateway.dispatch(current, "package.resolve", str(uuid4()), {"packageRef": package_ref})
        return {"resolutionId": previous.id, "resolution": previous.resolution}
    graph = await _ensure_head(db, current)
    namespace = namespace_for(current)
    payload = {"packageRef": package_ref, "graph": graph, "namespace": namespace, "groupByCourse": True, "allowStandaloneRoots": True}
    if target_ids is not None:
        payload["targetIds"] = target_ids
    result = await gateway.dispatch(current, "learning.resolve", request_id, payload)
    if (not isinstance(result, dict) or result.get("protocol") != "role-learning-resolution/v2"
            or result.get("packageRef") != package_ref or result.get("graphRef") != graph_ref(graph)
            or result.get("namespace") != namespace or not isinstance(result.get("alignment"), dict)
            or not isinstance(result.get("pendingBindings"), list) or not isinstance(result.get("unresolved"), list)):
        raise gateway.GatewayError("invalid_resolution", "岗位挂载结果与当前源图或主体不匹配。")
    alignment = result["alignment"]
    if alignment.get("packageRef") != package_ref or alignment.get("graphRef") != graph_ref(graph) or not isinstance(alignment.get("bindings"), list):
        raise gateway.GatewayError("invalid_resolution", "岗位挂载版本不匹配。")
    proposal = result.get("extensionProposal")
    if proposal:
        if not isinstance(proposal, dict) or proposal.get("namespace") != namespace or proposal.get("baseGraphRef") != graph_ref(graph) or proposal.get("packageRef") != package_ref:
            raise gateway.GatewayError("invalid_resolution", "特殊节点提案范围不匹配。")
    elif result["pendingBindings"]:
        raise gateway.GatewayError("invalid_resolution", "缺少待挂载节点的扩展提案。")
    # Derive display metadata from the scoped source graph/proposal, not model labels.
    courses = {(n["namespace"], n["id"], n["revision"]): n for n in graph["nodes"] + (proposal or {}).get("nodes", []) if n.get("kind") == "course"}
    result["courseTargets"] = [
        {"roleNodeId": b["roleNodeId"], "target": b["target"], "title": courses[(b["target"]["namespace"], b["target"]["id"], b["target"]["revision"])]["title"], "kind": "course"}
        for b in alignment["bindings"] + result["pendingBindings"]
        if (b["target"]["namespace"], b["target"]["id"], b["target"]["revision"]) in courses
    ]
    row = CurriculumResolution(id=str(uuid4()), learner_id=current.learner.id, request_id=request_id,
                               body_hash=body_hash, resolution=result)
    db.add(row)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        previous = (await db.execute(select(CurriculumResolution).where(
            CurriculumResolution.learner_id == current.learner.id, CurriculumResolution.request_id == request_id,
        ))).scalar_one()
        same_request(previous, body_hash)
        return {"resolutionId": previous.id, "resolution": previous.resolution}
    return {"resolutionId": row.id, "resolution": result}


def _assert_additive_graph(base: dict, merged: dict, proposal: dict) -> None:
    # The TypeScript contract validator owns semantic/structural rules. This local
    # trust boundary independently prevents a remote response replacing source data.
    if graph_ref(merged) != graph_ref(base) or merged.get("protocolVersion") != base["protocolVersion"]:
        raise gateway.GatewayError("invalid_validation_result", "源图校验结果改变了基线身份。")
    for collection in ("nodes", "edges", "sources"):
        if merged.get(collection) != base[collection] + proposal.get(collection, []):
            raise gateway.GatewayError("invalid_validation_result", "源图校验结果不符合追加提案。")


async def commit(db: AsyncSession, current: CurrentLearner, request_id: str, resolution_id: str, *, production_context: dict | None = None) -> dict:
    body_hash = digest({"resolutionId": resolution_id})
    previous = (await db.execute(select(CurriculumCommit).where(
        CurriculumCommit.learner_id == current.learner.id, CurriculumCommit.request_id == request_id,
    ))).scalar_one_or_none()
    if previous:
        same_request(previous, body_hash)
        await gateway.dispatch(current, "package.resolve", str(uuid4()), {"packageRef": previous.receipt["alignment"]["packageRef"]})
        return previous.receipt
    row = (await db.execute(select(CurriculumResolution).where(
        CurriculumResolution.id == resolution_id, CurriculumResolution.learner_id == current.learner.id,
    ))).scalar_one_or_none()
    if not row:
        raise gateway.GatewayError("resolution_not_found", "挂载预览不存在或不属于当前主体。", 404)
    resolution = deepcopy(row.resolution)
    already = (await db.execute(select(CurriculumCommit).where(
        CurriculumCommit.learner_id == current.learner.id, CurriculumCommit.resolution_id == resolution_id,
    ))).scalar_one_or_none()
    if already:
        raise gateway.GatewayError("already_committed", "此预览已提交，请使用原请求标识读取回执。", 409)
    base = await read_graph(db, current)
    if graph_ref(base) != resolution["graphRef"]:
        raise gateway.GatewayError("stale_graph", "学习路径已更新，请重新生成挂载预览。", 409)
    await gateway.dispatch(current, "package.resolve", str(uuid4()), {"packageRef": resolution["packageRef"]})
    graph = deepcopy(base)
    proposal = resolution.get("extensionProposal")
    added = []
    if proposal:
        if proposal.get("namespace") != namespace_for(current):
            raise gateway.GatewayError("invalid_resolution", "特殊节点命名空间不属于当前主体。", 422)
        validated = await gateway.dispatch(current, "learning.validate_extension", str(uuid4()), {"proposal": proposal, "graph": base})
        if not isinstance(validated, dict) or validated.get("proposal") != proposal or not isinstance(validated.get("graph"), dict):
            raise gateway.GatewayError("invalid_validation_result", "特殊节点校验返回不完整。")
        graph = validated["graph"]
        _assert_additive_graph(base, graph, proposal)
        added = [node["id"] for node in proposal["nodes"]]
    # Every successful commit gets an immutable source revision, even binding-only commits.
    revision = "extension-" + digest({"base": graph_ref(base), "resolutionId": resolution_id, "graph": graph})[:32]
    graph["revision"] = revision
    alignment = deepcopy(resolution["alignment"])
    alignment["graphRef"] = graph_ref(graph)
    alignment["bindings"] += resolution.get("pendingBindings", [])
    validated = await gateway.dispatch(current, "learning.validate_alignment", str(uuid4()), {"alignment": alignment, "graph": graph})
    if not isinstance(validated, dict) or validated.get("alignment") != alignment:
        raise gateway.GatewayError("invalid_validation_result", "岗位语义绑定校验返回不一致。")
    receipt_id = str(uuid4())
    receipt = {"receiptId": receipt_id, "resolutionId": resolution_id, "graphRef": graph_ref(graph),
               "alignment": alignment, "addedNodeIds": added, "masteryUnchanged": True}
    try:
        changed = await db.execute(update(CurriculumGraphHead).where(
            CurriculumGraphHead.learner_id == current.learner.id,
            CurriculumGraphHead.revision == base["revision"],
        ).values(revision=revision, graph=graph).execution_options(synchronize_session=False))
        if changed.rowcount != 1:
            raise gateway.GatewayError("stale_graph", "学习路径已被另一请求更新，请重新生成预览。", 409)
        db.add(CurriculumCommit(id=receipt_id, learner_id=current.learner.id, request_id=request_id,
                               resolution_id=resolution_id, body_hash=body_hash, graph=graph, receipt=receipt))
        await record_event(db, learner_id=current.learner.id, event_type="learning_path_extension_committed",
                           source="ecosystem_gateway", actor_type="system" if production_context else "user", client_event_id="curriculum-commit:" + request_id,
                           payload={"resolution_id": resolution_id, "request_id": request_id, "graph_id": graph["graphId"],
                                    "base_revision": base["revision"], "revision": revision, "package_ref": resolution["packageRef"],
                                    "added_node_ids": added, "mastery_unchanged": True,
                                    **({"production_context": production_context} if production_context else {})},
                           provenance={"contract": gateway.PROTOCOL, "source_kind": "role_package", "package_ref": resolution["packageRef"],
                                       **({"authorization": "role_production_start", "production_context": production_context} if production_context else {})})
        await db.commit()
    except (IntegrityError, OperationalError):
        await db.rollback()
        previous = (await db.execute(select(CurriculumCommit).where(
            CurriculumCommit.learner_id == current.learner.id, CurriculumCommit.request_id == request_id,
        ))).scalar_one_or_none()
        if previous:
            same_request(previous, body_hash)
            return previous.receipt
        raise gateway.GatewayError("stale_graph", "学习路径有并发修改，请重新生成预览。", 409)
    except Exception:
        await db.rollback()
        raise
    return receipt
