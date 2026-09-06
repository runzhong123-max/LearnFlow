#!/usr/bin/env python3
"""Synthetic workflow smoke test, not a real expert review or a model-quality eval."""
import argparse
import json
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / "backend"))
from app.services.golden_role_workspace import GoldenWorkspace  # noqa: E402


def main():
    p = argparse.ArgumentParser(description="在新的独立目录运行合成案例；不覆盖已有目录")
    p.add_argument("--workspace", required=True)
    args = p.parse_args()
    w = GoldenWorkspace.initialize(args.workspace)
    w.configure("软件测试技术员（合成演示）", "工具开发验收", "仅检验协作机制，不形成岗位事实", "demo-scope")
    source = w.add_source("教学合成优惠券案例", (HERE / "examples/source.md").read_text(), "synthetic", "demo-source")
    graph = json.loads((HERE / "examples/candidate.json").read_text().replace("REPLACE_WITH_SOURCE_ID", source["id"]))
    session = w.start("根据合成案例检验第一轮协作", "demo-start")
    w.note(session["id"], "agent", "将工作交付与边界值技能分别定义；这只是合成案例。", "demo-note")
    proposal = w.propose(session["id"], graph, "为离线验收提出任务及技能两个节点", "demo-proposal")
    report = w.review(proposal["id"])
    (w.root / "proposal.html").write_text(w.render(proposal["id"]), encoding="utf-8")
    w.decide(proposal["id"], "accept", "合成演示中的模拟审阅者", "演示事务与版本流程；没有真实专家确认", report["confirmationHash"], "demo-accept")
    feedback = w.feedback(session["id"], "prompt", "提示词应要求输入条件与预期结果成对呈现。", "demo-feedback")
    candidate = w.agent_candidate("检查每个技能的输入条件和可观察产物，逐条引用资料。生成候选后等待人审阅。", [feedback["id"]], "demo-agent")
    case = w.add_case("边界值技能保留", "改写任务时应保留案例需要的边界值技能。", [source["id"]], ["skill:boundary-cases"], "demo-case")
    for label, agent in [("baseline", "agent:v1"), ("candidate", candidate["id"])]:
        s = w.start("同一合成案例的管线检查", f"demo-{label}-start", agent, case["id"])
        proposed = w.propose(s["id"], graph, "固定样例结果；没有调用模型，不能证明指令效果", f"demo-{label}-proposal")
        w.evaluate(proposed["id"], f"demo-{label}-evaluate")
    comparison = w.compare(candidate["id"])
    # Deliberately leave profile promotion pending for actual human review.
    finding = w.finding(session["id"], "role_atlas", "节点变更审阅需看输入与验收条件", "在节点差异中并排显示条件、产物与考核要求", [feedback["id"]], "demo-finding")
    (w.root / "review.html").write_text(w.render(), encoding="utf-8")
    (w.root / "handoff.json").write_text(json.dumps(w.export(), ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"workspace": str(w.root), "status": w.inspect(), "proposalReport": str(w.root / "proposal.html"), "graphReport": str(w.root / "review.html"), "comparison": comparison, "finding": finding, "syntheticOnly": True, "modelExecuted": False}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
