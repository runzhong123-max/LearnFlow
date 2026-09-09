import { canonicalStringify, sha256Hex } from "@/lib/versioning/canonical";
import { intakeSchema } from "./schema";
import { IntakeError, type ConfirmedIntake, type IntakeConfirmInput, type IntakeHistoryItem, type IntakeRevisionContent, type IntakeScope, type IntakeTurnInput, type IntakeView } from "./types";

type Head = { head_revision_id: string | null; pending_revision_id: string | null; confirmed_revision_id: string | null };
type Revision = {
  id: string; conversation_id: string; project_id: string; operation_id: string;
  input_hash: string; input_json: string; base_revision_id: string | null;
  state: "running" | "ready" | "failed"; lease_owner: string | null; lease_expires_at: string | null;
  result_json: string | null; content_hash: string | null; error: string | null;
  confirmed_by: string | null; confirmed_at: string | null; confirmation_operation_id: string | null; build_run_id: string | null;
  created_at: string; updated_at: string;
};
export type IntakeTurnClaim = { revisionId: string; owner: string; input: IntakeTurnInput; previous: IntakeRevisionContent | null };

const owned = `EXISTS (SELECT 1 FROM projects p JOIN conversations c ON c.project_id=p.id
  WHERE p.id=? AND c.id=? AND p.owner_subject_id=? AND p.deleted_at IS NULL)`;
const idle = `NOT EXISTS (SELECT 1 FROM projects WHERE id=? AND status='building')
  AND NOT EXISTS (SELECT 1 FROM role_jobs WHERE conversation_id=? AND status IN ('queued','running','waiting_user'))`;
const scopeValues = (scope: IntakeScope) => [scope.projectId, scope.conversationId, scope.subjectId];

/** D1 is injected so the actual transactions can be exercised against isolated SQLite. */
export class IntakeRepository {
  constructor(private db: D1Database, private clock = () => new Date()) {}
  async ensure() { await this.db.batch(intakeSchema.map(sql => this.db.prepare(sql))); }

