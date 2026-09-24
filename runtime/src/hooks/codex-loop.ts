import { execFile as execFileCallback } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { lstat, realpath } from "node:fs/promises";
import { promisify } from "node:util";

import { applyManagedBlock } from "../fs/managed-block.js";
import { evaluateGuardrail } from "../guardrails/evaluate.js";
import { appendLocalLog } from "../logging/local-log.js";
import {
  readPrivateFile,
  withPrivateFileLock,
  writePrivateFile
} from "../security/permissions.js";
import { redactSecrets } from "../security/redact.js";
import {
  DEFAULT_CHECKPOINT_BUDGET,
  renderTaskCheckpoint
} from "../task/render.js";
import { parseTaskStateSource } from "../task/store.js";
import { normalizeShellHookEvent } from "./shell.js";

const execFile = promisify(execFileCallback);

const MAX_CONTEXT_CHARS = 1_200;
const MAX_GIT_STATUS_CHARS = 4_096;
const DEFAULT_TELEMETRY_MAX_BYTES = 64 * 1024;
const LOOP_SNAPSHOT_ID = "loop-snapshot";
const LOOP_SESSION_ID = "loop-session";
/** Task state outranks the goal when both compete for the same ceiling. */
const MAX_CHECKPOINT_CHARS = DEFAULT_CHECKPOINT_BUDGET;
const MAX_GOAL_CHARS = 400;
const MIN_GOAL_CHARS = 40;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export const PROJECT_LOOP_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PreCompact",
  "PostCompact",
  "SubagentStart",
  "SubagentStop"
] as const;

export type ProjectLoopEvent = (typeof PROJECT_LOOP_EVENTS)[number];
export type ProjectLoopHarness = "claude" | "codex";

export interface ProjectLoopResult {
  readonly exitCode: 0 | 2;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ProjectLoopOptions {
  readonly harness: ProjectLoopHarness;
  readonly event: ProjectLoopEvent;
  readonly input: unknown;
  /** Fallback when the harness input does not name its current directory. */
  readonly root?: string;
  readonly now?: () => string;
  readonly gitStatus?: (root: string) => Promise<string>;
  readonly telemetryMaxBytes?: number;
}

interface LoopDecision {
  readonly blocked: boolean;
  readonly code: string;
  readonly denial: "command" | "none" | "secret";
  readonly outcome: "allowed" | "blocked" | "observed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, maximum = 64 * 1024): string | null {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    !value.includes("\0")
  )
    ? value
    : null;
}

function inputCwd(input: unknown): string | null {
  return isRecord(input) ? stringField(input.cwd, 4_096) : null;
}

function prompt(input: unknown): string | null {
  return isRecord(input) ? stringField(input.prompt) : null;
}

function bashCommand(input: unknown): string | null {
  if (
    !isRecord(input) ||
    input.tool_name !== "Bash" ||
    !isRecord(input.tool_input)
  ) {
    return null;
  }
  return stringField(input.tool_input.command, 16 * 1024);
}

function requestedSandboxPermission(input: unknown): string | null {
  return isRecord(input)
    ? stringField(input.sandbox_permissions, 128)
    : null;
}

function noOutput(): ProjectLoopResult {
  return { exitCode: 0, stdout: "", stderr: "" };
}

function secretDenial(
  harness: ProjectLoopHarness,
  event: ProjectLoopEvent
): ProjectLoopResult {
  const reason = "agent-ops blocked a suspected secret.";
  if (harness === "claude" && event === "UserPromptSubmit") {
    return {
      exitCode: 0,
      stdout: JSON.stringify({ decision: "block", reason }),
      stderr: ""
    };
  }
  if (harness === "claude" && event === "PreToolUse") {
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason
        }
      }),
      stderr: ""
    };
  }
  return { exitCode: 2, stdout: "", stderr: reason };
}

