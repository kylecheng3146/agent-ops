import {execFileSync} from "node:child_process";
import {rm} from "node:fs/promises";
import {join} from "node:path";

import {sha256} from "../fs/hash.js";
import {AgentOpsError} from "../fs/paths.js";
import type {ReviewCheckpoint, ReviewCheckpointJournal} from "../review/execute.js";
import {readPrivateFile, writePrivateFile} from "../security/permissions.js";
import type {RunFinalProof, RunRepository, RunState} from "./service.js";

const MAX_CHECKPOINT_BYTES = 4 * 1024 * 1024;
const BINDING = /^[a-f0-9]{64}$/u;

/** One immutable final attempt: a new candidate, target, contract or policy starts a new allowance. */
export function finalProofAttemptKey(parts: {readonly candidate: string; readonly target: string;
  readonly contractHash: string | null; readonly configHash: string | null; readonly runtimeHash: string | null}): string {
  return sha256(JSON.stringify([parts.candidate, parts.target, parts.contractHash, parts.configHash, parts.runtimeHash]));
}

function checkpointDirectory(state: Pick<RunState, "commonDir" | "runId">): string {
  return join(state.commonDir, "agent-ops", "runs", state.runId, "final-review");
}

/** Saved rounds live beside the run state; `transient` marks the run's final-proof record. */
export function runReviewCheckpoints(repository: RunRepository, state: Pick<RunState, "commonDir" | "runId">): ReviewCheckpointJournal {
  const path = (binding: string): string => {
    if (!BINDING.test(binding)) throw new AgentOpsError("RUN_REVIEW_CHECKPOINT_INVALID", "Checkpoint binding must be a sha256 digest.");
    return join(checkpointDirectory(state), binding + ".json");
  };
  return {
    async load(binding) {
      const source = await readPrivateFile(path(binding), state.commonDir);
      if (source === null) return null;
      const saved = Buffer.byteLength(source) > MAX_CHECKPOINT_BYTES ? null
        : JSON.parse(source) as {schemaVersion?: unknown; checkpoint?: ReviewCheckpoint | null; digest?: unknown} | null;
      if (saved === null || typeof saved !== "object" || saved.schemaVersion !== 1 || typeof saved.checkpoint !== "object" ||
        saved.checkpoint === null || saved.digest !== sha256(JSON.stringify(saved.checkpoint)))
        throw new AgentOpsError("RUN_REVIEW_CHECKPOINT_INVALID", "Saved review checkpoint is unreadable or altered.");
      return saved.checkpoint;
    },
    async save(checkpoint) {
      const content = JSON.stringify({schemaVersion: 1, checkpoint, digest: sha256(JSON.stringify(checkpoint))});
      if (Buffer.byteLength(content) > MAX_CHECKPOINT_BYTES)
        throw new AgentOpsError("RUN_REVIEW_CHECKPOINT_TOO_LARGE", "Review checkpoint exceeds 4 MiB.");
      await writePrivateFile(path(checkpoint.binding), content, state.commonDir);
    },
    async transient() {
      await repository.mutate(state.runId, current => current.finalProof == null ? current
        : {...current, finalProof: {...current.finalProof, reviewTransient: true}});
    }
  };
}

/** A delivered run keeps no resumable review rounds. */
export async function discardReviewCheckpoints(state: Pick<RunState, "commonDir" | "runId">): Promise<void> {
  await rm(checkpointDirectory(state), {recursive: true, force: true});
}

/** Starts a proof step for `attemptKey`. The same key keeps its spent allowance; restarts never refund it. */
export async function beginFinalProof(repository: RunRepository, runId: string, attemptKey: string): Promise<RunFinalProof> {
  const state = await repository.mutate(runId, current => ({...current, finalProof: current.finalProof?.attemptKey === attemptKey
    ? {...current.finalProof, pending: true, reviewTransient: false}
    : {attemptKey, recoveries: 0, pending: true, reviewTransient: false, failures: [], stopped: false}}));
  return state.finalProof!;
}

/**
 * Records a failed or interrupted proof step and decides under the run lock
 * whether the one automatic recovery is spent on it. Only an eligible failure
 * of the same attempt in an active run consumes it; anything else stops
 * automatic recovery for this attempt. The first failure is never overwritten.
 */
