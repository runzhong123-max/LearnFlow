export type RoleJobKind = "cold_start" | "snapshot_iteration" | "node_deepening" | "workspace_instantiation";

export type RoleJobStatus = "queued" | "running" | "waiting_user" | "completed" | "failed" | "cancelled";

export type RoleJobDescriptor = {
  id: string;
  kind: RoleJobKind;
  threadId: string;
  projectId?: string;
  conversationId?: string;
  baseVersionId?: string;
  baseSnapshotId?: string;
  status: RoleJobStatus;
  phase: string;
  attempt: number;
  createdAt: string;
  updatedAt: string;
};

export type RoleJobCheckpoint<TState = unknown> = {
  jobId: string;
  kind: RoleJobKind;
  phase: string;
  attempt: number;
  state: TState;
  savedAt: string;
};

type JournalEvent = { runId: string; seq: number; time: string };

/**
 * An append-only journal shared by every long-running Skill.
 *
 * Normal progress stays responsive: it is sent to the client immediately and
 * persisted in-order in the background. Snapshot/version boundaries call
 * `commit`, which first drains earlier writes and only becomes visible after
 * the event is durable. This makes the UI stream and the recovery log describe
 * one execution instead of two loosely related timelines.
 */
export class DurableJobJournal<TEvent extends JournalEvent> {
  private persistence: Promise<void> = Promise.resolve();
  private persistenceError: unknown;

  constructor(
    private readonly persist: (event: TEvent) => Promise<void>,
    private readonly write: (event: TEvent) => void,
  ) {}

  publish(event: TEvent) {
    this.write(event);
    this.persistence = this.persistence.then(async () => {
      if (this.persistenceError) throw this.persistenceError;
      try {
        await this.persist(event);
      } catch (error) {
        this.persistenceError = error;
        throw error;
      }
    });
  }

  async commit(event: TEvent, afterPersist?: () => Promise<void>) {
    await this.flush();
    try {
      // Commit the domain change before publishing its completion into the replay log.
      // A failed domain write must never leave a durable successful completion.
      await afterPersist?.();
      await this.persist(event);
    } catch (error) {
      this.persistenceError = error;
      throw error;
    }
    this.write(event);
  }

  async flush() {
    await this.persistence;
    if (this.persistenceError) throw this.persistenceError;
  }
}

export function createDurableJobStream<TEvent extends JournalEvent>(input: {
  signal?: AbortSignal;
  execute: () => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>;
  persist: (event: TEvent) => Promise<void>;
  handle: (raw: unknown, journal: DurableJobJournal<TEvent>) => Promise<void> | void;
  onFailure: (error: unknown, journal: DurableJobJournal<TEvent>) => Promise<void> | void;
  onFinally?: () => Promise<void> | void;
  keepAlive?: (execution: Promise<void>) => void;
}) {
  const encoder = new TextEncoder();
  let connected = true;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      // NDJSON whitespace keeps intermediary/consumer idle timers alive during silent model calls.
      heartbeat = setInterval(() => {
        if (connected) try { controller.enqueue(encoder.encode("\n")); } catch { connected = false; }
      }, 10_000);
      const journal = new DurableJobJournal<TEvent>(
        input.persist,
        (event) => {
          if (!connected) return;
          try { controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`)); }
          catch { connected = false; }
        },
      );
      const execution = (async () => {
        try {
          const events = await input.execute();
          for await (const event of events) await input.handle(event, journal);
        } catch (error) {
          await journal.flush().catch(() => undefined);
          await input.onFailure(error, journal);
        } finally {
          clearInterval(heartbeat);
          await journal.flush().catch(() => undefined);
          await input.onFinally?.();
          if (connected) {
            try { controller.close(); }
            catch { connected = false; }
          }
        }
      })();
      input.keepAlive?.(execution);
      void execution;
    },
    cancel() {
      clearInterval(heartbeat);
      connected = false;
      // Detaching a view does not cancel its job. Explicit cancellation and lease loss
      // abort the independent execution signal owned by the server.
    },
  });
}

export function durableJobResponse(stream: ReadableStream<Uint8Array>) {
  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

/** Keeps a claimed stage alive while a model/tool call is producing no events. */
export function startRoleJobHeartbeat(input: {
  renew: () => Promise<boolean>;
  intervalMs?: number;
  onLeaseLost?: () => void;
}) {
  let stopped = false;
  let pending: Promise<void> = Promise.resolve();
  const pulse = () => {
    pending = pending.then(async () => {
      if (stopped) return;
      const held = await input.renew().catch(() => false);
      if (!held) input.onLeaseLost?.();
    });
  };
  const timer = setInterval(pulse, input.intervalMs || 15_000);
  return async () => {
    stopped = true;
    clearInterval(timer);
    await pending;
  };
}
