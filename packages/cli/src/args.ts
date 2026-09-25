import type {
  Harness,
  HarnessId,
  InstallScope,
  Profile,
  ReviewTargetId
} from "../../../runtime/src/contracts.js";
import {
  isHarnessId,
  resolveHarnessSelection
} from "../../../runtime/src/install/harness.js";
import type { HookTargetSelection } from "../../../runtime/src/install/types.js";

export const COMMAND_NAMES = [
  "init",
  "config",
  "trust",
  "doctor",
  "update",
  "uninstall",
  "task",
  "verify",
  "review",
  "allow-stop",
  "worktree"
] as const;

const COMMAND_SET = new Set<string>(COMMAND_NAMES);
const SCOPES = new Set<string>(["project", "user"]);
const PROFILES = new Set<string>(["advisory", "core", "guardrails", "loop"]);
// opencode is absent: it has no read-only flag, so it cannot review.
const REVIEW_TARGETS = new Set<string>(["agy", "claude", "codex"]);

export type TopLevelCommand = (typeof COMMAND_NAMES)[number];
export type CliCommand = "help" | "version" | TopLevelCommand;
export type ConfigAction = "explain";
export type TrustAction = "grant" | "revoke" | "status";
export type TaskAction =
  | "archive"
  | "attach"
  | "complete"
  | "create"
  | "export"
  | "status";
export type WorktreeAction = "add" | "finish" | "list" | "remove" | "resume";
export const WORKTREE_ACTIONS: readonly WorktreeAction[] = ["add", "finish", "list", "resume", "remove"];
export type CliAction = ConfigAction | TaskAction | TrustAction | WorktreeAction;

export interface ParsedArgs {
  command: CliCommand;
  action?: CliAction;
  /** `help` only: the command `<command> --help` asked about. */
  helpTopic?: TopLevelCommand;
  /** `help` only: the sub-action, when one was given. */
  helpAction?: CliAction;
  scope?: InstallScope;
  harness?: Harness;
  hookTargets?: HookTargetSelection[];
  profiles: Profile[];
  /** Review target CLIs, in declared order. Absent means disabled. */
  reviewTargets?: ReviewTargetId[];
  /** Explicitly enable the agy project-loop completion gate. */
  completionGate?: boolean;
  /** Authorizes doctor's expensive review-target authentication probe. */
  checkAuth?: boolean;
  /** Restricts doctor's authentication probe to these review targets. */
  checkAuthTargets?: ReviewTargetId[];
  taskId?: string;
  /** Parent task: assigns one on create, filters by one on status. */
  parentTaskId?: string;
  targetVersion?: string;
  title?: string;
  criteria?: string[];
  evidence?: string[];
  sessionId?: string;
  base?: string;
  dryRun: boolean;
  json: boolean;
  yes: boolean;
  /** review: discard a matching PASS attestation and run the chain again. */
  rerun: boolean;
  /** worktree: the worktree name after the action. */
  worktreeName?: string;
  /** worktree remove: discard uncommitted or unmerged work. */
  force?: boolean;
  /** Worktree mode: auto isolates sessions into git worktrees, off disables. */
  worktree?: "auto" | "off";
}

export class CliArgumentError extends Error {
  readonly code: string;
  readonly option?: string;

  constructor(code: string, message: string, option?: string) {
    super(message);
    this.name = "CliArgumentError";
    this.code = code;
    this.option = option;
  }
}

function readOptionValue(
  argv: readonly string[],
  index: number,
  option: string
): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new CliArgumentError(
      "CLI_MISSING_VALUE",
      `${option} requires a value.`,
      option
    );
  }
  return value;
}

function duplicate(option: string): never {
  throw new CliArgumentError(
    "CLI_DUPLICATE_OPTION",
    `${option} may not be repeated.`,
    option
  );
}

