import { authorizeApiRequest } from "@/lib/access";
import { z } from "zod";
import { createRoleAgent } from "@/lib/agent/graph";
import type { AgentEvent, AgentRequest } from "@/lib/agent/events";
import { createModelInvoker } from "@/lib/agent/model";
import { resolveProviderConfig } from "@/lib/server-runtime-config";
import { workerRuntimeBindings } from "@/lib/worker-runtime-bindings";
import { bundledRoleSnapshot } from "@/lib/snapshots/bundled-role-adapter";
import { SnapshotRoleRuntime } from "@/lib/agent/snapshot-runtime";
import { getConversation, listMessages, saveAssistantFromEvents, saveMessage } from "@/lib/projects/repository";

export const runtime = "edge";

const referenceSchema = z.object({
  packageId: z.string().max(120),
  packageVersion: z.string().max(40),
  snapshotId: z.string().max(160),
  targetId: z.string().max(160),
  fieldPath: z.string().max(240).optional(),
  selectionHash: z.string().max(160).optional(),
});

const requestSchema = z.object({
  runId: z.string().min(4).max(100),
  sessionId: z.string().min(4).max(100),
  projectId: z.string().min(4).max(100).optional(),
  messageId: z.string().min(4).max(100).optional(),
  message: z.string().min(1).max(12_000),
  references: z.array(referenceSchema).max(12).default([]),
  history: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().max(8_000) })).max(20).default([]),
  providerConfig: z.unknown().optional(),
});

function failureEvent(request: Partial<AgentRequest>, error: unknown): AgentEvent {
  const message = error instanceof Error && /401|Incorrect API key|Authentication|auth/i.test(error.message)
    ? "模型供应商拒绝了凭据，请到设置页重新测试 API Key。"
    : error instanceof Error && /429|rate limit/i.test(error.message)
      ? "模型供应商正在限流，请稍后重试或切换模型。"
      : error instanceof Error && /timed out|timeout/i.test(error.message)
        ? "模型输出长时间没有新内容；本轮已保留收到的思考与正文，可以直接重试。"
      : error instanceof Error && error.name === "AbortError"
        ? "运行已取消。"
        : "智能体运行失败；岗位包没有被修改。";
  return {
    version: "1.1",
    runId: request.runId || "unknown",
    sessionId: request.sessionId || "unknown",
    seq: Number.MAX_SAFE_INTEGER,
    time: new Date().toISOString(),
    kind: "run.failed",
    payload: { message, retryable: !/凭据/.test(message) },
  };
}

export async function POST(request: Request) {
  const denied = await authorizeApiRequest(request);
  if (denied) return denied;
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 96_000) return Response.json({ ok: false, error: "请求体过大。" }, { status: 413 });

  let parsed: z.infer<typeof requestSchema>;
  try {
    parsed = requestSchema.parse(await request.json());
  } catch {
    return Response.json({ ok: false, error: "智能体请求或模型配置无效。" }, { status: 400 });
  }

  let providerConfig;
  try {
    providerConfig = resolveProviderConfig(parsed.providerConfig, workerRuntimeBindings());
  } catch (error) {
    const message = error instanceof Error && error.message === "SERVER_MODEL_NOT_CONFIGURED"
      ? "服务端尚未配置模型 API Key，请填写 .env.local 或在设置页保存会话级 Key。"
      : "模型配置无效。";
    return Response.json({ ok: false, error: message }, { status: 400 });
  }

  let projectConversation: Awaited<ReturnType<typeof getConversation>> = null;
  let storedHistory = parsed.history;
  if (parsed.projectId) {
    try {
      projectConversation = await getConversation(parsed.sessionId);
      if (!projectConversation || projectConversation.conversation.projectId !== parsed.projectId || !projectConversation.workspace.result) {
        return Response.json({ ok: false, error: "项目会话或岗位快照不存在。" }, { status: 404 });
      }
      const rows = await listMessages(parsed.sessionId);
      storedHistory = rows
        .filter((message) => message.status === "done")
        .slice(-20)
        .map((message) => ({ role: message.role, text: message.text.slice(0, 8_000) }));
      await saveMessage({
        id: `${parsed.messageId || parsed.runId}:user`,
        conversationId: parsed.sessionId,
        role: "user",
        text: parsed.message,
        references: parsed.references,
        status: "done",
      });
    } catch (error) {
      return Response.json({ ok: false, error: error instanceof Error ? error.message : "无法保存会话消息。" }, { status: 500 });
    }
  }

  const agentRequest: AgentRequest = {
    runId: parsed.runId,
    sessionId: parsed.sessionId,
    message: parsed.message,
    references: parsed.references,
    history: storedHistory,
  };
  const modelInvoker = createModelInvoker(providerConfig);
  const snapshot = projectConversation?.workspace.result || bundledRoleSnapshot();
  const roleRuntime = new SnapshotRoleRuntime(snapshot);
  const graph = createRoleAgent(modelInvoker, roleRuntime);
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      void (async () => {
        const persistedEvents: AgentEvent[] = [];
        const assistantMessageId = parsed.messageId || parsed.runId;
        try {
          const threadId = `${agentRequest.sessionId}:${roleRuntime.descriptor.snapshotId}`;
          const events = await graph.stream(
            { request: agentRequest },
            {
              configurable: { thread_id: threadId },
              streamMode: "custom",
              signal: request.signal,
            },
          );
          for await (const event of events) {
            const agentEvent = event as AgentEvent;
            persistedEvents.push(agentEvent);
            controller.enqueue(encoder.encode(`${JSON.stringify(agentEvent)}\n`));
          }
        } catch (error) {
          const event = failureEvent(agentRequest, error);
          persistedEvents.push(event);
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } finally {
          if (projectConversation) {
            try {
              await saveAssistantFromEvents({
                conversationId: parsed.sessionId,
                messageId: assistantMessageId,
                references: parsed.references,
                events: persistedEvents,
              });
            } catch {
              const event: AgentEvent = {
                version: "1.1",
                runId: agentRequest.runId,
                sessionId: agentRequest.sessionId,
                seq: Number.MAX_SAFE_INTEGER,
                time: new Date().toISOString(),
                kind: "run.failed",
                payload: {
                  message: "回答已经生成，但会话历史保存失败；请先复制本轮内容，然后重试。",
                  retryable: true,
                },
              };
              controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
            }
          }
          controller.close();
        }
      })();
    },
    cancel() {
      // request.signal is forwarded to LangGraph and the model client.
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