export async function settleFinalProofFailure(repository: RunRepository, runId: string, attemptKey: string,
  code: string, eligible: boolean): Promise<"replay" | "stop"> {
  let decision: "replay" | "stop" = "stop";
  await repository.mutate(runId, current => {
    const record = current.finalProof;
    if (record == null || record.attemptKey !== attemptKey) return current;
    const replay = eligible && record.recoveries === 0 && !record.stopped && current.status === "active" && !current.disableRestart;
    decision = replay ? "replay" : "stop";
    return {...current, finalProof: {...record, recoveries: replay ? 1 : record.recoveries, pending: replay, reviewTransient: false,
      stopped: !replay, failures: [...record.failures.slice(0, 1), {code: code.slice(0, 128), at: new Date().toISOString()}]}};
  });
  return decision;
}

/**
 * A controlled step that ended without a complete result. Replayable only when
 * no stop, deadline, limit or spawn failure ended it and nothing of its
 * process group is still running.
 */
export class InterruptedStepError extends AgentOpsError {
  constructor(message: string, readonly replayable: boolean) {
    super("RUN_FINAL_PROOF_INTERRUPTED", message);
  }
}

type StepResult = {status: string; code: string; data?: unknown};

export interface FinalProofSteps {
  readonly advance: () => Promise<StepResult>;
  /** The attempt key of the candidate as it is now. */
  readonly attemptKey: () => Promise<string>;
  /** Nothing outside the key moved either: clean coordinator checkout, no integration transaction. */
  readonly untouched: () => Promise<boolean>;
}

/**
 * Coordinator final proof with at most one automatic recovery per immutable
 * attempt. `restartedKey` resumes a proof a previous supervisor left pending;
 * the crash itself is the failure that may spend the allowance.
 */
export async function runFinalProof(repository: RunRepository, runId: string, steps: FinalProofSteps,
  restartedKey?: string): Promise<StepResult> {
  const key = restartedKey ?? await steps.attemptKey();
  const replay = async (code: string, replayable: boolean): Promise<boolean> => {
    let eligible = false;
    try {eligible = replayable && await steps.attemptKey() === key && await steps.untouched();}
    catch {eligible = false;}
    const replaying = await settleFinalProofFailure(repository, runId, key, code, eligible) === "replay";
    const latest = (await repository.read(runId))!;
    await repository.appendEvent(runId, {type: "diagnostic", code: replaying ? "RUN_FINAL_PROOF_RECOVERING" : "RUN_FINAL_PROOF_RECOVERY_STOPPED",
      workerId: latest.coordinatorId, taskId: latest.rootTaskId, detail: replaying
        ? `${code}: replaying final proof once with no writer started; a valid saved primary review and current verification are reused.`
        : `${code}: automatic recovery ${replayable ? "is spent or no longer applies to this candidate" : "does not apply to this failure"}; the checkout is preserved.`});
    return replaying;
  };
  if (restartedKey === undefined) await beginFinalProof(repository, runId, key);
  else if (!await replay("RUN_SUPERVISOR_RESTARTED", true))
    throw new AgentOpsError("RUN_FINAL_PROOF_INTERRUPTED", "Final proof was interrupted by a supervisor restart and cannot be replayed automatically.");
  for (;;) {
    let result: StepResult | undefined;
    let failure: unknown;
    try {
      result = await steps.advance();
      if (result.status === "ok") return result;
    } catch (cause) {failure = cause;}
    const replayable = failure === undefined ? (await repository.read(runId))!.finalProof?.reviewTransient === true
      : failure instanceof InterruptedStepError && failure.replayable;
    const code = failure instanceof AgentOpsError ? failure.code : result?.code ?? "RUN_FINAL_PROOF_FAILED";
    if (await replay(code, replayable)) continue;
    if (failure !== undefined) throw failure;
    return result!;
  }
}

/**
 * Whether any process still belongs to the group: a proof group can outlive
 * its leader. An unreadable process table counts as alive.
 */
export function processGroupAlive(group: number): boolean {
  try {
    return execFileSync("ps", ["-axo", "pgid="], {encoding: "utf8", stdio: ["ignore", "pipe", "ignore"]})
      .split("\n").some(line => Number(line.trim()) === group);
  } catch {return true;}
}
