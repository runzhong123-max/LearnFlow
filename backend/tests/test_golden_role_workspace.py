import concurrent.futures
import copy
import json
from pathlib import Path
import subprocess
import sys

import pytest
from app.services.golden_role_workspace import GoldenWorkspace, WorkspaceError, GRAPH_PROTOCOL

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def workspace(tmp_path):
    w = GoldenWorkspace.initialize(tmp_path / "research")
    w.configure("软件测试技术员", "高职软件技术专业", "初级业务规则测试，不含框架研发", "scope-1")
    source = w.add_source("教学合成案例", (ROOT / "labs/golden-role/examples/source.md").read_text(), "synthetic", "source-1")
    graph = json.loads((ROOT / "labs/golden-role/examples/candidate.json").read_text().replace("REPLACE_WITH_SOURCE_ID", source["id"]))
    return w, source, graph


def proposal(w, graph, request, agent=None, case=None):
    session = w.start("检查边界值技能定义", f"start-{request}", agent, case)
    return w.propose(session["id"], graph, "依据案例完善任务与技能定义", request)


def accept(w, p, request="accept-1"):
    review = w.review(p["id"])
    return w.decide(p["id"], "accept", "验收测试中的模拟审阅者", "只接受教学合成案例作为工具测试", review["confirmationHash"], request)


def test_scope_pending_is_not_silently_assigned(tmp_path):
    w = GoldenWorkspace.initialize(tmp_path / "empty")
    assert w.inspect()["scope"]["role"] is None
    with pytest.raises(WorkspaceError, match="scope_pending"):
        w.start("研究", "start")
    with pytest.raises(WorkspaceError, match="already exists"):
        GoldenWorkspace.initialize(w.root)
    assert w.inspect()["head"]["revision"] == 0


def test_persistent_review_atomic_accept_and_idempotent_replay(workspace):
    w, source, graph = workspace
    p = proposal(w, graph, "p1")
    assert w.inspect()["head"]["revision"] == 0
    assert not w.review(p["id"])["errors"]
    receipt = accept(w, p)
    reloaded = GoldenWorkspace(w.root)
    assert reloaded.inspect()["head"]["revision"] == 1
    assert reloaded.inspect("graph") == graph
    replay = w.decide(p["id"], "accept", receipt["reviewer"], receipt["reason"], receipt["confirmationHash"], "accept-1")
    assert receipt == replay
    with pytest.raises(WorkspaceError, match="idempotency_conflict"):
        w.decide(p["id"], "reject", receipt["reviewer"], "变了", receipt["confirmationHash"], "accept-1")
    assert len([r for r in w.inspect("journal") if r["operation"] == "proposal.reviewed"]) == 1
    assert w.read_source(source["id"], 0, 12)["nextOffset"] == 12


def test_false_quotes_and_changed_confirmation_fail_without_state_write(workspace):
    w, _, graph = workspace
    graph["nodes"][0]["evidence"][0]["quote"] = "这个句子并未出现在材料中"
    p = proposal(w, graph, "bad")
    assert any("unresolved_quote" in e for e in w.review(p["id"])["errors"])
    with pytest.raises(WorkspaceError, match="invalid_graph"):
        accept(w, p)
    with pytest.raises(WorkspaceError, match="review_hash_mismatch"):
        w.decide(p["id"], "reject", "human", "拒绝", "forged", "bad-confirm")
    assert w.inspect()["head"]["revision"] == 0
    assert w.inspect("proposals", p["id"])["status"] == "pending"


@pytest.mark.parametrize("mutation,expected", [
    (lambda g: g["edges"][0].update(to="missing"), "dangling_edge"),
    (lambda g: g["nodes"][0].update(deliverables=[]), "task_missing_deliverable"),
    (lambda g: g["nodes"][1].update(criteria=[]), "missing_criteria"),
    (lambda g: g["nodes"].append(copy.deepcopy(g["nodes"][0])), "duplicate_node"),
    (lambda g: g["edges"][0].update(kind="similar_to"), "relation_type_mismatch"),
    (lambda g: g["nodes"][0].update(kind=[]), "node_kind_invalid"),
])
def test_graph_validation_handles_invalid_candidates(workspace, mutation, expected):
    w, _, graph = workspace; mutation(graph)
    p = proposal(w, graph, "invalid")
    assert any(expected in e for e in p["errors"])


