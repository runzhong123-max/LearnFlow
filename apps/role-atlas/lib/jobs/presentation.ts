export function jobDisplayStatus(job: { status: string; resumable?: boolean; recovery?: { state: string; deliveries: number } }) {
  if (job.status === "running" && job.resumable) return job.recovery && ["ready", "active"].includes(job.recovery.state) && job.recovery.deliveries < 3 ? "recovering" : "interrupted";
  return job.status;
}
export function jobConnectionMessage(cause: unknown) {
  const message = cause instanceof Error ? cause.message : "";
  return /load failed|failed to fetch|networkerror|network request failed|fetch failed/i.test(message)
    ? "连接暂时中断，正在核对后台任务状态。已提交的任务不会因此取消。"
    : message || "连接暂时中断，请查看已保存的任务状态。";
}
