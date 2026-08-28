import { join } from "node:path";

import type { AgentOpsConfig, VerificationCommand } from "../contracts.js";
import { calculateConfigHash } from "../config/hash.js";
import { sha256 } from "../fs/hash.js";
import { AgentOpsError } from "../fs/paths.js";
import { findReviewAttestation } from "../review/attestation.js";
import { validateEvidence, validateTaskAgainstConfig } from "../schema/validate.js";
import {
  readPrivateFile,
  withPrivateFileLock,
  writePrivateFile
} from "../security/permissions.js";
import type { TaskService } from "../task/service.js";
import { isPassingVerificationEvidence, type FileEvidenceStore } from "../verify/evidence.js";
import { collectChangeSurface, type GitRunner } from "../verify/change-surface.js";
import { calculateSourceFingerprint } from "../verify/source-fingerprint.js";
import type { HookResult, NormalizedHookEvent } from "./events.js";

const FINGERPRINT = /^[a-f0-9]{64}$/u;
const SESSION = /^[^\0\r\n]{1,256}$/u;

interface CompletionGateState {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly baselineFingerprint: string;
  readonly permitFingerprint: string | null;
}

function gateResult(
  action: HookResult["action"],
  status: HookResult["status"],
  code: string,
  remedy?: string
): HookResult {
  return { action, status, code, ...(remedy === undefined ? {} : { remedy }) };
}

function statePath(root: string, sessionId: string): string {
  return join(
    root,
    ".agent-ops",
    "tasks",
    "completion-gate",
    `${sha256(sessionId)}.json`
  );
}

