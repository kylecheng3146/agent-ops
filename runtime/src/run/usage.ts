import {extractUsage} from "../review/usage.js";
import {recordUsage} from "./budget.js";
import type {NativeGoalEvent} from "./hosts/types.js";
import type {RunRepository} from "./service.js";
import type {UsageHighWater} from "./types.js";
const plain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const count = (v: unknown): number | null => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;

/** Only explicit native counters are consumed. Unknown cost never becomes zero. */
export async function recordNativeRunUsage(repository: RunRepository, event: NativeGoalEvent): Promise<void> {
  if (!plain(event.payload)) return;
  const state = await repository.read(event.runId);
  const worker = state?.workers.find(w => w.workerId === event.workerId);
  if (state === null || state === undefined || worker === undefined || worker.generation !== event.generation || worker.nativeSessionId === null) return;
  let incoming: UsageHighWater | undefined;
  if (event.host === "claude" && event.payload.type === "result" && typeof event.payload.uuid === "string") {
    const usage = extractUsage("claude", JSON.stringify(event.payload), "");
    if (usage !== undefined) incoming = {source: "claude", epoch: `${worker.workerId}:${worker.nativeSessionId}:${event.payload.uuid}`,
      inputTokens: usage.inputTokens ?? null, outputTokens: usage.outputTokens ?? null, totalTokens: usage.totalTokens ?? null,
      costUsd: usage.costUsd ?? null, completeness: "partial", observedAt: event.at};
  } else if (event.host === "codex" && plain(event.payload.params) && plain(event.payload.params.tokenUsage) && plain(event.payload.params.tokenUsage.total)) {
    const usage = event.payload.params.tokenUsage.total;
    incoming = {source: "codex", epoch: `${worker.workerId}:${worker.nativeSessionId}:thread`, inputTokens: count(usage.inputTokens),
      outputTokens: count(usage.outputTokens), totalTokens: count(usage.totalTokens), costUsd: null,
      completeness: "partial", observedAt: event.at};
  }
  if (incoming === undefined) return;
  await repository.mutate(event.runId, current => {
    const saved = current.workers.find(w => w.workerId === event.workerId);
    if (saved?.generation !== event.generation || saved.nativeSessionId !== worker.nativeSessionId) return current;
    const usage = recordUsage(current.usage ?? [], incoming!);
    const total = (key: "totalTokens" | "costUsd") => usage.some(u => u[key] !== null)
      ? usage.reduce((sum, u) => sum + (u[key] ?? 0), 0) : null;
    return {...current, usage, budget: {...current.budget, usage: {...current.budget.usage,
      tokens: total("totalTokens"), usd: total("costUsd"), completeness: "partial", source: "native-epoch-ledger",
      highWaterMark: total("totalTokens") ?? 0}}};
  });
}