  async scope(scope: IntakeScope) {
    if (!scope.subjectId) throw new IntakeError(401, "LOGIN_REQUIRED", "请先登录。");
    const project = await this.db.prepare(`SELECT p.title,p.description,p.market,p.status FROM projects p
      JOIN conversations c ON c.project_id=p.id WHERE p.id=? AND c.id=? AND p.owner_subject_id=? AND p.deleted_at IS NULL`)
      .bind(...scopeValues(scope)).first<{ title: string; description: string; market: string; status: string }>();
    if (!project) throw new IntakeError(404, "INTAKE_NOT_FOUND", "项目或会话不存在。");
    return project;
  }
  private async head(scope: IntakeScope) {
    return this.db.prepare("SELECT head_revision_id,pending_revision_id,confirmed_revision_id FROM role_intakes WHERE project_id=? AND conversation_id=?")
      .bind(scope.projectId, scope.conversationId).first<Head>();
  }
  private async revision(scope: IntakeScope, id: string) {
    return this.db.prepare("SELECT * FROM role_intake_revisions WHERE id=? AND project_id=? AND conversation_id=?")
      .bind(id, scope.projectId, scope.conversationId).first<Revision>();
  }
  private async history(scope: IntakeScope): Promise<IntakeHistoryItem[]> {
    const rows = await this.db.prepare(`SELECT id,role,text,created_at AS createdAt FROM messages
      WHERE conversation_id=? AND id LIKE 'intake:%' ORDER BY created_at DESC,id DESC LIMIT 80`)
      .bind(scope.conversationId).all<IntakeHistoryItem>();
    return rows.results.reverse();
  }
  private async assertIdle(scope: IntakeScope) {
    const row = await this.db.prepare(`SELECT 1 AS ok WHERE ${idle}`).bind(scope.projectId, scope.conversationId).first();
    if (!row) throw new IntakeError(409, "INTAKE_BUILD_ACTIVE", "当前岗位正在生成，请等待完成后改进，或新建对话继续研究。");
  }
  async get(scope: IntakeScope): Promise<IntakeView> {
    const project = await this.scope(scope);
    const head = await this.head(scope);
    const row = head?.head_revision_id ? await this.revision(scope, head.head_revision_id) : null;
    const content = row?.result_json ? JSON.parse(row.result_json) as IntakeRevisionContent : null;
    const history = await this.history(scope);
    const confirmed = Boolean(row && head?.confirmed_revision_id === row.id && row.confirmed_by === scope.subjectId);
    const interrupted = await this.db.prepare(`SELECT id,state,error,input_json FROM role_intake_revisions WHERE conversation_id=? AND project_id=?
      AND base_revision_id IS ? AND updated_at>=?
      AND ((state='failed' AND error IS NOT NULL) OR (state='running' AND lease_expires_at<=?))
      ORDER BY updated_at DESC,id DESC LIMIT 1`)
      .bind(scope.conversationId, scope.projectId, row?.id || null, row?.updated_at || "", this.clock().toISOString())
      .first<{ id: string; state: "failed" | "running"; error: string | null; input_json: string }>();
    const recoverableInput = interrupted ? JSON.parse(interrupted.input_json) as IntakeTurnInput : null;
    const recovery: IntakeView["recovery"] = interrupted && recoverableInput ? {
      revisionId: interrupted.id, state: interrupted.state === "running" ? "interrupted" : "failed",
      input: recoverableInput, message: interrupted.error || "上一轮整理已中断，输入已保留，可使用同一操作重试。",
    } : undefined;
    const warnings = [...(content?.warnings || []), ...(recovery ? [recovery.message] : [])];
    return {
      phase: confirmed ? "confirmed" : content?.phase || "clarifying",
      revisionId: row?.id || null, contentHash: row?.content_hash || null,
      roleTitle: content?.roleTitle || recoverableInput?.roleTitle || project.title, market: content?.market || recoverableInput?.market || project.market,
      description: content?.description || "", assistantMessage: content?.assistantMessage || "先说明你希望了解的岗位或工作方向。",
      questions: content?.questions || [], sources: content?.sources || recoverableInput?.sources || [], hubMatches: content?.hubMatches || [],
      history, warnings, researchStatus: content?.researchStatus || "not_started",
      ...(confirmed && row?.build_run_id ? { buildRunId: row.build_run_id } : {}),
      ...(recovery ? { recovery } : {}),
    };
  }

