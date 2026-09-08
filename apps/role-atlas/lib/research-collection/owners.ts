/** Display existing verified ownership; never infer a missing historical owner. */
export function ownerId(row: Record<string, unknown>): string {
 return typeof row.owner_subject_id === "string" ? row.owner_subject_id : "";
}
export function ownerName(row: Record<string, unknown>): string {
 const id=ownerId(row);
 if(!id)return "历史未归属";
 for(const value of [row.owner_name,row.owner_username]) {
  if(typeof value === "string" && value.trim() && value !== id)return value;
 }
 return "未记录名称";
}
export function matchesOwner(row: Record<string, unknown>, filter: string): boolean {
 return !filter || (filter === "unassigned" ? !ownerId(row) : ownerId(row) === filter);
}
