"use client";

/**
 * The LearnFlow account row, mirrored for Role Atlas.
 *
 * LearnFlow renders the learner as one circle avatar plus a "@handle · state"
 * line (packages/learning-client/src/identity/UserIdentity.tsx). Role Atlas runs
 * on its own React and dependency tree, so it reproduces that markup and its
 * classes instead of importing the shared component; the CSS lives in
 * app/globals.css next to the rest of the design tokens.
 */
export type RoleAtlasIdentity = {
  displayName: string;
  username: string;
  role: "user" | "admin";
};

export function userInitial(displayName: string) {
  const first = Array.from(displayName.trim())[0] || "";
  return /[a-z]/i.test(first) ? first.toUpperCase() : first;
}

export function UserIdentity({ identity, detail, size = "md" }: {
  identity: RoleAtlasIdentity;
  detail?: string;
  size?: "sm" | "md" | "lg";
}) {
  const state = detail || (identity.role === "admin" ? "管理员" : "学习者");
  return (
    <div className="user-identity" title={`${identity.displayName} · @${identity.username}`}>
      <span className={`user-avatar user-avatar-${size}`} aria-hidden="true">{userInitial(identity.displayName)}</span>
      <span className="user-identity-copy">
        <strong>{identity.displayName}</strong>
        <small>@{identity.username} · {state}</small>
      </span>
    </div>
  );
}
