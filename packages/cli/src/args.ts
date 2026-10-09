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
  "batch",
  "allow-stop",
  "worktree",
  "run",
  "office"
] as const;

const COMMAND_SET = new Set<string>(COMMAND_NAMES);
const SCOPES = new Set<string>(["project", "user"]);
const PROFILES = new Set<string>(["advisory", "core", "guardrails", "loop", "run"]);
// opencode is absent: it has no read-only flag, so it cannot review.
const REVIEW_TARGETS = new Set<string>(["agy", "claude", "codex"]);

export type TopLevelCommand = (typeof COMMAND_NAMES)[number];
export type CliCommand = "help" | "version" | TopLevelCommand;
export type ConfigAction = "explain";
export type TrustAction = "grant" | "revoke" | "status";
export type TaskAction =
  | "advance"
  | "archive"
  | "attach"
  | "complete"
  | "create"
  | "export"
  | "status"
  | "revise"
  | "replan"
  | "pin-finding";
export type ReviewAction = "show";
export type WorktreeAction = "add" | "commit" | "finish" | "list" | "remove" | "resume";
export const WORKTREE_ACTIONS: readonly WorktreeAction[] = ["add", "commit", "finish", "list", "resume", "remove"];
export type RunAction = "start" | "status" | "logs" | "resume" | "stop" | "respond";
export type CliAction = RunAction | ConfigAction | TaskAction | TrustAction | ReviewAction | WorktreeAction;