function commandDenial(
  harness: ProjectLoopHarness,
  event: ProjectLoopEvent,
  code: string
): ProjectLoopResult {
  const reason = "agent-ops blocked a dangerous command.";
  if (harness === "claude" && event === "PreToolUse") {
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason
        }
      }),
      stderr: ""
    };
  }
  return {
    exitCode: 2,
    stdout: "",
    stderr: `${reason} (${code})`
  };
}

function evaluatePrompt(input: unknown, scope: string): LoopDecision {
  const value = prompt(input);
  if (value === null) {
    return {
      blocked: false,
      outcome: "observed",
      code: "prompt-unavailable",
      denial: "none"
    };
  }
  const decision = evaluateGuardrail({ kind: "content", content: value, scope });
  return decision.action === "block"
    ? {
        blocked: true,
        outcome: "blocked",
        code: decision.ruleId,
        denial: "secret"
      }
    : {
        blocked: false,
        outcome: "allowed",
        code: "prompt-allowed",
        denial: "none"
      };
}

function evaluateBash(input: unknown, scope: string): LoopDecision {
  const rawCommand = bashCommand(input);
  if (rawCommand === null) {
    return {
      blocked: false,
      outcome: "observed",
      code: "command-unavailable",
      denial: "none"
    };
  }
  const secretDecision = evaluateGuardrail({
    kind: "content",
    content: rawCommand,
    scope
  });
  if (secretDecision.action === "block") {
    return {
      blocked: true,
      outcome: "blocked",
      code: secretDecision.ruleId,
      denial: "secret"
    };
  }
  const event = normalizeShellHookEvent(rawCommand, scope);
  const commands =
    event.event === "command"
      ? [{ command: event.command, args: event.args }]
      : event.event === "command-batch"
        ? event.commands
        : [];
  for (const command of commands) {
    const decision = evaluateGuardrail({
      kind: "command",
      command: command.command,
      args: command.args,
      scope
    });
    if (decision.action === "block") {
      return {
        blocked: true,
        outcome: "blocked",
        code: decision.ruleId,
        denial: "command"
      };
    }
  }
  return {
    blocked: false,
    outcome: commands.length === 0 ? "observed" : "allowed",
    code: commands.length === 0 ? "command-unavailable" : "command-allowed",
    denial: "none"
  };
}

function eventLogName(event: ProjectLoopEvent): import("../logging/local-log.js").LoopLogEvent["event"] {
  const names: Readonly<Record<ProjectLoopEvent, import("../logging/local-log.js").LoopLogEvent["event"]>> = {
    SessionStart: "session-start",
    UserPromptSubmit: "user-prompt-submit",
    PreToolUse: "pre-tool-use",
    PermissionRequest: "permission-request",
    PostToolUse: "post-tool-use",
    PreCompact: "pre-compact",
    PostCompact: "post-compact",
    SubagentStart: "subagent-start",
    SubagentStop: "subagent-stop"
  };
  return names[event];
}

function boundedContext(value: string): string {
  const normalized = value.replace(/\r\n/g, "\n").trim();
  return normalized.length <= MAX_CONTEXT_CHARS
    ? normalized
    : `${normalized.slice(0, MAX_CONTEXT_CHARS - 14)}\n[truncated]`;
}

/**
 * Task titles and criterion descriptions are ordinary user text, so they get
 * the same treatment as the goal file: secret-shaped content is dropped
 * rather than injected, and everything else is redacted.
 */
function safeStateContext(value: string, scope: string): string | undefined {
  const decision = evaluateGuardrail({ kind: "content", content: value, scope });
  return decision.action === "block" ? undefined : redactSecrets(value);
}

