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

export interface ParsedArgs {
  command: CliCommand;
  action?: ConfigAction;
  scope?: InstallScope;
  harness?: Harness;
  profiles: Profile[];
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
  let action: ConfigAction | undefined;
  let scope: InstallScope | undefined;
  let harness: Harness | undefined;
  const profiles: Profile[] = [];
  let dryRun = false;
  let json = false;
  let yes = false;
  let helpSeen = false;
  let versionSeen = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;

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

  return {
    command,
    ...(action === undefined ? {} : { action }),
    ...(scope === undefined ? {} : { scope }),
    ...(harness === undefined ? {} : { harness }),
    profiles,
    dryRun,
    json,
    yes
  };
}