export interface ParsedArgs {
  command: CliCommand;
  runAction?: RunAction;
  runId?: string;
  goal?: string;
  goalFile?: string;
  host?: "claude" | "codex";
  timeBudgetMs?: number;
  jobs?: number;
  questionId?: string;
  answer?: string;
  answerFile?: string;
  wait?: boolean;
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
  office?: "on" | "off";
  /** update: add or remove the `run` profile; `loop` stays either way. */
  autoRun?: "on" | "off";
  /** Authorizes doctor's expensive review-target authentication probe. */
  checkAuth?: boolean;
  /** Restricts doctor's authentication probe to these review targets. */
  checkAuthTargets?: ReviewTargetId[];
  taskId?: string;
  /** Parent task: assigns one on create, filters by one on status. */
  parentTaskId?: string;
  targetVersion?: string;
  title?: string;
  intent?: string;
  criteria?: string[];
  criterionFiles?: string[];
  criteriaFile?: string;
  planFile?: string;
  expectedContract?: string;
  expectedTreeContract?: string;
  reason?: string;
  baseline?: string;
  findingReference?: string;
  evidence?: string[];
  sessionId?: string;
  base?: string;
  /** batch: the base for the parent task; `base` applies to its subtasks. */
  parentBase?: string;
  /** batch: how many reviews may run at once. */
  width?: number;
  dryRun: boolean;
  json: boolean;
  yes: boolean;
  /** review: discard a matching PASS attestation and run the chain again. */
  rerun: boolean;
  /** review: cover the selected task and all non-archived descendants. */
  tree?: boolean;
  /** worktree: the worktree name after the action. */
  worktreeName?: string;
  /** worktree remove: discard uncommitted or unmerged work. */
  force?: boolean;
  /** worktree add: commit, branch or tag to branch the new worktree from (default HEAD). */
  worktreeFrom?: string;
  /** worktree commit: the commit message. */
  worktreeMessage?: string;
  /** review, doctor: write the JSON envelope to this file instead of relying on a shell redirect. */
  output?: string;
  /** worktree add: branch finish merges back into (defaults to the current branch; required when detached). */
  worktreeTargetBranch?: string;
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
  if (argv[0] === "run") return parseRunArgs(argv.slice(1));
  let command: CliCommand | undefined;
  let action: CliAction | undefined;
  let scope: InstallScope | undefined;
  let harness: Harness | undefined;
  const hookTargets: HookTargetSelection[] = [];
  let taskId: string | undefined;
  let parentTaskId: string | undefined;
  let targetVersion: string | undefined;
  let title: string | undefined;
  let intent: string | undefined;
  let sessionId: string | undefined;
  let base: string | undefined;
  let parentBase: string | undefined;
  let width: number | undefined;
  const profiles: Profile[] = [];
  const reviewTargets: ReviewTargetId[] = [];
  const criteria: string[] = [];
  const criterionFiles: string[] = [];
  let criteriaFile: string | undefined;
  let planFile: string | undefined;
  let expectedContract: string | undefined;
  let expectedTreeContract: string | undefined;
  let reason: string | undefined;
  let baseline: string | undefined;
  let findingReference: string | undefined;
  const evidence: string[] = [];
  let checkAuth = false;
  const checkAuthTargets: ReviewTargetId[] = [];
  let completionGate: boolean | undefined;
  let office: "on" | "off" | undefined;
  let autoRun: "on" | "off" | undefined;
  let dryRun = false;
  let json = false;
  let yes = false;
  let rerun = false;
  let tree = false;
  let helpSeen = false;
  let versionSeen = false;
  let worktreeName: string | undefined;
  let force = false;
  let worktreeFrom: string | undefined;
  let worktreeMessage: string | undefined;
  let output: string | undefined;
  let worktreeTargetBranch: string | undefined;
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
      case "--intent": {
        if (intent !== undefined) duplicate(token);
        intent = readOptionValue(argv, index, token);
        index += 1;
        break;
      }
      case "--tree": {
        if (tree) duplicate(token);
        tree = true;
        break;
      }
      case "--criterion-file": criterionFiles.push(readOptionValue(argv, index++, token)); break;
      case "--criteria-file": if (criteriaFile !== undefined) duplicate(token); criteriaFile = readOptionValue(argv, index++, token); break;
      case "--plan-file": if (planFile !== undefined) duplicate(token); planFile = readOptionValue(argv, index++, token); break;
      case "--expected-contract": if (expectedContract !== undefined) duplicate(token); expectedContract = readOptionValue(argv, index++, token); break;
      case "--expected-tree-contract": if (expectedTreeContract !== undefined) duplicate(token); expectedTreeContract = readOptionValue(argv, index++, token); break;
      case "--reason": if (reason !== undefined) duplicate(token); reason = readOptionValue(argv, index++, token); break;
      case "--baseline": if (baseline !== undefined) duplicate(token); baseline = readOptionValue(argv, index++, token); break;
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
      case "--parent-base": {
        if (parentBase !== undefined) {
          duplicate(token);
        }
        parentBase = readOptionValue(argv, index, token);
        index += 1;
        break;
      }
      case "--width": {
        if (width !== undefined) {
          duplicate(token);
        }
        const value = readOptionValue(argv, index, token);
        if (!/^[1-9][0-9]{0,2}$/u.test(value)) {
          invalidValue(token, value);
        }
        width = Number(value);
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
      case "--office": {
        if (office !== undefined) duplicate(token);
        const value = readOptionValue(argv, index, token);
        if (value !== "on" && value !== "off") invalidValue(token, value);
        office = value as "on" | "off";
        index += 1;
        break;
      }
      case "--auto-run": {
        if (autoRun !== undefined) duplicate(token);
        const value = readOptionValue(argv, index, token);
        if (value !== "on" && value !== "off") invalidValue(token, value);
        autoRun = value as "on" | "off";
        index += 1;
        break;
      }
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
      case "--from": {
        if (worktreeFrom !== undefined) {
          duplicate(token);
        }
        worktreeFrom = readOptionValue(argv, index, token);
        index += 1;
        break;
      }
      case "-m":
      case "--message": {
        if (worktreeMessage !== undefined) {
          duplicate(token);
        }
        worktreeMessage = readOptionValue(argv, index, token);
        index += 1;
        break;
      }
      case "--output": {
        if (output !== undefined) {
          duplicate(token);
        }
        output = readOptionValue(argv, index, token);
        index += 1;
        break;
      }
      case "--target-branch": {
        if (worktreeTargetBranch !== undefined) {
          duplicate(token);
        }
        worktreeTargetBranch = readOptionValue(argv, index, token);
        index += 1;
        break;
      }
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
            "advance",
            "archive",
            "attach",
            "complete",
            "create",
            "export",
            "status", "revise", "replan", "pin-finding"
          ].includes(token)
        ) {
          action = token as TaskAction;
          break;
        }
        if (command === "review" && action === undefined && token === "show") {
          action = "show";
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
        if (
          command === "worktree" &&
          action !== undefined &&
          action !== "list" &&
          action !== "commit" &&
          worktreeName === undefined
        ) {
          worktreeName = token;
          break;
        }
        if (command === "task" && ["revise", "replan", "pin-finding"].includes(action ?? "") && taskId === undefined) {taskId = token; break;}
        if (command === "task" && action === "pin-finding" && findingReference === undefined) {findingReference = token; break;}
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
      intent !== undefined ||
      criteria.length > 0 ||
      evidence.length > 0 ||
      reviewTargets.length > 0 ||
      completionGate !== undefined ||
      office !== undefined ||
      autoRun !== undefined ||
      sessionId !== undefined ||
      base !== undefined ||
      parentBase !== undefined ||
      width !== undefined ||
      checkAuth ||
      checkAuthTargets.length > 0 ||
      dryRun ||
      yes ||
      rerun ||
      tree ||
      worktree !== undefined ||
      worktreeFrom !== undefined ||
      worktreeMessage !== undefined ||
      output !== undefined ||
      worktreeTargetBranch !== undefined ||
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
  if (command === "worktree" && action !== "list" && action !== "commit" && worktreeName === undefined) {
    throw new CliArgumentError(
      "CLI_OPTION_NOT_ALLOWED",
      `worktree ${action} requires a worktree name.`
    );
  }
  if (command === "worktree" && action === "commit" && (worktreeMessage === undefined || worktreeMessage.trim() === "")) {
    throw new CliArgumentError(
      "CLI_OPTION_NOT_ALLOWED",
      "worktree commit requires --message (-m).",
      "--message"
    );
  }
  if (worktreeMessage !== undefined && !(command === "worktree" && action === "commit")) {
    throw new CliArgumentError(
      "CLI_OPTION_NOT_ALLOWED",
      "--message may be used only with worktree commit.",
      "--message"
    );
  }
  if (command === "task" && action === undefined) {
    throw new CliArgumentError(
      "CLI_ACTION_REQUIRED",
      "The task command requires one of: create, status, attach, complete, archive, export, advance."
    );
  }
  const hasTaskTargetOptions =
    taskId !== undefined ||
    sessionId !== undefined;
  const hasTaskMutationOptions =
    title !== undefined ||
    intent !== undefined ||
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
  if (command !== "task" && command !== "batch" && parentTaskId !== undefined) {
    throw new CliArgumentError(
      "CLI_OPTION_NOT_ALLOWED",
      "--parent may be used only with task create, task status or batch."
    );
  }
  if (command !== "update" && targetVersion !== undefined) {
    throw new CliArgumentError(
      "CLI_OPTION_NOT_ALLOWED",
      "--target-version may be used only with update."
    );
  }
  if (base !== undefined && command !== "verify" && command !== "review" &&
    command !== "batch" && !(command === "task" && action === "complete")) {
    throw new CliArgumentError(
      "CLI_OPTION_NOT_ALLOWED",
      "--base may be used only with verify, review, batch or task complete."
    );
  }
  if ((parentBase !== undefined || width !== undefined) && command !== "batch") {
    throw new CliArgumentError(
      "CLI_OPTION_NOT_ALLOWED",
      `${parentBase !== undefined ? "--parent-base" : "--width"} may be used only with batch.`
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
  if (office !== undefined && command !== "init" && command !== "update") {
    throw new CliArgumentError("CLI_OPTION_NOT_ALLOWED", "--office may be used only with init or update.");
  }
  if (autoRun !== undefined && command !== "update") {
    throw new CliArgumentError("CLI_OPTION_NOT_ALLOWED", "--auto-run may be used only with update; init selects the run profile.");
  }
  if (worktree !== undefined && command !== "init" && command !== "update") {
    throw new CliArgumentError(
      "CLI_OPTION_NOT_ALLOWED",
      "--worktree may be used only with init or update."
    );
  }
  const revisionAction = command === "task" && ["revise", "replan", "pin-finding"].includes(action ?? "");
  if ((criterionFiles.length > 0 && !(command === "task" && (action === "create" || action === "pin-finding"))) ||
    (criteriaFile !== undefined && !(command === "task" && action === "revise")) ||
    (planFile !== undefined && !(command === "task" && action === "replan")) ||
    (expectedContract !== undefined && !(command === "task" && (action === "revise" || action === "pin-finding"))) ||
    (expectedTreeContract !== undefined && !(command === "task" && action === "replan")) ||
    (reason !== undefined && !revisionAction) ||
    (baseline !== undefined && !(command === "task" && (action === "create" || action === "revise"))))
    throw new CliArgumentError("CLI_OPTION_NOT_ALLOWED", "Acceptance options are not supported by this command.");
  if (revisionAction && (taskId === undefined || evidence.length > 0 || title !== undefined || intent !== undefined || parentTaskId !== undefined || sessionId !== undefined || criteria.length > 0 || base !== undefined ||
    (action === "revise" && (expectedContract === undefined || criteriaFile === undefined || reason === undefined)) ||
    (action === "replan" && (expectedTreeContract === undefined || planFile === undefined || reason === undefined)) ||
    (action === "pin-finding" && (expectedContract === undefined || findingReference === undefined || criterionFiles.length !== 1))))
    throw new CliArgumentError("CLI_MISSING_VALUE", "Acceptance revision requires task, expected contract, payload and reason.");
  if (command === "task") {
    if (
      harness !== undefined ||
      profiles.length > 0 ||
      dryRun ||
      (yes && action !== "advance") ||
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
        (title !== undefined || intent !== undefined ||
          criteria.length > 0 ||
          evidence.length > 0 ||
          // --parent filters the listing, so it cannot name a single target.
          (parentTaskId !== undefined &&
            (taskId !== undefined || sessionId !== undefined)) ||
          (taskId !== undefined && sessionId !== undefined))) ||
      (action === "attach" &&
        (title !== undefined || intent !== undefined ||
          criteria.length > 0 ||
          evidence.length > 0 ||
          parentTaskId !== undefined)) ||
      (action === "complete" &&
        (title !== undefined || intent !== undefined ||
          criteria.length > 0 ||
          sessionId !== undefined ||
          parentTaskId !== undefined)) ||
      ((action === "archive" || action === "export") &&
        (title !== undefined || intent !== undefined ||
          criteria.length > 0 ||
          evidence.length > 0 ||
          sessionId !== undefined ||
          parentTaskId !== undefined)) ||
      (action === "advance" &&
        (taskId === undefined || title !== undefined || intent !== undefined ||
          criteria.length > 0 || evidence.length > 0 || parentTaskId !== undefined ||
          !yes));
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
  if (command === "review" && action === "show" &&
      (yes || rerun || tree || base !== undefined || output !== undefined ||
       scope !== undefined || harness !== undefined || profiles.length > 0 ||
       criteria.length > 0 || evidence.length > 0)) {
    throw new CliArgumentError("CLI_OPTION_NOT_ALLOWED",
      "review show accepts only --task and optional --json; it never runs a reviewer.");
  }
  if (tree && command !== "review") {
    throw new CliArgumentError("CLI_OPTION_NOT_ALLOWED", "--tree may be used only with review.");
  }
  if (intent !== undefined && !(command === "task" && action === "create")) {
    throw new CliArgumentError("CLI_OPTION_NOT_ALLOWED", "--intent may be used only with task create.");
  }
  if (command === "review" && action !== "show" && !yes) {
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
  if (command === "batch" && parentTaskId === undefined) {
    throw new CliArgumentError(
      "CLI_OPTION_NOT_ALLOWED",
      "Batch requires --parent to name the task whose subtasks it covers."
    );
  }
  if (command === "batch" && !yes) {
    throw new CliArgumentError(
      "CLI_OPTION_NOT_ALLOWED",
      "Batch requires --yes to authorize the reviewer sessions."
    );
  }
  if (
    command === "batch" &&
    (harness !== undefined || profiles.length > 0 || dryRun || rerun)
  ) {
    throw new CliArgumentError(
      "CLI_OPTION_NOT_ALLOWED",
      "Batch accepts parent, base, parent-base, width, json, output and yes options."
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
      "worktree accepts only a name, --session, --from, --target-branch, --message and --json."
    );
  }
  if (output !== undefined && command !== "review" && command !== "batch" && command !== "doctor") {
    throw new CliArgumentError(
      "CLI_OPTION_NOT_ALLOWED",
      "--output may be used only with review, batch or doctor.",
      "--output"
    );
  }
  if (output !== undefined && (output.trim() === "" || output.includes("\0"))) {
    throw new CliArgumentError("CLI_INVALID_VALUE", "Invalid value for --output.", "--output");
  }
  if (force && !(command === "worktree" && action === "remove")) {
    throw new CliArgumentError(
      "CLI_OPTION_NOT_ALLOWED",
      "--force may be used only with worktree remove."
    );
  }
  if ((worktreeFrom !== undefined || worktreeTargetBranch !== undefined) &&
    !(command === "worktree" && action === "add")) {
    throw new CliArgumentError(
      "CLI_OPTION_NOT_ALLOWED",
      "--from and --target-branch may be used only with worktree add."
    );
  }
  if (worktreeFrom !== undefined && worktreeFrom.trim() === "") {
    throw new CliArgumentError("CLI_INVALID_VALUE", "Invalid value for --from.", "--from");
  }
  if (worktreeTargetBranch !== undefined &&
    !/^[A-Za-z0-9._/-]{1,128}$/u.test(worktreeTargetBranch)) {
    throw new CliArgumentError("CLI_INVALID_VALUE", `Invalid value for --target-branch: ${worktreeTargetBranch}`, "--target-branch");
  }
  // commit acts as a session (it refuses another's worktree), so it may be told which.
  if (
    command === "worktree" &&
    action !== "add" &&
    action !== "resume" &&
    action !== "commit" &&
    sessionId !== undefined
  ) {
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
    ...(intent === undefined ? {} : { intent }),
    ...(reviewTargets.length === 0 ? {} : { reviewTargets }),
    ...(completionGate === undefined ? {} : { completionGate }),
    ...(office === undefined ? {} : { office }),
    ...(autoRun === undefined ? {} : { autoRun }),
    ...(criteria.length === 0 ? {} : { criteria }),
    ...(criterionFiles.length === 0 ? {} : {criterionFiles}),
    ...(criteriaFile === undefined ? {} : {criteriaFile}),
    ...(planFile === undefined ? {} : {planFile}),
    ...(expectedContract === undefined ? {} : {expectedContract}),
    ...(expectedTreeContract === undefined ? {} : {expectedTreeContract}),
    ...(reason === undefined ? {} : {reason}),
    ...(baseline === undefined ? {} : {baseline}),
    ...(findingReference === undefined ? {} : {findingReference}),
    ...(evidence.length === 0 ? {} : { evidence }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(base === undefined ? {} : { base }),
    ...(parentBase === undefined ? {} : { parentBase }),
    ...(width === undefined ? {} : { width }),
    ...(worktreeFrom === undefined ? {} : { worktreeFrom }),
    ...(worktreeMessage === undefined ? {} : { worktreeMessage }),
    ...(output === undefined ? {} : { output }),
    ...(worktreeTargetBranch === undefined ? {} : { worktreeTargetBranch }),
    ...(checkAuth ? { checkAuth } : {}),
    ...(checkAuthTargets.length === 0 ? {} : { checkAuthTargets }),
    rerun,
    ...(tree ? { tree } : {}),
    dryRun,
    json,
    yes,
    ...(worktree === undefined ? {} : { worktree })
  };
}

function parseRunArgs(argv: readonly string[]): ParsedArgs {
  const actions: readonly RunAction[] = ["start", "status", "logs", "resume", "stop", "respond"];
  if (argv.includes("--help") || argv.includes("-h")) return {command: "help", helpTopic: "run", profiles: [], dryRun: false, json: false, yes: false, rerun: false};
  const action = actions.includes(argv[0] as RunAction) ? argv[0] as RunAction : "start";
  const args: ParsedArgs = {command: "run", action, runAction: action, profiles: [], dryRun: false, json: false, yes: false, rerun: false};
  const seen = new Set<string>();
  let positional: string | undefined;
  for (let i = actions.includes(argv[0] as RunAction) ? 1 : 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith("-")) {
      if (positional !== undefined) throw new CliArgumentError("CLI_UNEXPECTED_ARGUMENT", "Quote the goal as one argument; control actions take one run ID.");
      positional = token; continue;
    }
    if (seen.has(token)) duplicate(token);
    seen.add(token);
    if (token === "--json") {args.json = true; continue;}
    if (token === "--wait") {args.wait = true; continue;}
    if (!["--host", "--goal-file", "--time-budget", "--jobs", "--question-id", "--answer", "--answer-file"].includes(token))
      throw new CliArgumentError("CLI_UNKNOWN_OPTION", `Unknown run option: ${token}`, token);
    const value = readOptionValue(argv, i++, token);
    switch (token) {
      case "--host":
        if (value !== "claude" && value !== "codex") invalidValue(token, value);
        args.host = value as "claude" | "codex"; break;
      case "--goal-file": args.goalFile = value; break;
      case "--question-id": args.questionId = value; break;
      case "--answer": args.answer = value; break;
      case "--answer-file": args.answerFile = value; break;
      case "--jobs":
        if (value !== "1" && value !== "2") invalidValue(token, value);
        args.jobs = Number(value); break;
      case "--time-budget": {
        const match = value.match(/^([1-9][0-9]*)(s|m|h)$/u);
        if (match === null) invalidValue(token, value);
        const ms = Number(match![1]) * ({s: 1000, m: 60000, h: 3600000}[match![2] as "s" | "m" | "h"]);
        if (!Number.isSafeInteger(ms) || ms > 86400000) invalidValue(token, value);
        args.timeBudgetMs = ms; break;
      }
    }
  }
  if (action === "start") {
    args.goal = positional;
    if ((args.goal === undefined) === (args.goalFile === undefined)) throw new CliArgumentError("RUN_GOAL_REQUIRED", "Provide exactly one quoted goal or --goal-file.");
    if (args.host === undefined) throw new CliArgumentError("RUN_HOST_REQUIRED", "Choose --host claude or --host codex.");
    if (args.questionId !== undefined || args.answer !== undefined || args.answerFile !== undefined) throw new CliArgumentError("CLI_INVALID_OPTION", "Answer options require run respond.");
  } else {
    if (positional === undefined || !/^[a-z][a-z0-9-]{7,63}$/u.test(positional)) throw new CliArgumentError("RUN_ID_REQUIRED", "Control actions require a valid run ID.");
    args.runId = positional;
    if (args.host !== undefined || args.goalFile !== undefined || args.jobs !== undefined || args.timeBudgetMs !== undefined || args.wait)
      throw new CliArgumentError("CLI_INVALID_OPTION", "Start options are not accepted by run control actions.");
    if (action === "respond") {
      if (args.questionId === undefined || (args.answer === undefined) === (args.answerFile === undefined))
        throw new CliArgumentError("RUN_ANSWER_REQUIRED", "Respond requires --question-id and exactly one --answer or --answer-file.");
    } else if (args.questionId !== undefined || args.answer !== undefined || args.answerFile !== undefined)
      throw new CliArgumentError("CLI_INVALID_OPTION", "Answer options require run respond.");
  }
  return args;
}
