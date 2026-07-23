import type { Harness, InstallScope, Profile } from "../../../runtime/src/contracts.js";

export const COMMAND_NAMES = [
  "init",
  "config",
  "trust",
  "doctor",
  "update",
  "uninstall",
  "task",
  "verify",
  "review"
] as const;

const COMMAND_SET = new Set<string>(COMMAND_NAMES);
const SCOPES = new Set<string>(["project", "user"]);
const HARNESSES = new Set<string>(["both", "claude", "codex"]);
const PROFILES = new Set<string>(["advisory", "core", "guardrails"]);

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
export type CliAction = ConfigAction | TaskAction | TrustAction;

export interface ParsedArgs {
  command: CliCommand;
  action?: CliAction;
  scope?: InstallScope;
  harness?: Harness;
  profiles: Profile[];
  taskId?: string;
  title?: string;
  criteria?: string[];
  evidence?: string[];
  sessionId?: string;
  dryRun: boolean;
  json: boolean;
  yes: boolean;
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

export function parseArgs(argv: readonly string[]): ParsedArgs {
  let command: CliCommand | undefined;
  let action: CliAction | undefined;
  let scope: InstallScope | undefined;
  let harness: Harness | undefined;
  let taskId: string | undefined;
  let title: string | undefined;
  let sessionId: string | undefined;
  const profiles: Profile[] = [];
  const criteria: string[] = [];
  const evidence: string[] = [];
  let dryRun = false;
  let json = false;
  let yes = false;
  let helpSeen = false;
  let versionSeen = false;

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
        if (!HARNESSES.has(value)) {
          invalidValue(token, value);
        }
        harness = value as Harness;
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
      case "--task": {
        if (taskId !== undefined) {
          duplicate(token);
        }
        taskId = readOptionValue(argv, index, token);
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
  if ((helpSeen || versionSeen) && command !== undefined) {
    throw new CliArgumentError(
      "CLI_CONFLICTING_ACTION",
      "Global help or version cannot be combined with a command."
    );
  }
  if (helpSeen || versionSeen) {
    if (
      scope !== undefined ||
      harness !== undefined ||
      profiles.length > 0 ||
      taskId !== undefined ||
      title !== undefined ||
      criteria.length > 0 ||
      evidence.length > 0 ||
      sessionId !== undefined ||
      dryRun ||
      yes
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
    (hasTaskTargetOptions || hasTaskMutationOptions)
  ) {
    throw new CliArgumentError(
      "CLI_OPTION_NOT_ALLOWED",
      "Task target options may be used only with task or verify."
    );
  }
  if (command === "task") {
    if (
      harness !== undefined ||
      profiles.length > 0 ||
      dryRun ||
      yes
    ) {
      throw new CliArgumentError(
        "CLI_OPTION_NOT_ALLOWED",
        "Task commands do not accept harness, profile, dry-run, or yes options."
      );
    }
    const taskOptionInvalid =
      (action === "create" &&
        (taskId !== undefined ||
          evidence.length > 0 ||
          sessionId !== undefined)) ||
      (action === "status" &&
        (title !== undefined ||
          criteria.length > 0 ||
          evidence.length > 0 ||
          (taskId !== undefined && sessionId !== undefined))) ||
      (action === "attach" &&
        (title !== undefined ||
          criteria.length > 0 ||
          evidence.length > 0)) ||
      (action === "complete" &&
        (title !== undefined ||
          criteria.length > 0 ||
          sessionId !== undefined)) ||
      ((action === "archive" || action === "export") &&
        (title !== undefined ||
          criteria.length > 0 ||
          evidence.length > 0 ||
          sessionId !== undefined));
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
      "Verify accepts only scope, task or session, and json options."
    );
  }

  return {
    command,
    ...(action === undefined ? {} : { action }),
    ...(scope === undefined ? {} : { scope }),
    ...(harness === undefined ? {} : { harness }),
    profiles,
    ...(taskId === undefined ? {} : { taskId }),
    ...(title === undefined ? {} : { title }),
    ...(criteria.length === 0 ? {} : { criteria }),
    ...(evidence.length === 0 ? {} : { evidence }),
    ...(sessionId === undefined ? {} : { sessionId }),
    dryRun,
    json,
    yes
  };
}
