/** Presentation filters never delete audit events or renumber durable cursors. */
export function roleJobEventsQuery(progressOnly = false) {
  return `SELECT cursor,event_json FROM role_job_events WHERE job_id=? AND cursor>?
    ${progressOnly ? "AND instr(kind, 'reasoning.delta')=0" : ""}
    ORDER BY cursor LIMIT 200`;
}