function parseState(source: string | null, sessionId: string): CompletionGateState | null {
  if (source === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    throw new AgentOpsError("COMPLETION_GATE_STATE_INVALID", "Completion-gate state is not valid JSON.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AgentOpsError("COMPLETION_GATE_STATE_INVALID", "Completion-gate state is invalid.");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !==
      "baselineFingerprint,permitFingerprint,schemaVersion,sessionId" ||
    record.schemaVersion !== 1 ||
    record.sessionId !== sessionId ||
    typeof record.baselineFingerprint !== "string" ||
    !FINGERPRINT.test(record.baselineFingerprint) ||
    (record.permitFingerprint !== null &&
      (typeof record.permitFingerprint !== "string" ||
        !FINGERPRINT.test(record.permitFingerprint)))
  ) {
    throw new AgentOpsError("COMPLETION_GATE_STATE_INVALID", "Completion-gate state is invalid.");
  }
  return record as unknown as CompletionGateState;
}

export class FileCompletionGateStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  async read(sessionId: string): Promise<CompletionGateState | null> {
    if (!SESSION.test(sessionId)) {
      throw new AgentOpsError("COMPLETION_GATE_SESSION_INVALID", "Completion gate requires a valid session identity.");
    }
    const path = statePath(this.#root, sessionId);
    return await withPrivateFileLock(path, this.#root, async () =>
      parseState(await readPrivateFile(path, this.#root), sessionId)
    );
  }

  async mutate(
    sessionId: string,
    action: (state: CompletionGateState | null) => CompletionGateState
  ): Promise<CompletionGateState> {
    if (!SESSION.test(sessionId)) {
      throw new AgentOpsError("COMPLETION_GATE_SESSION_INVALID", "Completion gate requires a valid session identity.");
    }
    const path = statePath(this.#root, sessionId);
    return await withPrivateFileLock(path, this.#root, async () => {
      const next = action(parseState(await readPrivateFile(path, this.#root), sessionId));
      parseState(JSON.stringify(next), sessionId);
      await writePrivateFile(path, `${JSON.stringify(next, null, 2)}\n`, this.#root);
      return next;
    });
  }
}

export interface CompletionGateServiceOptions {
  readonly root: string;
  readonly config: AgentOpsConfig;
  readonly gitRunner: GitRunner;
  readonly taskService: TaskService;
  readonly evidenceStore: FileEvidenceStore;
  readonly stateStore?: FileCompletionGateStore;
}

export class CompletionGateService {
  readonly #options: CompletionGateServiceOptions;
  readonly #store: FileCompletionGateStore;

  constructor(options: CompletionGateServiceOptions) {
    this.#options = options;
    this.#store = options.stateStore ?? new FileCompletionGateStore(options.root);
  }

  async #fingerprint(): Promise<string> {
    const surface = await collectChangeSurface(this.#options.gitRunner);
    return await calculateSourceFingerprint(
      this.#options.root,
      { mode: "worktree", changedFiles: surface.paths },
      this.#options.gitRunner
    );
  }

  async initialize(sessionId: string): Promise<HookResult> {
    const fingerprint = await this.#fingerprint();
    const state = await this.#store.mutate(sessionId, (current) => current ?? {
      schemaVersion: 1,
      sessionId,
      baselineFingerprint: fingerprint,
      permitFingerprint: null
    });
    const changed = state.baselineFingerprint !== fingerprint;
    return gateResult(
      "continue",
      changed ? "UNKNOWN" : "PASS",
      changed ? "COMPLETION_GATE_CHANGED" : "COMPLETION_GATE_READY",
      changed
        ? `Git-visible changes require an attached completed task, current PASS evidence, and a PASS review. Session: ${sessionId}. Create with --session ${sessionId}; one-time permit: agent-ops allow-stop --session ${sessionId}.`
        : undefined
    );
  }

  async grantPermit(sessionId: string): Promise<void> {
    const fingerprint = await this.#fingerprint();
    await this.#store.mutate(sessionId, (state) => {
      if (state === null) {
        throw new AgentOpsError("COMPLETION_GATE_NOT_INITIALIZED", "The session has no completion-gate baseline.");
      }
      return { ...state, permitFingerprint: fingerprint };
    });
  }

  #isPermitCommand(event: NormalizedHookEvent, sessionId: string): boolean {
    if (event.event !== "command") return false;
    const tokens = [event.command, ...event.args];
    const commandIndex = tokens.indexOf("allow-stop");
    return commandIndex >= 0 &&
      tokens[commandIndex + 1] === "--session" &&
      (tokens[commandIndex + 2] === sessionId ||
        tokens[commandIndex + 2] === "$AGENT_OPS_SESSION_ID");
  }

  async #hasCurrentEvidence(
    taskId: string,
    criterionId: string,
    command: VerificationCommand,
    references: readonly string[],
    configHash: string,
    sourceFingerprint: string
  ): Promise<boolean> {
    for (const reference of references) {
      if (reference.startsWith("review:")) continue;
      const validation = validateEvidence(await this.#options.evidenceStore.load(reference));
      if (!validation.ok) continue;
      const evidence = validation.value;
      if (
        evidence.taskId === taskId &&
        evidence.criterionId === criterionId &&
        evidence.commandId === command.id &&
        evidence.configHash === configHash &&
        evidence.sourceFingerprint === sourceFingerprint &&
        isPassingVerificationEvidence(command, evidence)
      ) {
        return true;
      }
    }
    return false;
  }

  async #validateTask(sessionId: string, sourceFingerprint: string): Promise<HookResult | null> {
    let stored;
    try {
      stored = await this.#options.taskService.status({ sessionId });
    } catch (error) {
      return error instanceof AgentOpsError && error.code === "TASK_SESSION_UNATTACHED"
        ? gateResult("block", "FAIL", "COMPLETION_GATE_TASK_REQUIRED", "Attach this conversation to a formal task.")
        : gateResult("block", "UNKNOWN", "COMPLETION_GATE_TASK_UNAVAILABLE", "Repair task state with agent-ops doctor before stopping.");
    }
    if (stored.status !== "complete") {
      return gateResult("block", "FAIL", "COMPLETION_GATE_TASK_INCOMPLETE", "Complete the attached task after verification and review.");
    }
    const taskValidation = validateTaskAgainstConfig(stored.task, this.#options.config);
    const configHash = calculateConfigHash(this.#options.config);
    if (!taskValidation.ok || stored.policyConfigHash !== configHash) {
      return gateResult("block", "FAIL", "COMPLETION_GATE_TASK_STALE", "Recreate or re-verify the task against the current config.");
    }
    for (const criterion of stored.task.criteria) {
      for (const commandId of criterion.verifierIds) {
        const command = this.#options.config.verification.commands.find(({ id }) => id === commandId);
        if (command === undefined) {
          return gateResult("block", "UNKNOWN", "COMPLETION_GATE_EVIDENCE_UNAVAILABLE", "Configured task evidence cannot be resolved.");
        }
        if (
          command.required &&
          !(await this.#hasCurrentEvidence(
            stored.task.id,
            criterion.id,
            command,
            stored.evidence[criterion.id] ?? [],
            configHash,
            sourceFingerprint
          ))
        ) {
          return gateResult("block", "FAIL", "COMPLETION_GATE_EVIDENCE_REQUIRED", "Run agent-ops verify and complete the task with current PASS evidence.");
        }
      }
    }
    const attestation = await findReviewAttestation(this.#options.root, sourceFingerprint);
    if (attestation === null || attestation.taskId !== stored.task.id) {
      return gateResult("block", "FAIL", "COMPLETION_GATE_REVIEW_REQUIRED", "Run agent-ops review --yes for the attached task and current source.");
    }
    return null;
  }

  async handle(event: NormalizedHookEvent): Promise<HookResult | null> {
    const sessionId = event.sessionId;
    if (sessionId === undefined) {
      return event.event === "stop"
        ? gateResult("block", "UNKNOWN", "COMPLETION_GATE_SESSION_REQUIRED", "Agy did not provide conversationId; run doctor and use a one-time permit only after restoring hook input.")
        : null;
    }
    if (event.event === "session-start") {
      return await this.initialize(sessionId);
    }
    if (this.#isPermitCommand(event, sessionId)) {
      return gateResult("block", "UNKNOWN", "COMPLETION_GATE_PERMIT_CONFIRMATION", "Allow this command only to grant one Stop for the current source fingerprint.");
    }
    if (event.event !== "stop") return null;
    if (event.terminationReason !== "model_stop" || event.fullyIdle !== true) {
      return gateResult("continue", "PASS", "COMPLETION_GATE_NON_FINAL_STOP");
    }

    const fingerprint = await this.#fingerprint();
    const state = await this.#store.read(sessionId);
    if (state === null) {
      return gateResult("block", "UNKNOWN", "COMPLETION_GATE_NOT_INITIALIZED", "The session baseline is unavailable; continue once so PreInvocation can initialize it.");
    }
    if (state.baselineFingerprint !== fingerprint && state.permitFingerprint !== fingerprint) {
      const failure = await this.#validateTask(sessionId, fingerprint);
      if (failure !== null) return failure;
    }
    await this.#store.mutate(sessionId, (current) => {
      if (current === null) {
        throw new AgentOpsError("COMPLETION_GATE_NOT_INITIALIZED", "The session baseline disappeared.");
      }
      return {
        ...current,
        baselineFingerprint: fingerprint,
        permitFingerprint: null
      };
    });
    return gateResult("continue", "PASS", "COMPLETION_GATE_ALLOWED");
  }
}
