export type RoleSkillId =
  | "cold-start-role-package"
  | "snapshot-iteration"
  | "node-deepening"
  | "workspace-instantiation";

export type WorkspaceSkillId = Exclude<RoleSkillId, "cold-start-role-package">;

export type WorkspaceSkillContext = {
  snapshotId?: string;
  projectId?: string;
  versionId?: string;
  conversationId?: string;
  selectedNodeIds?: string[];
  availableNodes?: Array<{ id: string; label: string }>;
  roleTitle: string;
  roleDescription?: string;
  market?: string;
};

export type RoleSkillDefinition = {
  id: RoleSkillId;
  label: string;
  description: string;
  scope: "project_creation" | "snapshot";
  execution: "durable_job";
  disclosure: "metadata_first";
  defaultProfile?: "co_guided" | "user_directed";
};

/**
 * Product-wide Skill catalog. The normal workspace only sees this compact
 * metadata; conversation plugins submit persisted jobs while the central display stays mounted.
 */
export const roleSkillDefinitions: RoleSkillDefinition[] = [
  {
    id: "cold-start-role-package",
    label: "冷启动岗位包",
    description: "明确岗位、确认说明，再深度研究并生成图谱",
    scope: "project_creation",
    execution: "durable_job",
    disclosure: "metadata_first",
  },
  {
    id: "snapshot-iteration",
    label: "迭代岗位包",
    description: "自动发现、补研、修复并生成新版本",
    scope: "snapshot",
    execution: "durable_job",
    disclosure: "metadata_first",
    defaultProfile: "co_guided",
  },
  {
    id: "node-deepening",
    label: "深化选中节点",
    description: "围绕节点补充证据、关系与可展开结构",
    scope: "snapshot",
    execution: "durable_job",
    disclosure: "metadata_first",
    defaultProfile: "user_directed",
  },
  {
    id: "workspace-instantiation",
    label: "接入真实工作区",
    description: "提取工作事件与交付物，校准岗位包",
    scope: "snapshot",
    execution: "durable_job",
    disclosure: "metadata_first",
  },
];

export const workspaceSkillDefinitions = roleSkillDefinitions.filter(
  (skill): skill is RoleSkillDefinition & { id: WorkspaceSkillId; scope: "snapshot" } => skill.scope === "snapshot",
);

export function isWorkspaceSkillId(value: string | null): value is WorkspaceSkillId {
  return workspaceSkillDefinitions.some((skill) => skill.id === value);
}

export function getWorkspaceSkillDefinition(skillId: WorkspaceSkillId) {
  return workspaceSkillDefinitions.find((skill) => skill.id === skillId)!;
}

export function workspaceSkillHref(skillId: WorkspaceSkillId, context: WorkspaceSkillContext) {
  if (!context.snapshotId) return "#";
  const definition = getWorkspaceSkillDefinition(skillId);
  const params = new URLSearchParams({ profile: definition.defaultProfile || "co_guided" });
  if (context.projectId) params.set("project", context.projectId);
  if (context.versionId) params.set("version", context.versionId);
  if (context.projectId && context.conversationId) params.set("conversation", context.conversationId);

  if (skillId === "node-deepening") {
    params.set("prompt", "围绕选中节点深化证据、任务关系、能力结构与学习依赖");
    const targetIds = (context.selectedNodeIds || []).filter(Boolean).slice(0, 12);
    if (targetIds.length) params.set("targets", targetIds.join(","));
  }

  const pathname = skillId === "workspace-instantiation" ? "workspace" : "iterate";
  return `/snapshots/${encodeURIComponent(context.snapshotId)}/${pathname}?${params.toString()}`;
}

/** Apply an async conversation update without replacing neighboring conversations. */
export function updateConversationValue<T>(values: Record<string, T>, conversationId: string, initial: T, update: T | ((value: T) => T)): Record<string, T> {
  const previous = values[conversationId] ?? initial;
  return { ...values, [conversationId]: typeof update === "function" ? (update as (value: T) => T)(previous) : update };
}