def test_conflicting_sessions_are_stale_and_scope_changes_pin_context(workspace):
    w, _, graph = workspace
    first = proposal(w, graph, "first"); second = proposal(w, graph, "second")
    accept(w, first)
    assert w.review(second["id"])["stale"]
    with pytest.raises(WorkspaceError, match="stale_base"):
        accept(w, second, "accept-second")
    third = proposal(w, graph, "third")
    w.configure("软件测试技术员", "本科", "自动化测试", "scope-2")
    context = w.context(third["sessionId"])
    assert context["stale"]
    assert context["scope"]["audience"] != context["currentScope"]["audience"]
    assert w.review(third["id"])["stale"]


def test_concurrent_accepts_cannot_overwrite(workspace):
    w, _, graph = workspace
    a = proposal(w, graph, "a"); b = proposal(w, graph, "b")
    def run(p):
        try:
            accept(GoldenWorkspace(w.root), p, p["id"])
            return "accepted"
        except WorkspaceError:
            return "stale"
    with concurrent.futures.ThreadPoolExecutor(2) as pool:
        results = list(pool.map(run, [a, b]))
    assert sorted(results) == ["accepted", "stale"]
    assert w.inspect()["head"]["revision"] == 1


def test_dependency_cycle_rejected(workspace):
    w, _, graph = workspace
    point = copy.deepcopy(graph["nodes"][1]); point["id"] = "skill:another"; graph["nodes"].append(point)
    graph["edges"] += [{"id": "a", "from": "skill:boundary-cases", "to": "skill:another", "kind": "prerequisite_of", "rationale": "测试"}, {"id": "b", "from": "skill:another", "to": "skill:boundary-cases", "kind": "prerequisite_of", "rationale": "测试"}]
    assert "dependency_cycle" in proposal(w, graph, "cycle")["errors"]


def test_profile_promotion_requires_paired_cases_and_human_review(workspace):
    w, source, graph = workspace
    session = w.start("研究反馈", "start-feedback")
    feedback = w.feedback(session["id"], "prompt", "需要检查条件和预期结果", "feedback-1")
    candidate = w.agent_candidate("明确区分边界输入和预期结果，先读取证据。", [feedback["id"]], "upgrade-1")
    with pytest.raises(WorkspaceError, match="paired_case"):
        w.promote(candidate["id"], "human", "测试", "fake", "too-early")
    case = w.add_case("边界数据", "从优惠券需求提取测试要求", [source["id"]], ["skill:boundary-cases"], "case-1")
    assert case["synthetic"]
    base = proposal(w, graph, "base-case", "agent:v1", case["id"])
    upgraded = proposal(w, graph, "new-case", candidate["id"], case["id"])
    w.evaluate(upgraded["id"], "eval-new")
    assert not w.compare(candidate["id"])["eligibleForHumanReview"]
    w.evaluate(base["id"], "eval-base")
    comparison = w.compare(candidate["id"])
    assert comparison["eligibleForHumanReview"]
    assert comparison["candidateInstructions"] != comparison["baselineInstructions"]
    result = w.promote(candidate["id"], "测试审阅者", "仅检验升级管线，不宣称模型质量提升", comparison["confirmationHash"], "promote-1")
    assert w.inspect()["activeAgent"] == result["activeAgent"]
    assert w.inspect()["head"]["revision"] == 0  # agent upgrade never accepts a graph
    assert w.context(upgraded["sessionId"])["profile"] == comparison["candidateInstructions"]


def test_findings_need_evidence(workspace):
    w, source, graph = workspace
    session = w.start("发现产品问题", "start-find")
    with pytest.raises(WorkspaceError, match="requires_feedback"):
        w.finding(session["id"], "graph_hub", "缺引用迁移", "新增迁移记录", [], "finding-bad")
    feedback = w.feedback(session["id"], "tool", "合并节点后需要看到旧引用", "fb")
    finding = w.finding(session["id"], "graph_hub", "缺引用迁移", "新增迁移记录", [feedback["id"]], "finding-ok")
    assert finding["status"] == "hypothesis"
    export = w.export()
    assert export["publicationStatus"] == "unpublished_research_artifact"
    assert "packageRef" not in export
    assert export["sources"][0]["kind"] == "synthetic"