  async begin(scope: IntakeScope, input: IntakeTurnInput): Promise<{ completed: IntakeView } | { claim: IntakeTurnClaim }> {
    await this.scope(scope);
    // Credentials are invocation settings, never draft content or idempotency material.
    const { providerConfig: _provider, searchConfig: _search, ...persistent } = input;
    const inputJson = canonicalStringify(persistent), inputHash = await sha256Hex(inputJson);
    const previousOperation = await this.db.prepare("SELECT * FROM role_intake_revisions WHERE conversation_id=? AND operation_id=?")
      .bind(scope.conversationId, input.operationId).first<Revision>();
    if (previousOperation && previousOperation.input_hash !== inputHash) throw new IntakeError(409, "INTAKE_OPERATION_CONFLICT", "同一操作不能使用不同输入，请重新发起改进。");
    if (previousOperation?.state === "ready") return { completed: await this.get(scope) };
    await this.assertIdle(scope);
    const head = await this.head(scope);
    const expected = input.expectedRevisionId || null;
    if ((head?.head_revision_id || null) !== expected) throw new IntakeError(409, "INTAKE_REVISION_CONFLICT", "岗位说明已有新版本，请刷新后继续。");
    const now = this.clock().toISOString(), expires = new Date(this.clock().getTime() + 180_000).toISOString();
    const id = previousOperation?.id || `intake-revision:${crypto.randomUUID()}`, owner = crypto.randomUUID();
    const text = input.message || [input.action === "clarify" ? "我还不明确岗位方向" : input.action === "refine" ? "改进岗位说明" : "生成岗位说明", input.roleTitle, input.goal].filter(Boolean).join("\n");
    await this.db.batch([
      this.db.prepare(`INSERT OR IGNORE INTO role_intakes(conversation_id,project_id,created_at,updated_at)
        SELECT ?,?,?,? WHERE ${owned}`).bind(scope.conversationId, scope.projectId, now, now, ...scopeValues(scope)),
      this.db.prepare(`INSERT OR IGNORE INTO role_intake_revisions(id,conversation_id,project_id,operation_id,input_hash,input_json,base_revision_id,state,created_at,updated_at)
        SELECT ?,?,?,?,?,?,?,'failed',?,? WHERE ${owned}`)
        .bind(id, scope.conversationId, scope.projectId, input.operationId, inputHash, inputJson, expected, now, now, ...scopeValues(scope)),
      this.db.prepare(`UPDATE role_intake_revisions SET state='running',lease_owner=?,lease_expires_at=?,error=NULL,updated_at=?
        WHERE id=? AND input_hash=? AND (state='failed' OR (state='running' AND lease_expires_at<=?))
        AND ${owned} AND ${idle}
        AND EXISTS(SELECT 1 FROM role_intakes h WHERE h.conversation_id=? AND h.head_revision_id IS ?
          AND (h.pending_revision_id IS NULL OR h.pending_revision_id=? OR EXISTS(
            SELECT 1 FROM role_intake_revisions old WHERE old.id=h.pending_revision_id AND (old.state!='running' OR old.lease_expires_at<=?))))`)
        .bind(owner, expires, now, id, inputHash, now, ...scopeValues(scope), scope.projectId, scope.conversationId, scope.conversationId, expected, id, now),
      this.db.prepare(`UPDATE role_intakes SET pending_revision_id=?,confirmed_revision_id=NULL,updated_at=? WHERE conversation_id=? AND project_id=?
        AND EXISTS(SELECT 1 FROM role_intake_revisions WHERE id=? AND lease_owner=? AND state='running')`)
        .bind(id, now, scope.conversationId, scope.projectId, id, owner),
      this.db.prepare(`INSERT OR IGNORE INTO messages(id,conversation_id,role,text,status,created_at)
        SELECT ?,?,'user',?,'done',? WHERE EXISTS(SELECT 1 FROM role_intake_revisions WHERE id=? AND lease_owner=? AND state='running')`)
        .bind(`intake:${id}:user`, scope.conversationId, text, now, id, owner),
    ]);
    const claimed = await this.revision(scope, id);
    if (claimed?.lease_owner !== owner || claimed.state !== "running") throw new IntakeError(409, "INTAKE_OPERATION_ACTIVE", "当前对话正在整理岗位说明，请稍后使用同一操作重试。");
    const previous = expected ? await this.revision(scope, expected) : null;
    return { claim: { revisionId: id, owner, input, previous: previous?.result_json ? JSON.parse(previous.result_json) as IntakeRevisionContent : null } };
  }

