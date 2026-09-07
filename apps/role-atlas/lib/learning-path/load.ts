import { learningPathGraphInputSchema, type LearningPathGraphInput } from "@/lib/build/types";

/** Shared by cold-start and iteration; an unreadable graph must not silently disappear. */
export async function readOfficialLearningPath(fetcher: typeof fetch, signal: AbortSignal): Promise<LearningPathGraphInput> {
  const response = await fetcher("/data/learnflow-learning-path.json", { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) });
  if (!response.ok) throw new Error("学习路径资料暂时无法读取，请重试；本轮尚未提交。");
  const parsed = learningPathGraphInputSchema.safeParse(await response.json());
  if (!parsed.success || !parsed.data) throw new Error("学习路径资料格式无效，本轮尚未提交。");
  signal.throwIfAborted();
  return parsed.data;
}