def test_failed_mutation_rolls_back_blobs_state_and_journal(workspace):
    w, _, _ = workspace
    before = w.inspect("journal")
    def fail(db, state):
        state["scope"]["role"] = "bad"
        w._put(db, "orphan")
        raise RuntimeError("simulated interruption")
    with pytest.raises(RuntimeError):
        w.mutate("test", {}, "rollback", fail)
    assert w.inspect("journal") == before
    assert w.inspect()["scope"]["role"] == "软件测试技术员"
    with w.connect() as db:
        assert db.execute("SELECT COUNT(*) FROM requests WHERE id='rollback'").fetchone()[0] == 0


def test_html_escapes_model_supplied_content_and_symlinks_fail(workspace, tmp_path):
    w, _, graph = workspace
    graph["nodes"][0]["title"] = '<script>alert("x")</script>'
    accept(w, proposal(w, graph, "xss"))
    report = w.render()
    assert "<script>" not in report and "&lt;script&gt;" in report
    link = tmp_path / "linked"; link.symlink_to(w.root)
    with pytest.raises(WorkspaceError, match="symlink"):
        GoldenWorkspace(link)


def test_cli_reopens_state_and_rejects_invalid_input(tmp_path):
    cli = ROOT / "labs/golden-role/golden.py"
    args = [sys.executable, str(cli), "--workspace", str(tmp_path / "cli")]
    first = subprocess.run([*args, "init"], capture_output=True, text=True)
    assert first.returncode == 0
    second = subprocess.run([*args, "status"], capture_output=True, text=True)
    assert json.loads(first.stdout)["data"]["workspaceId"] == json.loads(second.stdout)["data"]["workspaceId"]
    third = subprocess.run([*args, "render", "--output", "../escape.html"], capture_output=True, text=True)
    assert third.returncode != 0 and not (tmp_path / "escape.html").exists()


def test_latest_failure_and_new_case_invalidate_promotion(workspace):
    w, source, graph = workspace
    session = w.start("改进", "s")
    fb = w.feedback(session["id"], "prompt", "检查覆盖", "f")
    agent = w.agent_candidate("覆盖所需节点", [fb["id"]], "a")
    case = w.add_case("覆盖", "检查技能", [source["id"]], ["skill:boundary-cases"], "c")
    for label, aid in [("base", "agent:v1"), ("new", agent["id"])]:
        p = proposal(w, graph, label, aid, case["id"])
        w.evaluate(p["id"], "eval-" + label)
    old = w.compare(agent["id"])
    assert old["eligibleForHumanReview"]
    broken = copy.deepcopy(graph)
    broken["nodes"] = broken["nodes"][:1]; broken["edges"] = []
    p = proposal(w, broken, "failed", agent["id"], case["id"])
    latest = w.evaluate(p["id"], "eval-failed")
    current = GoldenWorkspace(w.root).compare(agent["id"])
    assert current["pairs"][0]["candidate"]["id"] == latest["id"]
    assert not current["eligibleForHumanReview"]
    with pytest.raises(WorkspaceError, match="paired_case"):
        w.promote(agent["id"], "测试", "旧报告不能覆盖失败", old["confirmationHash"], "blocked")
    p = proposal(w, graph, "repaired", agent["id"], case["id"])
    w.evaluate(p["id"], "eval-repaired")
    assert w.compare(agent["id"])["eligibleForHumanReview"]
    w.add_case("新增案例", "新场景", [source["id"]], ["skill:boundary-cases"], "new-case")
    assert not w.compare(agent["id"])["eligibleForHumanReview"]


def test_edge_only_changes_show_affected_nodes_and_cases(workspace):
    w, source, graph = workspace
    accept(w, proposal(w, graph, "initial"))
    case = w.add_case("引用影响", "检查关系", [source["id"]], ["skill:boundary-cases"], "case")
    graph["edges"] = []
    p = proposal(w, graph, "remove-edge")
    report = w.review(p["id"])
    assert "skill:boundary-cases" in report["affectedNodeIds"]
    assert case["id"] in report["affectedCaseIds"]
    assert "候选变更审阅" in w.render(p["id"])


def test_path_candidates_are_read_only_and_unbound(workspace):
    w, _, _ = workspace
    before = w.inspect("journal")
    result = w.learning_candidates("软件")
    assert result["status"] == "lexical_candidates_not_semantic_bindings"
    assert result["graphRef"]["revision"]
    assert w.inspect("journal") == before