function safeGoalContext(source: string | null): string {
  if (source === null || source.trim().length === 0) {
    return "No project loop goal is recorded.";
  }
  const decision = evaluateGuardrail({
    kind: "content",
    content: source,
    scope: "loop-goal.md"
  });
  if (decision.action === "block") {
    return "The project loop goal contains sensitive-looking text and was omitted.";
  }
  return boundedContext(redactSecrets(source));
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

async function findLoopRoot(
  start: string,
  harness: ProjectLoopHarness
): Promise<string | null> {
  let current: string;
  try {
    current = await realpath(resolve(start));
    const status = await lstat(current);
    if (!status.isDirectory() || status.isSymbolicLink()) {
      return null;
    }
  } catch {
    return null;
  }
  while (true) {
    try {
      const harnessDirectory = await lstat(join(current, `.${harness}`));
      if (harnessDirectory.isDirectory() && !harnessDirectory.isSymbolicLink()) {
        return current;
      }
    } catch (error) {
      if (!isMissing(error)) {
        return null;
      }
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

async function resolveLoopRoot(
  input: unknown,
  fallback: string | undefined,
  harness: ProjectLoopHarness
): Promise<string | null> {
  const candidates = [inputCwd(input), fallback].filter(
    (value): value is string => value !== null && value !== undefined
  );
  for (const candidate of new Set(candidates)) {
    const root = await findLoopRoot(candidate, harness);
    if (root !== null) {
      return root;
    }
  }
  return null;
}

function loopPath(root: string, harness: ProjectLoopHarness, name: string): string {
  return join(root, `.${harness}`, name);
}

async function appendTelemetry(options: {
  readonly root: string;
  readonly harness: ProjectLoopHarness;
  readonly event: ProjectLoopEvent;
  readonly decision: LoopDecision;
  readonly now?: () => string;
  readonly maxBytes?: number;
}): Promise<void> {
  const telemetry = loopPath(options.root, options.harness, "loop-telemetry.jsonl");
  await appendLocalLog(
    telemetry,
    {
      type: "loop-event",
      event: eventLogName(options.event),
      outcome: options.decision.outcome,
      code: options.decision.code
    },
    {
      anchorDirectory: options.root,
      maxBytes: options.maxBytes ?? DEFAULT_TELEMETRY_MAX_BYTES,
      ...(options.now === undefined ? {} : { now: options.now() })
    }
  );
}

async function telemetryCount(
  root: string,
  harness: ProjectLoopHarness
): Promise<number> {
  const source = await readPrivateFile(
    loopPath(root, harness, "loop-telemetry.jsonl"),
    root
  );
  if (source === null || Buffer.byteLength(source) > DEFAULT_TELEMETRY_MAX_BYTES) {
    return 0;
  }
  let count = 0;
  for (const line of source.split("\n")) {
    if (line.length === 0) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isRecord(parsed) && parsed.type === "loop-event") {
        count += 1;
      }
    } catch {
      return 0;
    }
  }
  return count;
}

async function defaultGitStatus(root: string): Promise<string> {
  const result = await execFile("git", ["status", "--short", "--branch"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: MAX_GIT_STATUS_CHARS + 1,
    timeout: 2_000,
    windowsHide: true
  });
  return result.stdout;
}

function boundedSnapshot(status: string): string {
  const decision = evaluateGuardrail({
    kind: "content",
    content: status,
    scope: "git-status"
  });
  if (decision.action === "block") {
    return "Sensitive-looking Git status text was omitted.";
  }
  const redacted = redactSecrets(status).replace(/\r\n/g, "\n").trim();
  return redacted.length <= MAX_GIT_STATUS_CHARS
    ? redacted || "Working tree is clean."
    : `${redacted.slice(0, MAX_GIT_STATUS_CHARS - 14)}\n[truncated]`;
}

async function writeCompactSnapshot(options: {
  readonly root: string;
  readonly harness: ProjectLoopHarness;
  readonly now: string;
  readonly gitStatus: (root: string) => Promise<string>;
}): Promise<void> {
  const path = loopPath(options.root, options.harness, "loop-state.md");
  const status = boundedSnapshot(await options.gitStatus(options.root));
  await withPrivateFileLock(path, options.root, async () => {
    const source = await readPrivateFile(path, options.root);
    const baseline = source ?? "# Loop state\n";
    const content = [
      "Last compaction snapshot (bounded and redacted).",
      `Captured: ${options.now}`,
      "",
      "## Git status",
      status
    ].join("\n");
    await writePrivateFile(
      path,
      applyManagedBlock(baseline, {
        id: LOOP_SNAPSHOT_ID,
        version: 1,
        content
      }),
      options.root
    );
  });
}

/** Recovery kind this entry point is being asked for. */
type RestoreMode = "compact" | "resume" | "fresh";

function inputField(input: unknown, field: string): string | undefined {
  if (typeof input !== "object" || input === null) {
    return undefined;
  }
  const value = (input as Record<string, unknown>)[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Claude Code publishes `source` on SessionStart: `compact` after a
 * compaction, `resume` when the transcript is still present, `startup` and
 * `clear` for an empty one. A host that publishes nothing is treated as
 * `fresh`, which injects the least.
 */
function restoreMode(input: unknown): RestoreMode {
  switch (inputField(input, "source")) {
    case "compact":
      return "compact";
    case "resume":
      return "resume";
    default:
      return "fresh";
  }
}

function sessionIdOf(input: unknown): string | undefined {
  const value = inputField(input, "session_id");
  return value !== undefined && SESSION_ID_PATTERN.test(value)
    ? value
    : undefined;
}

interface LoopSessionMarker {
  readonly sessionId?: string;
  readonly taskId?: string;
}

function parseSessionMarker(source: string | null): LoopSessionMarker {
  if (source === null) {
    return {};
  }
  const session = source.match(/^Session: (\S+)$/mu)?.[1];
  const task = source.match(/^Task: (\S+)$/mu)?.[1];
  return {
    ...(session === undefined ? {} : { sessionId: session }),
    ...(task === undefined ? {} : { taskId: task })
  };
}

/**
 * The bridge the CLI cannot build for itself: a hook is told the session id,
 * a command run inside that session is not. Recording it here lets
 * `agent-ops task attach` default to the session actually running.
 *
 * ponytail: last writer wins. Two concurrent sessions in one checkout already
 * violate the one-writer rule; pass `--session` explicitly if you need that.
 */
export async function writeSessionMarker(options: {
  readonly root: string;
  readonly harness: ProjectLoopHarness;
  readonly sessionId: string;
  readonly taskId?: string;
}): Promise<void> {
  const path = loopPath(options.root, options.harness, "loop-state.md");
  await withPrivateFileLock(path, options.root, async () => {
    const source = await readPrivateFile(path, options.root);
    const baseline = source ?? "# Loop state\n";
    const previous = parseSessionMarker(source);
    const taskId = options.taskId ?? previous.taskId;
    await writePrivateFile(
      path,
      applyManagedBlock(baseline, {
        id: LOOP_SESSION_ID,
        version: 1,
        content: [
          `Session: ${options.sessionId}`,
          ...(taskId === undefined ? [] : [`Task: ${taskId}`])
        ].join("\n")
      }),
      options.root
    );
  });
}

/**
 * The session id a hook recorded for this checkout, for commands the host
 * never tells. Both harness directories are considered and the most recently
 * written marker wins, because a checkout may carry both.
 */
export async function readRecordedSessionId(
  root: string
): Promise<string | undefined> {
  const candidates: { readonly sessionId: string; readonly at: number }[] = [];
  for (const harness of ["claude", "codex"] as const) {
    const path = loopPath(root, harness, "loop-state.md");
    try {
      const marker = parseSessionMarker(await readPrivateFile(path, root));
      if (marker.sessionId === undefined) {
        continue;
      }
      const status = await lstat(path);
      candidates.push({ sessionId: marker.sessionId, at: status.mtimeMs });
    } catch {
      continue;
    }
  }
  return candidates.sort((left, right) => right.at - left.at)[0]?.sessionId;
}

interface RestoreState {
  readonly checkpoint?: string;
  readonly pointer?: string;
  readonly taskId?: string;
  readonly outcome: "hit" | "pointer" | "miss";
}

/**
 * The task attached to this session, never merely the most recent one: a
 * checkpoint from somebody else's task is worse than none. When this session
 * is unknown, the previous task is offered as a one-line pointer instead, so
 * the agent can attach to it deliberately.
 */
async function restoreState(options: {
  readonly root: string;
  readonly harness: ProjectLoopHarness;
  readonly sessionId: string | undefined;
}): Promise<RestoreState> {
  const marker = parseSessionMarker(
    await readPrivateFile(
      loopPath(options.root, options.harness, "loop-state.md"),
      options.root
    )
  );
  const state = parseTaskStateSource(
    await readPrivateFile(
      join(options.root, ".agent-ops", "tasks", "state.json"),
      options.root
    )
  );
  const attachment = options.sessionId === undefined
    ? undefined
    : state.sessions.find(
        (candidate) => candidate.sessionId === options.sessionId
      );
  const attached = attachment === undefined
    ? undefined
    : state.tasks.find((record) => record.task.id === attachment.taskId);
  if (attached !== undefined) {
    return {
      checkpoint: renderTaskCheckpoint(
        attached,
        DEFAULT_CHECKPOINT_BUDGET,
        (value) => safeStateContext(value, "task-checkpoint")
      ),
      // A fresh start of an attached session — `/clear` keeps the id — is told
      // the task exists without being handed its contents.
      pointer: `Attached task here: ${attached.task.id} — its state was not ` +
        `injected; read it with \`agent-ops task status --task ` +
        `${attached.task.id}\`.`,
      taskId: attached.task.id,
      outcome: "hit"
    };
  }
  const previous = marker.taskId === undefined
    ? undefined
    : state.tasks.find(
        (record) =>
          record.task.id === marker.taskId && record.status === "active"
      );
  if (previous === undefined) {
    return { outcome: "miss" };
  }
  return {
    pointer: `Last active task here: ${previous.task.id} — ` +
      `attach it with \`agent-ops task attach --task ${previous.task.id}\` ` +
      "to restore its state, or start a new one.",
    taskId: previous.task.id,
    outcome: "pointer"
  };
}

function clamp(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 14)}\n[truncated]`;
}

/** Printed only when it is a plain token: it lands verbatim in agent context. */
const PRINTABLE_SESSION = /^[A-Za-z0-9._:-]{1,128}$/u;

function sessionContext(options: {
  readonly sessionId?: string;
  readonly goal: string;
  readonly telemetryEntries: number;
  readonly mode: RestoreMode;
  readonly restore: RestoreState;
}): string {
  // Task state is assembled first and clamped on its own budget, so a long
  // goal can no longer crowd out the one thing recovery exists to carry.
  // Strictly one shape per mode. A resumed transcript still holds the state,
  // and a fresh session is offered the previous task rather than handed its
  // contents: `/clear` keeps the session id, so an attachment alone must not
  // be read as "this context still knows the task".
  const restored = ((): readonly string[] => {
    if (options.mode === "compact") {
      // Already sanitized field by field, and never clamped here: the
      // criterion ids and the evidence pointer are required, and slicing the
      // assembled text is what would cut through them.
      return options.restore.checkpoint === undefined
        ? []
        : [options.restore.checkpoint, ""];
    }
    if (options.mode === "fresh") {
      const pointer = options.restore.pointer === undefined
        ? undefined
        : safeStateContext(options.restore.pointer, "task-pointer");
      return pointer === undefined ? [] : [pointer, ""];
    }
    return [];
  })();
  const telemetry = `Telemetry: ${options.telemetryEntries} recent redacted event(s).`;
  // The id every `--session` flag wants. Hooks hear it; the agent otherwise
  // never does, and a shared checkout's recorded marker belongs to whichever
  // session started last.
  const session = options.sessionId !== undefined && PRINTABLE_SESSION.test(options.sessionId)
    ? [`Session: ${options.sessionId}`]
    : [];
  const fixed = [
    "agent-ops project loop is active.",
    ...session,
    "",
    ...restored,
    telemetry
  ];
  // The goal takes what is left rather than a fixed share: a task at the
  // schema's limits needs most of the ceiling, and dropping the goal line is
  // better than truncating the state the session is being restored with.
  const spent = fixed.reduce((total, line) => total + line.length + 1, 0);
  const goalRoom = Math.min(
    MAX_GOAL_CHARS,
    MAX_CONTEXT_CHARS - spent - "Current goal:".length - 2
  );
  return boundedContext(
    (goalRoom < MIN_GOAL_CHARS
      ? fixed
      : [
          ...fixed.slice(0, -1),
          "Current goal:",
          clamp(options.goal, goalRoom),
          "",
          telemetry
        ]).join("\n")
  );
}

function sessionOutput(
  harness: ProjectLoopHarness,
  context: string
): ProjectLoopResult {
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: context
      }
    }),
    stderr: ""
  };
}

/**
 * Generic project-local loop policy. It deliberately reads only documented
 * hook fields and records outcome identifiers, never prompts or command text.
 */
export async function runProjectLoop(
  options: ProjectLoopOptions
): Promise<ProjectLoopResult> {
  let decision: LoopDecision = {
    blocked: false,
    outcome: "observed",
    code: "loop-observed",
    denial: "none"
  };
  const scope = inputCwd(options.input) ?? options.root ?? ".";
  try {
    if (options.event === "UserPromptSubmit") {
      decision = evaluatePrompt(options.input, scope);
    } else if (options.event === "PreToolUse") {
      decision = evaluateBash(options.input, scope);
    } else if (options.event === "PermissionRequest") {
      decision = {
        blocked: false,
        outcome: "observed",
        code:
          requestedSandboxPermission(options.input) === "require_escalated"
            ? "permission-escalated"
            : "permission-pending",
        denial: "none"
      };
    }
  } catch {
    return noOutput();
  }

  const root = await resolveLoopRoot(
    options.input,
    options.root,
    options.harness
  ).catch(() => null);
  // SessionStart records its own event naming the restore outcome, so the
  // generic record is skipped rather than written twice.
  if (root !== null && options.event !== "SessionStart") {
    await appendTelemetry({
      root,
      harness: options.harness,
      event: options.event,
      decision,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.telemetryMaxBytes === undefined
        ? {}
        : { maxBytes: options.telemetryMaxBytes })
    }).catch(() => undefined);
  }

  if (decision.blocked) {
    return decision.denial === "secret"
      ? secretDenial(options.harness, options.event)
      : commandDenial(options.harness, options.event, decision.code);
  }

  if (options.event === "PreCompact" && root !== null) {
    await writeCompactSnapshot({
      root,
      harness: options.harness,
      now: options.now?.() ?? new Date().toISOString(),
      gitStatus: options.gitStatus ?? defaultGitStatus
    }).catch(() => undefined);
  }
  if (options.event === "SessionStart" && root !== null) {
    const sessionId = sessionIdOf(options.input);
    const restore = await restoreState({
      root,
      harness: options.harness,
      sessionId
    }).catch((): RestoreState => ({ outcome: "miss" }));
    // Exactly one event per SessionStart, written before the context is built
    // so a later read failure cannot lose the outcome.
    await appendTelemetry({
        root,
        harness: options.harness,
        event: "SessionStart",
        decision: {
          blocked: false,
          outcome: "observed",
          code: `restore-${restore.outcome}`,
          denial: "none"
        },
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.telemetryMaxBytes === undefined
          ? {}
          : { maxBytes: options.telemetryMaxBytes })
    }).catch(() => undefined);
    if (sessionId !== undefined) {
      await writeSessionMarker({
        root,
        harness: options.harness,
        sessionId,
        ...(restore.taskId === undefined ? {} : { taskId: restore.taskId })
      }).catch(() => undefined);
    }
    try {
      const [goal, telemetryEntries] = await Promise.all([
        readPrivateFile(loopPath(root, options.harness, "loop-goal.md"), root),
        telemetryCount(root, options.harness)
      ]);
      return sessionOutput(
        options.harness,
        sessionContext({
          ...(sessionId === undefined ? {} : { sessionId }),
          goal: safeGoalContext(goal),
          telemetryEntries,
          mode: restoreMode(options.input),
          restore
        })
      );
    } catch {
      return noOutput();
    }
  }
  return noOutput();
}
