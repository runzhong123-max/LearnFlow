/** Add this predicate to the new build job INSERT in the same D1 batch as admission.
 * Call ensureIntakeSchema before using it. Existing immutable dispatches do not need a new confirmation.
 */
export function intakeBuildGuard(input: {
  projectId: string; conversationId: string; revisionId: string; contentHash: string; runId: string; subjectId: string;
}) {
  return {
    sql: `EXISTS (SELECT 1 FROM role_intakes intake JOIN role_intake_revisions revision ON revision.id=intake.confirmed_revision_id
      JOIN projects intake_project ON intake_project.id=intake.project_id
      WHERE intake.project_id=? AND intake.conversation_id=? AND intake.head_revision_id=revision.id AND intake.pending_revision_id IS NULL
        AND revision.id=? AND revision.content_hash=? AND revision.build_run_id=? AND revision.confirmed_by=? AND revision.state='ready'
        AND revision.project_id=intake.project_id AND revision.conversation_id=intake.conversation_id
        AND intake_project.owner_subject_id=revision.confirmed_by AND intake_project.deleted_at IS NULL)`,
    bindings: [input.projectId, input.conversationId, input.revisionId, input.contentHash, input.runId, input.subjectId],
  };
}
