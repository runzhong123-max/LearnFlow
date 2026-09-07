import { getRequestExecutionContext } from "vinext/shims/request-context";
import { renewRoleJobLease } from "./repository";
import { startRoleJobHeartbeat } from "./runtime";

const executions = new Map<string, AbortController>();

/** A browser stream is only a subscriber. Cancellation authority is the persisted job lease. */
export function startRoleJobExecution(jobId: string, owner: string) {
  const controller = new AbortController();
  executions.set(jobId, controller);
  // Capture the request context now, before execution leaves its async scope.
  const context = getRequestExecutionContext();
  const stopHeartbeat = startRoleJobHeartbeat({
    renew: () => renewRoleJobLease(jobId, owner),
    onLeaseLost: () => controller.abort(new DOMException("任务已取消或执行租约失效", "AbortError")),
  });
  return {
    signal: controller.signal,
    keepAlive: (execution: Promise<void>) => { context?.waitUntil(execution); },
    async stop() {
      await stopHeartbeat();
      if (executions.get(jobId) === controller) executions.delete(jobId);
    },
  };
}

export function abortLocalRoleJob(jobId: string) {
  executions.get(jobId)?.abort(new DOMException("用户已停止任务", "AbortError"));
}
