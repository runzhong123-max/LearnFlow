#!/usr/bin/env python3
"""Stable JSON CLI for a host assistant and its human collaborator. No model keys."""
import argparse
import json
from pathlib import Path
import sys
import sqlite3

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "backend"))
from app.services.golden_role_workspace import GoldenWorkspace, WorkspaceError, safe_file  # noqa: E402


def read(path, json_data=False):
    p = safe_file(Path(path).expanduser().absolute())
    if p.stat().st_size > 2_000_000:
        raise WorkspaceError("input_file_too_large")
    content = p.read_text(encoding="utf-8")
    return json.loads(content) if json_data else content


def main():
    parser = argparse.ArgumentParser(description="黄金岗位本地协作：研究、审阅、案例检验与智能体升级")
    parser.add_argument("--workspace", default=str(Path(__file__).resolve().parent / "workspaces" / "primary"))
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("init")
    sub.add_parser("status")
    p = sub.add_parser("show"); p.add_argument("collection"); p.add_argument("--id")
    def mutation(name):
        p = sub.add_parser(name); p.add_argument("--request-id", required=True, help="同一逻辑操作重试复用此 ID；不同正文不得复用")
        return p
    p = mutation("scope"); p.add_argument("--role", required=True); p.add_argument("--audience", required=True); p.add_argument("--boundary", required=True)
    p = mutation("source-add"); p.add_argument("--file", required=True); p.add_argument("--title", required=True); p.add_argument("--kind", choices=["document", "expert_statement", "synthetic"], required=True)
    p = sub.add_parser("source-read"); p.add_argument("--id", required=True); p.add_argument("--offset", type=int, default=0); p.add_argument("--limit", type=int, default=6000)
    p = mutation("start"); p.add_argument("--objective", required=True); p.add_argument("--agent"); p.add_argument("--case")
    p = mutation("note"); p.add_argument("--session", required=True); p.add_argument("--author", choices=["human", "agent"], required=True); p.add_argument("--text", required=True)
    p = sub.add_parser("context"); p.add_argument("--session", required=True); p.add_argument("--sources", nargs="*", default=[]); p.add_argument("--nodes", nargs="*", default=[])
    p = mutation("propose"); p.add_argument("--session", required=True); p.add_argument("--file", required=True); p.add_argument("--reason", required=True)
    p = sub.add_parser("review"); p.add_argument("--proposal", required=True)
    p = mutation("decide"); p.add_argument("--proposal", required=True); p.add_argument("--decision", choices=["accept", "reject"], required=True); p.add_argument("--reviewer", required=True); p.add_argument("--reason", required=True); p.add_argument("--confirm", required=True)
    p = mutation("feedback"); p.add_argument("--session", required=True); p.add_argument("--layer", choices=["material", "definition", "prompt", "tool", "workflow", "interaction"], required=True); p.add_argument("--text", required=True)
    p = mutation("case-add"); p.add_argument("--file", required=True)
    p = mutation("agent-candidate"); p.add_argument("--instructions", required=True); p.add_argument("--feedback", nargs="+", required=True)
    p = mutation("evaluate"); p.add_argument("--proposal", required=True)
    p = sub.add_parser("compare"); p.add_argument("--agent", required=True)
    p = mutation("promote"); p.add_argument("--agent", required=True); p.add_argument("--reviewer", required=True); p.add_argument("--reason", required=True); p.add_argument("--confirm", required=True)
    p = mutation("finding"); p.add_argument("--session", required=True); p.add_argument("--target", choices=["role_atlas", "graph_hub", "learnflow", "local_agent"], required=True); p.add_argument("--problem", required=True); p.add_argument("--proposal", required=True); p.add_argument("--evidence", nargs="+", required=True)
    p = sub.add_parser("path-candidates"); p.add_argument("--query", required=True)
    sub.add_parser("export")
    p = sub.add_parser("render"); p.add_argument("--output", default="review.html"); p.add_argument("--proposal")
    a = parser.parse_args()
    try:
        w = GoldenWorkspace.initialize(a.workspace) if a.command == "init" else GoldenWorkspace(a.workspace)
        r = getattr(a, "request_id", None)
        c = a.command
        if c in {"init", "status"}: result = w.inspect()
        elif c == "show": result = w.inspect(a.collection, a.id)
        elif c == "scope": result = w.configure(a.role, a.audience, a.boundary, r)
        elif c == "source-add":
            if Path(a.file).suffix.lower() not in {".txt", ".md", ".json", ".csv"}:
                raise WorkspaceError("use_explicit_text_extract: supported .txt/.md/.json/.csv only")
            result = w.add_source(a.title, read(a.file), a.kind, r)
        elif c == "source-read": result = w.read_source(a.id, a.offset, a.limit)
        elif c == "start": result = w.start(a.objective, r, a.agent, a.case)
        elif c == "note": result = w.note(a.session, a.author, a.text, r)
        elif c == "context": result = w.context(a.session, a.sources, a.nodes)
        elif c == "propose": result = w.propose(a.session, read(a.file, True), a.reason, r)
        elif c == "review": result = w.review(a.proposal)
        elif c == "decide": result = w.decide(a.proposal, a.decision, a.reviewer, a.reason, a.confirm, r)
        elif c == "feedback": result = w.feedback(a.session, a.layer, a.text, r)
        elif c == "case-add":
            item = read(a.file, True)
            if not isinstance(item, dict) or set(item) != {"title", "scenario", "sourceIds", "requiredNodeIds"}:
                raise WorkspaceError("case_schema_invalid")
            result = w.add_case(item["title"], item["scenario"], item["sourceIds"], item["requiredNodeIds"], r)
        elif c == "agent-candidate": result = w.agent_candidate(read(a.instructions), a.feedback, r)
        elif c == "evaluate": result = w.evaluate(a.proposal, r)
        elif c == "compare": result = w.compare(a.agent)
        elif c == "promote": result = w.promote(a.agent, a.reviewer, a.reason, a.confirm, r)
        elif c == "finding": result = w.finding(a.session, a.target, a.problem, a.proposal, a.evidence, r)
        elif c == "path-candidates": result = w.learning_candidates(a.query)
        elif c == "export": result = w.export()
        elif c == "render":
            p = safe_file(w.root / a.output)
            if p.parent != w.root or p.suffix != ".html":
                raise WorkspaceError("render_output_must_be_html_in_workspace_root")
            p.write_text(w.render(a.proposal), encoding="utf-8"); result = {"path": str(p), "readOnly": True}
        print(json.dumps({"ok": True, "data": result}, ensure_ascii=False, indent=2))
    except (WorkspaceError, OSError, ValueError, KeyError, sqlite3.Error) as exc:
        print(json.dumps({"ok": False, "error": {"type": type(exc).__name__, "message": str(exc)}}, ensure_ascii=False), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
