import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ReviewTargetId } from "../../../runtime/src/contracts.js";
import { sha256 } from "../../../runtime/src/fs/hash.js";
import { AgentOpsError } from "../../../runtime/src/fs/paths.js";
import { qaAuthorHost } from "../../../runtime/src/qa/author.js";
import { runQaDelivery, type QaDeliveryResult } from "../../../runtime/src/qa/delivery.js";
import { qaCommonDirectory, type QaDeliveryScope } from "../../../runtime/src/qa/gate.js";
import { FileQaStore } from "../../../runtime/src/qa/store.js";
import { readCriteriaReview, type CriteriaReviewView } from "../../../runtime/src/review/criteria.js";
import { resolveReviewScope } from "../../../runtime/src/review/scope.js";
import { FileTaskStore } from "../../../runtime/src/task/store.js";
import { resolveGitCommit } from "../../../runtime/src/verify/change-surface.js";
import { FileEvidenceStore } from "../../../runtime/src/verify/evidence.js";
import { calculateSourceFingerprint } from "../../../runtime/src/verify/source-fingerprint.js";
import { registeredRunProofRunner } from "../../../runtime/src/verify/spawn.js";
import { sessionIdFromEnvironment } from "../../../runtime/src/hooks/codex-loop.js";
import { loadEffectiveConfig, repositoryTrust, runPolicyContext } from "./context.js";
import { gitRunner } from "./parallel-deps.js";
import { CLI_VERSION } from "./version.js";

const HOSTS: readonly ReviewTargetId[] = ["agy", "claude", "codex"];
const host = (value: string | undefined): ReviewTargetId | null => HOSTS.find(h => h === value) ?? null;

export interface DeliveryQaInput {
  readonly root: string;
  readonly taskId: string;
  /** The same base verify, review and completion measure the candidate against. */
  readonly base?: string;
  readonly scope?: QaDeliveryScope;
  readonly planOnly?: boolean;
  readonly timing?: "early" | "late";
  readonly explicit?: boolean;
  readonly advisory?: CriteriaReviewView | null;
  readonly signal?: AbortSignal;
}

/**
 * Production QA for one integrated delivery, at a CLI or run boundary (TaskService stays model-free).
 * Returns null for an unenrolled task without loading config or spending anything.
 */
export async function runDeliveryQa(input: DeliveryQaInput): Promise<QaDeliveryResult | null> {
  const {root, taskId} = input;
  const state = await new FileTaskStore(join(root, ".agent-ops", "tasks", "state.json"), root).read();
  const record = state.tasks.find(r => r.task.id === taskId);
  if (record?.task.qa === undefined) return null;
  const config = (await loadEffectiveConfig(root, "project")).config;
  const runner = gitRunner(root);
  const role = config.reviewRoles?.find(r => r.role === "independent-review");
  const run = await runPolicyContext(root).catch(() => null);
  const implementationHost = host(run?.state.host) ?? host(process.env.AGENT_OPS_HOST);
  const fingerprint = async () => {
    try {
      return await calculateSourceFingerprint(root, await resolveReviewScope({root, runner, ...(input.base === undefined ? {} : {base: input.base})}), runner);
    } catch (error) {
      // A plan made before implementation has no change surface yet; it binds contracts, never a candidate's proof.
      if (input.planOnly && error instanceof AgentOpsError && error.code === "REVIEW_NO_CHANGE_SURFACE")
        return sha256(`qa-plan-candidate:${await resolveGitCommit(runner, "HEAD")}`);
      throw error;
    }
  };
  return await runQaDelivery({store: new FileQaStore(await qaCommonDirectory(root)), root, rootTaskId: taskId, records: state.tasks, config,
    trusted: await repositoryTrust(root, config, CLI_VERSION) === "TRUSTED", ...(input.scope === undefined ? {} : {scope: input.scope}),
    fingerprint, gitRunner: runner, processRunner: registeredRunProofRunner(), planningRunner: registeredRunProofRunner(),
    evidenceStore: new FileEvidenceStore(root, root), controllerId: `qa-controller-${randomUUID()}`,
    available: [...new Set(role?.targets ?? [])], implementationHost,
    implementationSessionId: run?.state.ownerSessionId ?? sessionIdFromEnvironment() ??
      state.sessions.find(s => s.taskId === taskId)?.sessionId ?? "unrecorded-implementation-session",
    advisory: input.advisory !== undefined ? input.advisory : await readCriteriaReview(root, record.task).catch(() => null), host: kind => qaAuthorHost(kind),
    ...(input.timing === undefined ? {} : {timing: input.timing}), ...(input.planOnly === undefined ? {} : {planOnly: input.planOnly}),
    ...(input.explicit === undefined ? {} : {explicit: input.explicit}), ...(input.signal === undefined ? {} : {signal: input.signal}),
    log: line => process.stderr.write(`${line}\n`)});
}
