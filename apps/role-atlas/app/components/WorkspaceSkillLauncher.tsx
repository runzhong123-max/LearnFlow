import { ArrowUpRight, Focus, FolderKanban, RefreshCw, Sparkles } from "lucide-react";
import Link from "next/link";
import {
  roleSkillDefinitions,
  workspaceSkillHref,
  type WorkspaceSkillContext,
  type RoleSkillId,
} from "@/lib/skills/workspace";

const skillIcons: Record<RoleSkillId, typeof RefreshCw> = {
  "cold-start-role-package": Sparkles,
  "snapshot-iteration": RefreshCw,
  "node-deepening": Focus,
  "workspace-instantiation": FolderKanban,
};

export default function WorkspaceSkillLauncher({
  context,
  onLaunch,
}: {
  context: WorkspaceSkillContext;
  onLaunch?: (skillId: RoleSkillId) => void;
}) {
  return (
    <nav className="chat-skill-launcher" aria-label="对话工具">
      {roleSkillDefinitions.map((skill) => {
        const Icon = skillIcons[skill.id];
        const available = Boolean(context.projectId) && (skill.id === "cold-start-role-package" ? !context.snapshotId : Boolean(context.snapshotId) && (skill.id !== "node-deepening" || Boolean(context.selectedNodeIds?.length)));
        const className = `chat-skill-card ${skill.id}${available ? "" : " disabled"}`;
        const content = <>
          <i><Icon size={14} /></i>
          <span>
            <b>{skill.label}</b>
            <small>{skill.description}</small>
          </span>
          <ArrowUpRight size={12} />
        </>;
        return onLaunch ? (
          <button
            type="button"
            className={className}
            data-testid={`workspace-skill-${skill.id}`}
            disabled={!available}
            onClick={() => onLaunch(skill.id)}
            key={skill.id}
            aria-label={`在当前对话启动${skill.label}技能`}
          >
            {content}
          </button>
        ) : (
          <Link
            className={className}
            data-testid={`workspace-skill-${skill.id}`}
            href={skill.id === "cold-start-role-package" ? "/projects/new" : workspaceSkillHref(skill.id, context)}
            aria-disabled={!available}
            onClick={(event) => { if (!available) event.preventDefault(); }}
            key={skill.id}
            aria-label={`启动${skill.label}技能`}
          >
            {content}
          </Link>
        );
      })}
    </nav>
  );
}