function invalidValue(option: string, value: string): never {
  throw new CliArgumentError(
    "CLI_INVALID_VALUE",
    `Invalid value for ${option}: ${value}`,
    option
  );
}

function parseHarness(option: string, value: string): Harness {
  return resolveHarnessSelection(value) ?? invalidValue(option, value);
}

function parseHookTarget(
  option: string,
  value: string
): HookTargetSelection {
  const separator = value.indexOf("=");
  if (
    separator <= 0 ||
    separator !== value.lastIndexOf("=") ||
    separator === value.length - 1
  ) {
    return invalidValue(option, value);
  }
  const harness = value.slice(0, separator);
  const surfaceId = value.slice(separator + 1);
  if (
    !isHarnessId(harness) ||
    !/^[a-z][a-z0-9-]{0,63}$/u.test(surfaceId)
  ) {
    return invalidValue(option, value);
  }
  return { harness: harness as HarnessId, surfaceId };
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  let command: CliCommand | undefined;
  let action: CliAction | undefined;
  let scope: InstallScope | undefined;
  let harness: Harness | undefined;
  const hookTargets: HookTargetSelection[] = [];
  let taskId: string | undefined;
  let parentTaskId: string | undefined;
  let targetVersion: string | undefined;
  let title: string | undefined;
  let sessionId: string | undefined;
  let base: string | undefined;
  const profiles: Profile[] = [];
  const reviewTargets: ReviewTargetId[] = [];
  const criteria: string[] = [];
  const evidence: string[] = [];
  let checkAuth = false;
  const checkAuthTargets: ReviewTargetId[] = [];
  let completionGate: boolean | undefined;
  let dryRun = false;
  let json = false;
  let yes = false;
  let rerun = false;
  let helpSeen = false;
  let versionSeen = false;
  let worktreeName: string | undefined;
  let force = false;
  let worktree: "auto" | "off" | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) {
      break;
    }

    switch (token) {
      case "--scope": {
        if (scope !== undefined) {
          duplicate(token);
        }
        const value = readOptionValue(argv, index, token);
        if (!SCOPES.has(value)) {
          invalidValue(token, value);
        }
        scope = value as InstallScope;
        index += 1;
        break;
      }
      case "--harness": {
        if (harness !== undefined) {
          duplicate(token);
        }
        const value = readOptionValue(argv, index, token);
        harness = parseHarness(token, value);
        index += 1;
        break;
      }
      case "--hook-target": {
        const value = readOptionValue(argv, index, token);
        const target = parseHookTarget(token, value);
        if (hookTargets.some(({ harness: id }) => id === target.harness)) {
          duplicate(`${token} ${target.harness}`);
        }
        hookTargets.push(target);
        index += 1;
        break;
      }
      case "--profile": {
        const value = readOptionValue(argv, index, token);
        if (!PROFILES.has(value)) {
          invalidValue(token, value);
        }
        if (profiles.includes(value as Profile)) {
          duplicate(`${token} ${value}`);
        }
        profiles.push(value as Profile);
        index += 1;
        break;
      }
      case "--review-target": {
        const value = readOptionValue(argv, index, token);
        if (!REVIEW_TARGETS.has(value)) {
          invalidValue(token, value);
        }
        if (reviewTargets.includes(value as ReviewTargetId)) {
          duplicate(`${token} ${value}`);
        }
        reviewTargets.push(value as ReviewTargetId);
        index += 1;
        break;
      }
      case "--task": {
        if (taskId !== undefined) {
          duplicate(token);
        }
        taskId = readOptionValue(argv, index, token);
        index += 1;
        break;
      }
      case "--parent": {
        if (parentTaskId !== undefined) {
          duplicate(token);
        }
        parentTaskId = readOptionValue(argv, index, token);
        index += 1;
        break;
      }
      case "--target-version": {
        if (targetVersion !== undefined) {
          duplicate(token);
        }
        targetVersion = readOptionValue(argv, index, token);
        index += 1;
        break;
      }
      case "--title": {
        if (title !== undefined) {
          duplicate(token);
        }
        title = readOptionValue(argv, index, token);
        index += 1;
        break;
      }
      case "--criterion": {
        criteria.push(readOptionValue(argv, index, token));
        index += 1;
        break;
      }
      case "--evidence": {
        evidence.push(readOptionValue(argv, index, token));
        index += 1;
        break;
      }
      case "--session": {
        if (sessionId !== undefined) {
          duplicate(token);
        }
        sessionId = readOptionValue(argv, index, token);
        index += 1;
        break;
      }
      case "--base": {
        if (base !== undefined) {
          duplicate(token);
        }
        base = readOptionValue(argv, index, token);
        index += 1;
        break;
      }
      case "--check-auth":
        if (checkAuth) {
          duplicate(token);
        }
        checkAuth = true;
        break;
      case "--check-auth-target": {
        const value = readOptionValue(argv, index, token);
        if (!REVIEW_TARGETS.has(value)) {
          invalidValue(token, value);
        }
        if (checkAuthTargets.includes(value as ReviewTargetId)) {
          duplicate(`${token} ${value}`);
        }
        checkAuthTargets.push(value as ReviewTargetId);
        index += 1;
        break;
      }
      case "--completion-gate":
        if (completionGate !== undefined) {
          duplicate(token);
        }
        completionGate = true;
        break;
      case "--worktree": {
        if (worktree !== undefined) {
          duplicate(token);
        }
        const value = readOptionValue(argv, index, token);
        if (value !== "auto" && value !== "off") {
          throw new CliArgumentError(
            "CLI_INVALID_VALUE",
            `Worktree mode must be auto or off: ${value}`,
            token
          );
        }
        worktree = value;
        index += 1;
        break;
      }
      case "--dry-run":
        if (dryRun) {
          duplicate(token);
        }
        dryRun = true;
        break;
      case "--json":
        if (json) {
          duplicate(token);
        }
        json = true;
        break;
      case "--yes":
        if (yes) {
          duplicate(token);
        }
        yes = true;
        break;
      case "--force":
        if (force) {
          duplicate(token);
        }
        force = true;
        break;
      case "--rerun":
        if (rerun) {
          duplicate(token);
        }
        rerun = true;
        break;
      case "--help":
      case "-h":
        if (helpSeen) {
          duplicate(token);
        }
        helpSeen = true;
        break;
      case "--version":
      case "-v":
        if (versionSeen) {
          duplicate(token);
        }
        versionSeen = true;
        break;
      default:
        if (token.startsWith("-")) {
          throw new CliArgumentError(
            "CLI_UNKNOWN_OPTION",
            `Unknown option: ${token}`,
            token
          );
        }
        if (
          command === "config" &&
          action === undefined &&
          token === "explain"
        ) {
          action = token;
          break;
        }
        if (
          command === "trust" &&
          action === undefined &&
          ["grant", "revoke", "status"].includes(token)
        ) {
          action = token as TrustAction;
          break;
        }
        if (
          command === "task" &&
          action === undefined &&
          [
            "archive",
            "attach",
            "complete",
            "create",
            "export",
            "status"
          ].includes(token)
        ) {
          action = token as TaskAction;
          break;
        }
        if (
          command === "worktree" &&
          action === undefined &&
          (WORKTREE_ACTIONS as readonly string[]).includes(token)
        ) {
          action = token as WorktreeAction;
          break;
        }
        if (command === "worktree" && action !== undefined && action !== "list" && worktreeName === undefined) {
          worktreeName = token;
          break;
        }
        if (command !== undefined) {
          throw new CliArgumentError(
            "CLI_UNEXPECTED_ARGUMENT",
            `Unexpected argument: ${token}`
          );
        }
        if (!COMMAND_SET.has(token)) {
          throw new CliArgumentError(
            "CLI_UNKNOWN_COMMAND",
            `Unknown command: ${token}`
          );
        }
        command = token as TopLevelCommand;
    }
  }

  if (helpSeen && versionSeen) {
    throw new CliArgumentError(
      "CLI_CONFLICTING_ACTION",
      "--help and --version cannot be combined."
    );
  }
  // `<command> --help` asks about that command, so it answers instead of
  // failing: an agent that cannot read a command's own option shapes guesses
  // at them one rejected call at a time. Other options are ignored rather than
  // rejected, so `task create --criterion <wrong> --help` still explains the
  // shape it got wrong.
  if (
    helpSeen &&
    command !== undefined &&
    command !== "help" &&
    command !== "version"
  ) {
    return {
      command: "help",
      helpTopic: command,
      ...(action === undefined ? {} : { helpAction: action }),
      profiles: [],
      dryRun: false,
      json,
      yes: false,
      rerun: false
    };
  }
  if (versionSeen && command !== undefined) {
    throw new CliArgumentError(
      "CLI_CONFLICTING_ACTION",
      "Global version cannot be combined with a command."
    );
  }
  if (helpSeen || versionSeen) {
    if (
      scope !== undefined ||
      harness !== undefined ||
      hookTargets.length > 0 ||
      profiles.length > 0 ||
      taskId !== undefined ||
      parentTaskId !== undefined ||
      targetVersion !== undefined ||
      title !== undefined ||
      criteria.length > 0 ||
      evidence.length > 0 ||
      reviewTargets.length > 0 ||
      completionGate !== undefined ||
      sessionId !== undefined ||
      base !== undefined ||
      checkAuth ||
      checkAuthTargets.length > 0 ||
      dryRun ||
      yes ||
      rerun ||
      worktree !== undefined ||
      force
    ) {
      throw new CliArgumentError(
        "CLI_OPTION_NOT_ALLOWED",
        "Only --json may be combined with global help or version."
      );
    }
    command = helpSeen ? "help" : "version";
  }
  if (command === undefined) {
    throw new CliArgumentError(
      "CLI_COMMAND_REQUIRED",
      "A command, --help, or --version is required."
    );
  }
  if (command === "trust" && action === undefined) {
    throw new CliArgumentError(
      "CLI_ACTION_REQUIRED",
      "The trust command requires one of: status, grant, revoke."
    );
  }
  if (command === "worktree" && action === undefined) {
    throw new CliArgumentError(
      "CLI_ACTION_REQUIRED",
      `The worktree command requires one of: ${WORKTREE_ACTIONS.join(", ")}.`
    );
  }
  if (command === "worktree" && action !== "list" && worktreeName === undefined) {
    throw new CliArgumentError(
      "CLI_OPTION_NOT_ALLOWED",
      `worktree ${action} requires a worktree name.`
    );
  }
  if (command === "task" && action === undefined) {
    throw new CliArgumentError(
      "CLI_ACTION_REQUIRED",
      "The task command requires one of: create, status, attach, complete, archive, export."
    );
  }
  const hasTaskTargetOptions =
    taskId !== undefined ||
    sessionId !== undefined;
  const hasTaskMutationOptions =
    title !== undefined ||
    criteria.length > 0 ||
    evidence.length > 0;
  if (
    command !== "task" &&
    command !== "verify" &&
    command !== "review" &&
    command !== "allow-stop" &&
    !(command === "worktree" && sessionId !== undefined && taskId === undefined) &&
    (hasTaskTargetOptions || hasTaskMutationOptions)
  ) {
    throw new CliArgumentError(
      "CLI_OPTION_NOT_ALLOWED",
      "Task target options may be used only with task or verify."
    );
  }
  if (command !== "task" && parentTaskId !== undefined) {
    throw new CliArgumentError(
      "CLI_OPTION_NOT_ALLOWED",
      "--parent may be used only with task create or task status."
    );
  }
  if (command !== "update" && targetVersion !== undefined) {
    throw new CliArgumentError(
      "CLI_OPTION_NOT_ALLOWED",
      "--target-version may be used only with update."
    );
  }
  if (base !== undefined && command !== "verify" && command !== "review" &&
    !(command === "task" && action === "complete")) {
    throw new CliArgumentError(
      "CLI_OPTION_NOT_ALLOWED",
      "--base may be used only with verify, review or task complete."
    );
  }
  if (
    hookTargets.length > 0 &&
    command !== "init" &&
    command !== "update"
  ) {
    throw new CliArgumentError(
      "CLI_OPTION_NOT_ALLOWED",
      "--hook-target may be used only with init or update."
    );
  }
  if (checkAuth && command !== "doctor") {
    throw new CliArgumentError(
      "CLI_OPTION_NOT_ALLOWED",
      "--check-auth may be used only with doctor."
    );
  }
  if (checkAuthTargets.length > 0 && command !== "doctor") {
    throw new CliArgumentError(
      "CLI_OPTION_NOT_ALLOWED",
      "--check-auth-target may be used only with doctor."
    );
  }
  if (checkAuthTargets.length > 0 && !checkAuth) {
    throw new CliArgumentError(
      "CLI_OPTION_NOT_ALLOWED",
      "--check-auth-target requires --check-auth."
    );
  }
  if (reviewTargets.length > 0 && command !== "init") {
    throw new CliArgumentError(
      "CLI_OPTION_NOT_ALLOWED",
      command === "review"
        ? "--review-target configures init; review uses the configured reviewer pair."
        : "--review-target may be used only with init."
    );
  }
  if (completionGate !== undefined && command !== "init") {
    throw new CliArgumentError(
      "CLI_OPTION_NOT_ALLOWED",
      "--completion-gate may be used only with init."
    );
  }
  if (worktree !== undefined && command !== "init" && command !== "update") {
    throw new CliArgumentError(
      "CLI_OPTION_NOT_ALLOWED",
      "--worktree may be used only with init or update."
    );
  }
  if (command === "task") {
    if (
      harness !== undefined ||
      profiles.length > 0 ||
      dryRun ||
      yes ||
      rerun
    ) {
      throw new CliArgumentError(
        "CLI_OPTION_NOT_ALLOWED",
        "Task commands do not accept harness, profile, dry-run, or yes options."
      );
    }
    const taskOptionInvalid =
      (action === "create" &&
        (taskId !== undefined ||
          evidence.length > 0)) ||
      (action === "status" &&
        (title !== undefined ||
          criteria.length > 0 ||
          evidence.length > 0 ||
          // --parent filters the listing, so it cannot name a single target.
          (parentTaskId !== undefined &&
            (taskId !== undefined || sessionId !== undefined)) ||
          (taskId !== undefined && sessionId !== undefined))) ||
      (action === "attach" &&
        (title !== undefined ||
          criteria.length > 0 ||
          evidence.length > 0 ||
          parentTaskId !== undefined)) ||
      (action === "complete" &&
        (title !== undefined ||
          criteria.length > 0 ||
          sessionId !== undefined ||
          parentTaskId !== undefined)) ||
      ((action === "archive" || action === "export") &&
        (title !== undefined ||
          criteria.length > 0 ||
          evidence.length > 0 ||
          sessionId !== undefined ||
          parentTaskId !== undefined));
    if (taskOptionInvalid) {
      throw new CliArgumentError(
        "CLI_OPTION_NOT_ALLOWED",
        `Unsupported option for task ${action}.`
      );
    }
  }
  if (
    command === "verify" &&
    (harness !== undefined ||
      profiles.length > 0 ||
      title !== undefined ||
      criteria.length > 0 ||
      evidence.length > 0 ||
      dryRun ||
      yes ||
      (taskId !== undefined && sessionId !== undefined))
  ) {
    throw new CliArgumentError(
      "CLI_OPTION_NOT_ALLOWED",
      "Verify accepts only scope, task or session, base, and json options."
    );
  }
  if (
    command === "review" &&
    (title !== undefined || sessionId !== undefined || dryRun)
  ) {
    throw new CliArgumentError(
      "CLI_OPTION_NOT_ALLOWED",
      "Review accepts task, base, json, and yes options."
    );
  }
  if (command === "review" && taskId === undefined) {
    throw new CliArgumentError(
      "CLI_OPTION_NOT_ALLOWED",
      "Review requires --task for the complete task-bound review."
    );
  }
  if (command === "review" && !yes) {
    throw new CliArgumentError(
      "CLI_OPTION_NOT_ALLOWED",
      "Review requires --yes to authorize both reviewer sessions."
    );
  }
  if (command === "review" && harness !== undefined) {
    throw new CliArgumentError(
      "CLI_OPTION_NOT_ALLOWED",
      "Complete review uses the configured reviewer pair; omit --harness."
    );
  }
  if (command === "review" && (criteria.length > 0 || evidence.length > 0)) {
    throw new CliArgumentError(
      "CLI_OPTION_NOT_ALLOWED",
      "Complete review covers every task criterion; omit --criterion and --evidence."
    );
  }
  if (
    command === "allow-stop" &&
    (sessionId === undefined ||
      scope !== undefined ||
      harness !== undefined ||
      taskId !== undefined ||
      profiles.length > 0 ||
      title !== undefined ||
      criteria.length > 0 ||
      evidence.length > 0 ||
      dryRun ||
      yes)
  ) {
    throw new CliArgumentError(
      "CLI_OPTION_NOT_ALLOWED",
      "allow-stop requires only --session (and optional --json)."
    );
  }

  if (
    command === "worktree" &&
    (scope !== undefined ||
      harness !== undefined ||
      profiles.length > 0 ||
      hasTaskMutationOptions ||
      dryRun ||
      yes ||
      rerun)
  ) {
    throw new CliArgumentError(
      "CLI_OPTION_NOT_ALLOWED",
      "worktree accepts only a name, --session and --json."
    );
  }
  if (force && !(command === "worktree" && action === "remove")) {
    throw new CliArgumentError(
      "CLI_OPTION_NOT_ALLOWED",
      "--force may be used only with worktree remove."
    );
  }
  if (command === "worktree" && action !== "add" && action !== "resume" && sessionId !== undefined) {
    throw new CliArgumentError(
      "CLI_OPTION_NOT_ALLOWED",
      `worktree ${action} takes the session from the worktree; omit --session.`
    );
  }

  return {
    command,
    ...(action === undefined ? {} : { action }),
    ...(worktreeName === undefined ? {} : { worktreeName }),
    ...(force ? { force } : {}),
    ...(scope === undefined ? {} : { scope }),
    ...(harness === undefined ? {} : { harness }),
    ...(hookTargets.length === 0 ? {} : { hookTargets }),
    profiles,
    ...(taskId === undefined ? {} : { taskId }),
    ...(parentTaskId === undefined ? {} : { parentTaskId }),
    ...(targetVersion === undefined ? {} : { targetVersion }),
    ...(title === undefined ? {} : { title }),
    ...(reviewTargets.length === 0 ? {} : { reviewTargets }),
    ...(completionGate === undefined ? {} : { completionGate }),
    ...(criteria.length === 0 ? {} : { criteria }),
    ...(evidence.length === 0 ? {} : { evidence }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(base === undefined ? {} : { base }),
    ...(checkAuth ? { checkAuth } : {}),
    ...(checkAuthTargets.length === 0 ? {} : { checkAuthTargets }),
    rerun,
    dryRun,
    json,
    yes,
    ...(worktree === undefined ? {} : { worktree })
  };
}
