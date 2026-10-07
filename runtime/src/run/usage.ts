import {extractUsage} from "../review/usage.js";
import {recordUsage} from "./budget.js";
import {sha256} from "../fs/hash.js";
import type {ReviewReportArtifact} from "../review/attestation.js";
import {readReviewReportArtifact, REVIEW_ATTESTATION_DIRECTORY} from "../review/attestation.js";
import {readdir} from "node:fs/promises";
import {join} from "node:path";
import type {NativeGoalEvent} from "./hosts/types.js";
import type {RunRepository, RunState} from "./service.js";
import type {UsageHighWater} from "./types.js";
const plain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const count = (v: unknown): number | null => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;

function appendUsage(current: RunState, incoming: UsageHighWater): RunState {
  const usage = recordUsage(current.usage ?? [], incoming);
  const total = (key: "totalTokens" | "costUsd") => usage.some(u => u[key] !== null)
    ? usage.reduce((sum, u) => sum + (u[key] ?? 0), 0) : null;
  return {...current, usage, budget: {...current.budget, usage: {...current.budget.usage,
    tokens: total("totalTokens"), usd: total("costUsd"), completeness: "partial", source: "native-and-review-epoch-ledger",
    highWaterMark: total("totalTokens") ?? 0}}};
}

/** Copies of a tree report charge each fresh reviewer session only once. */
export async function recordReviewRunUsage(repository: RunRepository, runId: string, report: ReviewReportArtifact): Promise<void> {
  for (const attempt of Array.isArray(report.attempts) ? report.attempts : []) {
    if (typeof attempt.sessionId !== "string" || !plain(attempt.metrics?.usage)) continue;
    const value = attempt.metrics.usage;
    await repository.mutate(runId, current => appendUsage(current, {source: "review",
      epoch: sha256(attempt.target + ":" + attempt.sessionId), observedAt: report.createdAt,
      inputTokens: value.inputTokens ?? null, outputTokens: value.outputTokens ?? null,
      totalTokens: value.totalTokens ?? null, costUsd: value.costUsd ?? null, completeness: "partial"}));
  }
}

export async function recordSavedReviewRunUsage(repository: RunRepository, runId: string, root: string): Promise<void> {
  const state = await repository.read(runId);
  if (state === null) return;
  let names: string[];
  try {names = await readdir(join(root, REVIEW_ATTESTATION_DIRECTORY));}
  catch (cause) {if ((cause as NodeJS.ErrnoException).code === "ENOENT") return; throw cause;}
  for (const name of names.filter(name => /^[a-f0-9]{64}\.[a-z][a-z0-9-]{0,127}\.reports\.json$/u.test(name))) {
    const fingerprint = name.slice(0, 64);
    const taskId = name.slice(65, -".reports.json".length);
    const artifact = await readReviewReportArtifact(root, fingerprint, taskId);
    if (artifact !== null && artifact.goalHash === state.goalHash && Date.parse(artifact.createdAt) >= Date.parse(state.createdAt))
      await recordReviewRunUsage(repository, runId, artifact);
  }
}

/** Only explicit native counters are consumed. Unknown cost never becomes zero. */
export async function recordNativeRunUsage(repository: RunRepository, event: NativeGoalEvent): Promise<void> {
  if (!plain(event.payload)) return;
  const state = await repository.read(event.runId);
  const worker = state?.workers.find(w => w.workerId === event.workerId);
  if (state === null || state === undefined || worker === undefined || worker.generation !== event.generation || worker.nativeSessionId === null) return;
  let incoming: UsageHighWater | undefined;
  const payload = plain(event.payload.params) ? event.payload.params : event.payload;
  if (event.host === "claude" && event.payload.type === "result" && typeof event.payload.uuid === "string") {
    const usage = extractUsage("claude", JSON.stringify(event.payload), "");
    if (usage !== undefined) incoming = {source: "claude", epoch: `${worker.workerId}:${worker.nativeSessionId}:${event.payload.uuid}`,
      inputTokens: usage.inputTokens ?? null, outputTokens: usage.outputTokens ?? null, totalTokens: usage.totalTokens ?? null,
      costUsd: usage.costUsd ?? null, completeness: "partial", observedAt: event.at};
  } else if (event.host === "codex" && plain(payload.tokenUsage) && plain(payload.tokenUsage.total)) {
    const usage = payload.tokenUsage.total;
    incoming = {source: "codex", epoch: `${worker.workerId}:${worker.nativeSessionId}:thread`, inputTokens: count(usage.inputTokens),
      outputTokens: count(usage.outputTokens), totalTokens: count(usage.totalTokens), costUsd: null,
      completeness: "partial", observedAt: event.at};
  }
  if (incoming === undefined) return;
  await repository.mutate(event.runId, current => {
    const saved = current.workers.find(w => w.workerId === event.workerId);
    if (saved?.generation !== event.generation || saved.nativeSessionId !== worker.nativeSessionId) return current;
    return appendUsage(current, incoming!);
  });
}
