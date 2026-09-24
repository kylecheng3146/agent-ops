import { lstat, readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import type { AgentOpsConfig } from "../contracts.js";
import { sha256 } from "../fs/hash.js";
import { AgentOpsError } from "../fs/paths.js";
import {
  readPrivateFile,
  withPrivateFileLock,
  writePrivateFile
} from "../security/permissions.js";
import type { TaskService } from "../task/service.js";
import { checkTaskCompletionEvidence, findIncompleteSubtask } from "../task/completion.js";
import type { FileEvidenceStore } from "../verify/evidence.js";
import {
  collectBaseChangePaths,
  collectChangeSurface,
  type GitRunner
} from "../verify/change-surface.js";
import { calculateSourceFingerprint } from "../verify/source-fingerprint.js";
import type { HookResult, NormalizedHookEvent } from "./events.js";
import { readWorktreeRecord } from "../parallel/service.js";

const FINGERPRINT = /^[a-f0-9]{64}$/u;
const SESSION = /^[^\0\r\n]{1,256}$/u;

export interface CompletionGateState {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly baselineFingerprint: string;
  readonly permitFingerprint: string | null;
  /**
   * The Git worktree this session actually works in, when it is not this
   * checkout. A host that cannot move a session (agy) keeps reporting the
   * checkout it started in; the gate follows this pointer instead.
   */
  readonly root?: string;
}

function gateDirectory(root: string): string {
  return join(root, ".agent-ops", "tasks", "completion-gate");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
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
  return join(gateDirectory(root), `${sha256(sessionId)}.json`);
}

function validRoot(value: unknown): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 &&
    !value.includes("\0") && isAbsolute(value);
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
  const keys = Object.keys(record).filter((key) => key !== "root").sort().join(",");
  if (
    keys !== "baselineFingerprint,permitFingerprint,schemaVersion,sessionId" ||
    ("root" in record && !validRoot(record.root)) ||
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

  /** Every recorded session. An unreadable record is skipped, not repaired. */
  async all(): Promise<readonly CompletionGateState[]> {
    let names: string[];
    try {
      names = await readdir(gateDirectory(this.#root));
    } catch {
      return [];
    }
    const states: CompletionGateState[] = [];
    for (const name of names.filter((entry) => /^[a-f0-9]{64}\.json$/u.test(entry))) {
      try {
        const source = await readPrivateFile(join(gateDirectory(this.#root), name), this.#root);
        const record = source === null ? null : JSON.parse(source) as { sessionId?: unknown };
        if (typeof record?.sessionId === "string") {
          const state = await this.read(record.sessionId);
          if (state !== null) states.push(state);
        }
      } catch {
        continue;
      }
    }
    return states;
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
  /** The gate of the worktree a redirected session works in. */
  readonly forRoot?: (root: string) => Promise<CompletionGateService>;
}

/** What the gate measures: the whole Git-visible change surface of `root`. */
export async function currentGateFingerprint(
  root: string,
  gitRunner: GitRunner
): Promise<string> {
  const surface = await collectChangeSurface(gitRunner);
  return await calculateSourceFingerprint(
    root,
    { mode: "worktree", changedFiles: surface.paths },
    gitRunner
  );
}

export class CompletionGateService {
  readonly #options: CompletionGateServiceOptions;
  readonly #store: FileCompletionGateStore;

  constructor(options: CompletionGateServiceOptions) {
    this.#options = options;
    this.#store = options.stateStore ?? new FileCompletionGateStore(options.root);
  }

  async #fingerprint(): Promise<string> {
    return await currentGateFingerprint(this.#options.root, this.#options.gitRunner);
  }

  /**
   * Starts (or restarts) a session's record at a known baseline: the current
   * source by default, or an explicit one a caller wants every Stop measured
   * against.
   */
  async seed(sessionId: string, baselineFingerprint?: string): Promise<void> {
    const baseline = baselineFingerprint ?? await this.#fingerprint();
    await this.#store.mutate(sessionId, () => ({
      schemaVersion: 1,
      sessionId,
      baselineFingerprint: baseline,
      permitFingerprint: null
    }));
  }

  /** Points this checkout's record for a session at another worktree, or clears it. */
  async redirect(sessionId: string, root: string | null): Promise<void> {
    if (root === null && (await this.#store.read(sessionId))?.root === undefined) {
      return;
    }
    const fingerprint = await this.#fingerprint();
    await this.#store.mutate(sessionId, (current) => {
      const { root: _previous, ...base } = current ?? {
        schemaVersion: 1 as const,
        sessionId,
        baselineFingerprint: fingerprint,
        permitFingerprint: null
      };
      return root === null ? base : { ...base, root };
    });
  }

  /**
   * Moves every session whose baseline is `from` to `to`: a merge that moved
   * HEAD under a session which changed nothing must not read as its change.
   */
  async rebase(from: string, to: string): Promise<number> {
    let moved = 0;
    for (const state of await this.#store.all()) {
      if (state.baselineFingerprint !== from) continue;
      await this.#store.mutate(state.sessionId, (current) =>
        current === null || current.baselineFingerprint !== from
          ? current ?? state
          : { ...current, baselineFingerprint: to });
      moved += 1;
    }
    return moved;
  }

  async sessions(): Promise<readonly CompletionGateState[]> {
    return await this.#store.all();
  }

  /**
   * Whether the session's attached task would let it stop right now: complete,
   * with current evidence and review. Null means it would.
   */
  async validate(sessionId: string): Promise<HookResult | null> {
    return await this.#validateTask(sessionId);
  }

  /**
   * The fingerprint the task's evidence should carry. Committed work leaves an
   * empty worktree surface: there is nothing left to measure there, and the
   * evidence names the `--base` range `task complete` was given instead. That
   * range is recomputed here rather than trusted, so evidence for a range that
   * no longer ends at HEAD still fails.
   */
  async #evidenceFingerprint(completionBase: string | null): Promise<string> {
    const worktree = await this.#fingerprint();
    if (completionBase === null) {
      return worktree;
    }
    const surface = await collectChangeSurface(this.#options.gitRunner);
    if (surface.paths.length > 0) {
      return worktree;
    }
    try {
      const changedFiles = await collectBaseChangePaths(
        this.#options.gitRunner,
        completionBase
      );
      if (changedFiles.length === 0) {
        return worktree;
      }
      return await calculateSourceFingerprint(
        this.#options.root,
        {
          mode: "base",
          baseRef: completionBase,
          resolvedBase: completionBase,
          changedFiles
        },
        this.#options.gitRunner
      );
    } catch {
      return worktree;
    }
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
    if (
      !changed &&
      this.#options.config.worktree?.mode === "auto" &&
      state.root === undefined &&
      await readWorktreeRecord(this.#options.root) === null
    ) {
      return gateResult(
        "continue",
        "UNKNOWN",
        "COMPLETION_GATE_WORKTREE_MODE",
        `worktree.mode is auto. Session: ${sessionId}. Before your first edit run agent-ops task create from this checkout, which creates this session's worktree and puts the task there (or agent-ops worktree add <name> --session ${shellQuote(sessionId)}), and work only inside the printed path. Verify and review there, then finish with agent-ops worktree finish from this checkout, which completes the tasks; do not run task complete in the worktree.`
      );
    }
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

  #isPermitCommand(event: NormalizedHookEvent): boolean {
    const commands = event.event === "command" ? [event] :
      event.event === "command-batch" ? event.commands : [];
    return commands.some(({ command, args }) => [command, ...args].includes("allow-stop"));
  }

  async #validateTask(sessionId: string): Promise<HookResult | null> {
    let stored;
    try {
      stored = await this.#options.taskService.status({ sessionId });
    } catch (error) {
      return error instanceof AgentOpsError && error.code === "TASK_SESSION_UNATTACHED"
        ? gateResult(
          "block",
          "FAIL",
          "COMPLETION_GATE_TASK_REQUIRED",
          `Attach this conversation to a formal task: agent-ops task create --title <title> --criterion <json> --criterion <json> (two to five criteria), then agent-ops task attach --task <task-id> --session ${shellQuote(sessionId)}.`
        )
        : gateResult("block", "UNKNOWN", "COMPLETION_GATE_TASK_UNAVAILABLE", "Repair task state with agent-ops doctor before stopping.");
    }
    if (stored.status !== "complete") {
      return gateResult("block", "FAIL", "COMPLETION_GATE_TASK_INCOMPLETE", "Complete the attached task after verification and review.");
    }
    const unfinished = findIncompleteSubtask(await this.#options.taskService.list(), stored.task.id);
    if (unfinished !== undefined) {
      return gateResult("block", "FAIL", "COMPLETION_GATE_SUBTASK_INCOMPLETE", `Complete subtask ${unfinished.task.id} before its parent.`);
    }
    const sourceFingerprint = await this.#evidenceFingerprint(stored.completionBase);
    const problem = await checkTaskCompletionEvidence(stored, {
      ...this.#options,
      sourceFingerprint
    });
    if (problem !== null) {
      return gateResult("block", problem.status, `COMPLETION_GATE_${problem.code}`, problem.remedy);
    }
    return null;
  }

  /** `agent-ops worktree remove --force`: discards work that exists nowhere else. */
  #isForcedRemove(event: NormalizedHookEvent): boolean {
    const commands = event.event === "command" ? [event] :
      event.event === "command-batch" ? event.commands : [];
    return commands.some(({ command, args }) => {
      const words = [command, ...args];
      return words.includes("worktree") && words.includes("remove") && words.includes("--force");
    });
  }

  async handle(event: NormalizedHookEvent): Promise<HookResult | null> {
    if (this.#isForcedRemove(event)) {
      return gateResult("block", "UNKNOWN", "WORKTREE_REMOVE_CONFIRMATION", "Allow this only if the user wants the worktree's uncommitted or unmerged work discarded.");
    }
    if (this.#isPermitCommand(event)) {
      return gateResult("block", "UNKNOWN", "COMPLETION_GATE_PERMIT_CONFIRMATION", "Allow this command only to grant one Stop for the current source fingerprint.");
    }
    const sessionId = event.sessionId;
    if (sessionId === undefined) {
      return event.event === "stop"
        ? gateResult("block", "UNKNOWN", "COMPLETION_GATE_SESSION_REQUIRED", "The host did not provide a session identifier; run doctor and use a one-time permit only after restoring hook input.")
        : null;
    }
    if (event.event === "session-start") {
      return await this.initialize(sessionId);
    }
    if (event.event !== "stop") return null;
    if (event.terminationReason === undefined ||
      (event.terminationReason === "model_stop" && event.fullyIdle === undefined)) {
      return gateResult("block", "UNKNOWN", "COMPLETION_GATE_STOP_INPUT_INVALID", "Restore the Stop termination reason and fullyIdle metadata before stopping.");
    }
    if (event.terminationReason !== "model_stop" || event.fullyIdle !== true) {
      return gateResult("continue", "PASS", "COMPLETION_GATE_NON_FINAL_STOP");
    }

    const fingerprint = await this.#fingerprint();
    const state = await this.#store.read(sessionId);
    if (state === null) {
      return gateResult("block", "UNKNOWN", "COMPLETION_GATE_NOT_INITIALIZED", "The session baseline is unavailable; continue once so PreInvocation can initialize it.");
    }
    const changed = state.baselineFingerprint !== fingerprint && state.permitFingerprint !== fingerprint;
    if (state.root !== undefined && state.root !== this.#options.root) {
      // This checkout only has to stay untouched; the work, its task and its
      // evidence live in the worktree, and that gate decides.
      if (changed) {
        return gateResult("block", "FAIL", "COMPLETION_GATE_MAIN_CHANGED",
          `This session works in ${state.root}, but this checkout changed too. Move those edits into the worktree, or ask the user for a one-time permit.`);
      }
      if (!await isDirectory(state.root) || this.#options.forRoot === undefined) {
        return gateResult("block", "UNKNOWN", "COMPLETION_GATE_WORKTREE_MISSING",
          `The worktree ${state.root} is unavailable. Run agent-ops worktree list, then resume or remove it.`);
      }
      return await (await this.#options.forRoot(state.root)).handle(event);
    }
    if (changed) {
      const failure = await this.#validateTask(sessionId);
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