  async complete(scope: IntakeScope, claim: IntakeTurnClaim, content: IntakeRevisionContent) {
    const json = canonicalStringify(content), hash = await sha256Hex(json), now = this.clock().toISOString();
    const results = await this.db.batch([
      this.db.prepare(`UPDATE role_intake_revisions SET state='ready',result_json=?,content_hash=?,error=NULL,lease_expires_at=NULL,updated_at=?
        WHERE id=? AND lease_owner=? AND state='running' AND lease_expires_at>? AND ${owned} AND ${idle}
        AND EXISTS(SELECT 1 FROM role_intakes WHERE conversation_id=? AND pending_revision_id=? AND head_revision_id IS ?)`)
        .bind(json, hash, now, claim.revisionId, claim.owner, now, ...scopeValues(scope), scope.projectId, scope.conversationId, scope.conversationId, claim.revisionId, claim.input.expectedRevisionId || null),
      this.db.prepare(`UPDATE role_intakes SET head_revision_id=?,pending_revision_id=NULL,confirmed_revision_id=NULL,updated_at=?
        WHERE conversation_id=? AND pending_revision_id=? AND EXISTS(SELECT 1 FROM role_intake_revisions WHERE id=? AND lease_owner=? AND state='ready' AND content_hash=?)`)
        .bind(claim.revisionId, now, scope.conversationId, claim.revisionId, claim.revisionId, claim.owner, hash),
      this.db.prepare(`INSERT OR IGNORE INTO messages(id,conversation_id,role,text,activities_json,citations_json,status,created_at)
        SELECT ?,?,'assistant',?,?,?,'done',? WHERE EXISTS(SELECT 1 FROM role_intakes h JOIN role_intake_revisions r ON r.id=h.head_revision_id
          WHERE h.conversation_id=? AND r.id=? AND r.lease_owner=? AND r.state='ready')`)
        .bind(`intake:${claim.revisionId}:assistant`, scope.conversationId, [content.assistantMessage, content.description, ...content.questions].filter(Boolean).join("\n\n"),
          JSON.stringify([{ id: claim.revisionId, label: content.phase === "review" ? "岗位说明待确认" : "岗位方向澄清", status: "done" }]),
          JSON.stringify(content.sources.filter(source => source.kind === "public_document").map(source => ({ title: source.title, url: source.locator, fetchedAt: source.fetchedAt }))),
          now, scope.conversationId, claim.revisionId, claim.owner),
      this.db.prepare(`UPDATE conversations SET updated_at=? WHERE id=? AND EXISTS(SELECT 1 FROM role_intakes WHERE conversation_id=? AND head_revision_id=?)`)
        .bind(now, scope.conversationId, scope.conversationId, claim.revisionId),
    ]);
    if (!results[0].meta.changes) throw new IntakeError(409, "INTAKE_STALE_OPERATION", "本轮已失效或项目状态改变，较新的岗位说明已保留。");
    return this.get(scope);
  }

  async fail(scope: IntakeScope, claim: IntakeTurnClaim, message: string) {
    const now = this.clock().toISOString();
    await this.db.batch([
      this.db.prepare(`UPDATE role_intake_revisions SET state='failed',lease_owner=NULL,lease_expires_at=NULL,error=?,updated_at=?
        WHERE id=? AND lease_owner=? AND state='running' AND ${owned}`).bind(message, now, claim.revisionId, claim.owner, ...scopeValues(scope)),
      this.db.prepare(`UPDATE role_intakes SET pending_revision_id=NULL,updated_at=? WHERE conversation_id=? AND pending_revision_id=?
        AND EXISTS(SELECT 1 FROM role_intake_revisions WHERE id=? AND state='failed')`).bind(now, scope.conversationId, claim.revisionId, claim.revisionId),
    ]);
  }

  async confirm(scope: IntakeScope, input: IntakeConfirmInput) {
    await this.scope(scope);
    const head = await this.head(scope), row = await this.revision(scope, input.revisionId);
    if (!row) throw new IntakeError(404, "INTAKE_NOT_FOUND", "岗位说明不存在。");
    if (head?.head_revision_id !== row.id || row.content_hash !== input.contentHash || head.pending_revision_id) throw new IntakeError(409, "INTAKE_REVISION_CONFLICT", "岗位说明正在更新或版本已改变，请查看最新内容后确认。");
    if (row.state !== "ready" || !row.result_json || (JSON.parse(row.result_json) as IntakeRevisionContent).phase !== "review") throw new IntakeError(409, "INTAKE_NOT_REVIEWABLE", "请先生成包含任务、能力和场景的岗位说明。");
    const reused = await this.db.prepare("SELECT id FROM role_intake_revisions WHERE conversation_id=? AND confirmation_operation_id=?")
      .bind(scope.conversationId, input.operationId).first<{ id: string }>();
    if (reused && reused.id !== row.id) throw new IntakeError(409, "INTAKE_OPERATION_CONFLICT", "确认操作对应另一版说明，请重新确认。");
    if (row.confirmed_by === scope.subjectId && head.confirmed_revision_id === row.id) return this.get(scope);
    await this.assertIdle(scope);
    const runId = row.build_run_id || input.buildRunId || crypto.randomUUID();
    if (!row.build_run_id) {
      const existing = await this.db.prepare("SELECT id FROM role_jobs WHERE id=? UNION ALL SELECT id FROM build_runs WHERE id=?")
        .bind(runId, runId).first();
      if (existing) throw new IntakeError(409, "INTAKE_BUILD_ID_CONFLICT", "构建标识已被使用，请重新确认。");
    }
    const now = this.clock().toISOString();
    const content = JSON.parse(row.result_json) as IntakeRevisionContent;
    await this.db.batch([
      this.db.prepare(`UPDATE role_intake_revisions SET confirmed_by=?,confirmed_at=?,confirmation_operation_id=?,build_run_id=?
        WHERE id=? AND content_hash=? AND confirmed_at IS NULL AND ${owned} AND ${idle}
        AND EXISTS(SELECT 1 FROM role_intakes WHERE conversation_id=? AND head_revision_id=? AND pending_revision_id IS NULL)`)
        .bind(scope.subjectId, now, input.operationId, runId, row.id, input.contentHash, ...scopeValues(scope), scope.projectId, scope.conversationId, scope.conversationId, row.id),
      this.db.prepare(`UPDATE role_intakes SET confirmed_revision_id=?,updated_at=? WHERE conversation_id=? AND head_revision_id=? AND pending_revision_id IS NULL
        AND ${owned} AND ${idle} AND EXISTS(SELECT 1 FROM role_intake_revisions WHERE id=? AND content_hash=? AND confirmed_by=? AND build_run_id IS NOT NULL)`)
        .bind(row.id, now, scope.conversationId, row.id, ...scopeValues(scope), scope.projectId, scope.conversationId, row.id, input.contentHash, scope.subjectId),
      this.db.prepare(`UPDATE projects SET title=?,description=?,market=?,updated_at=? WHERE id=? AND owner_subject_id=? AND deleted_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM project_versions WHERE project_id=projects.id)
        AND EXISTS(SELECT 1 FROM role_intakes h JOIN role_intake_revisions r ON r.id=h.confirmed_revision_id
          WHERE h.project_id=projects.id AND h.conversation_id=? AND h.head_revision_id=r.id AND h.pending_revision_id IS NULL
            AND r.id=? AND r.content_hash=? AND r.confirmed_by=projects.owner_subject_id)`)
        .bind(content.roleTitle, content.description, content.market, now, scope.projectId, scope.subjectId, scope.conversationId, row.id, input.contentHash),
    ]);
    const view = await this.get(scope);
    if (view.phase !== "confirmed" || view.revisionId !== row.id) throw new IntakeError(409, "INTAKE_REVISION_CONFLICT", "岗位状态已经改变，请刷新后确认。");
    return view;
  }

  async requireConfirmed(scope: IntakeScope, input: { revisionId: string; contentHash: string; runId: string }): Promise<ConfirmedIntake> {
    await this.scope(scope);
    const head = await this.head(scope), row = await this.revision(scope, input.revisionId);
    if (!row || head?.head_revision_id !== row.id || head.confirmed_revision_id !== row.id || head.pending_revision_id
      || row.state !== "ready" || row.content_hash !== input.contentHash || row.confirmed_by !== scope.subjectId || !row.confirmed_at || !row.result_json) {
      throw new IntakeError(409, "INTAKE_CONFIRMATION_REQUIRED", "请先确认当前版本的岗位说明，再开始生成。");
    }
    if (row.build_run_id !== input.runId) throw new IntakeError(409, "INTAKE_BUILD_ID_CONFLICT", "请继续已确认的构建任务，不要重复创建任务。");
    const content = JSON.parse(row.result_json) as IntakeRevisionContent;
    if (await sha256Hex(canonicalStringify(content)) !== input.contentHash || content.phase !== "review") throw new IntakeError(409, "INTAKE_CONTENT_MISMATCH", "岗位说明内容校验失败。");
    return { revisionId: row.id, contentHash: row.content_hash, roleTitle: content.roleTitle, market: content.market,
      description: content.description, sources: content.sources, confirmedAt: row.confirmed_at, buildRunId: row.build_run_id };
  }
}
