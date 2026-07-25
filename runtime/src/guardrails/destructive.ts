import {
  GUARDRAIL_RULE_IDS,
  type CommandGuardrailInput,
  type GuardrailDecision
} from "./types.js";

const AMBIGUOUS_TARGET = /(?:^|[^\\])(?:\$\{?|\*|\?|\[)/;
const PUSH_LONG_OPTIONS_WITH_VALUES = new Set([
  "--exec",
  "--push-option",
  "--receive-pack",
  "--recurse-submodules",
  "--repo"
]);
const WINDOWS_ENVIRONMENT_TARGET = /%[^%\s]+%/;
const TILDE_TARGET = /^~[A-Za-z0-9._-]*(?:[\\/]|$)/;
const WINDOWS_ROOT = /^[A-Za-z]:\/?$/;

function executableName(command: string): string {
  return command.split(/[\\/]/).at(-1)?.replace(/\.exe$/i, "").toLowerCase() ?? "";
}

function isShortFlag(
  argument: string,
  flag: string,
  caseInsensitive = false
): boolean {
  const flags = argument.slice(1);
  return (
    argument.startsWith("-") &&
    !argument.startsWith("--") &&
    (caseInsensitive
      ? flags.toLowerCase().includes(flag.toLowerCase())
      : flags.includes(flag))
  );
}

function hasAmbiguousExpansion(target: string): boolean {
  return (
    AMBIGUOUS_TARGET.test(target) ||
    WINDOWS_ENVIRONMENT_TARGET.test(target) ||
    TILDE_TARGET.test(target)
  );
}

function normalizeTarget(target: string): string {
  if (target.length === 0) {
    return target;
  }
  const portable = target.replace(/\\/g, "/");
  const drive = /^([A-Za-z]:)(?:\/|$)/.exec(portable)?.[1];
  const absolute = drive !== undefined || portable.startsWith("/");
  const remainder =
    drive === undefined
      ? portable.replace(/^\/+/, "")
      : portable.slice(drive.length).replace(/^\/+/, "");
  const segments: string[] = [];
  for (const segment of remainder.split("/")) {
    if (segment.length === 0 || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (segments.length > 0 && segments.at(-1) !== "..") {
        segments.pop();
      } else if (!absolute) {
        segments.push(segment);
      }
      continue;
    }
    segments.push(segment);
  }
  const normalized = segments.join("/");
  if (drive !== undefined) {
    return normalized.length === 0 ? `${drive}/` : `${drive}/${normalized}`;
  }
  if (absolute) {
    return normalized.length === 0 ? "/" : `/${normalized}`;
  }
  return normalized.length === 0 ? "." : normalized;
}

function isBroadTarget(target: string): boolean {
  const normalized = normalizeTarget(target);
  return (
    normalized === "/" ||
    normalized === "." ||
    normalized === ".." ||
    normalized === "~" ||
    WINDOWS_ROOT.test(normalized)
  );
}

function removalDecision(
  command: string,
  args: readonly string[]
): GuardrailDecision {
  const isRm = command === "rm";
  const isPowerShellRemove = command === "remove-item";
  const isWindowsRemove = command === "rd" || command === "rmdir";
  if (!isRm && !isPowerShellRemove && !isWindowsRemove) {
    return { action: "allow" };
  }

  const recursive = args.some((argument) =>
    isRm
      ? argument === "--recursive" || isShortFlag(argument, "r", true)
      : isPowerShellRemove
        ? argument.toLowerCase() === "-recurse"
        : argument.toLowerCase() === "/s"
  );
  if (!recursive) {
    return { action: "allow" };
  }

  const targets = args.filter((argument) => {
    if (argument === "--") {
      return false;
    }
    if (isWindowsRemove) {
      return !argument.startsWith("/");
    }
    return !argument.startsWith("-");
  });
  if (targets.some(isBroadTarget)) {
    return {
      action: "block",
      ruleId: GUARDRAIL_RULE_IDS.broadDelete,
      reason: "Recursive deletion of a broad filesystem target is blocked.",
      saferAlternative:
        "Delete an explicitly named project-relative path after reviewing its resolved value."
    };
  }
  if (targets.some(hasAmbiguousExpansion)) {
    return {
      action: "warn",
      ruleId: GUARDRAIL_RULE_IDS.ambiguousTarget,
      reason:
        "The recursive deletion target contains unresolved environment or glob expansion."
    };
  }
  return { action: "allow" };
}

function gitSubcommand(args: readonly string[]): {
  name: string | undefined;
  args: readonly string[];
} {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    if (argument === "-C" || argument === "-c") {
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) {
      continue;
    }
    return { name: argument, args: args.slice(index + 1) };
  }
  return { name: undefined, args: [] };
}

function hasDestructivePushArgument(args: readonly string[]): boolean {
  let repositorySupplied = false;
  const operands: string[] = [];
  let optionsEnded = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    if (optionsEnded) {
      operands.push(argument);
      continue;
    }
    if (argument === "--") {
      optionsEnded = true;
      continue;
    }
    if (argument.startsWith("--")) {
      const equalsIndex = argument.indexOf("=");
      const option =
        equalsIndex === -1 ? argument : argument.slice(0, equalsIndex);
      if (
        option === "--force" ||
        option === "--force-with-lease" ||
        option === "--mirror"
      ) {
        return true;
      }
      if (PUSH_LONG_OPTIONS_WITH_VALUES.has(option)) {
        if (option === "--repo") {
          repositorySupplied = true;
        }
        if (equalsIndex === -1) {
          index += 1;
        }
      }
      continue;
    }
    if (argument.startsWith("-") && argument !== "-") {
      const flags = argument.slice(1);
      for (let flagIndex = 0; flagIndex < flags.length; flagIndex += 1) {
        const flag = flags[flagIndex];
        if (flag === "f") {
          return true;
        }
        if (flag === "o") {
          if (flagIndex === flags.length - 1) {
            index += 1;
          }
          break;
        }
      }
      continue;
    }
    operands.push(argument);
  }

  const refspecs = repositorySupplied ? operands : operands.slice(1);
  return refspecs.some(
    (argument) => argument.startsWith("+") && argument.length > 1
  );
}

function gitDecision(args: readonly string[]): GuardrailDecision {
  const subcommand = gitSubcommand(args);
  if (subcommand.name === "reset" && subcommand.args.includes("--hard")) {
    return {
      action: "block",
      ruleId: GUARDRAIL_RULE_IDS.reset,
      reason: "A destructive Git hard reset can discard uncommitted work.",
      saferAlternative:
        "Create a backup branch or use git revert instead of git reset --hard."
    };
  }
  if (
    subcommand.name === "push" &&
    hasDestructivePushArgument(subcommand.args)
  ) {
    return {
      action: "block",
      ruleId: GUARDRAIL_RULE_IDS.forcePush,
      reason: "A forced Git push can overwrite shared remote history.",
      saferAlternative:
        "Push without force, or use a bounded reviewed exception for the exact scope."
    };
  }
  return { action: "allow" };
}

export function evaluateDestructiveCommand(
  input: Pick<CommandGuardrailInput, "args" | "command">
): GuardrailDecision {
  const command = executableName(input.command);
  if (command === "git") {
    return gitDecision(input.args);
  }
  return removalDecision(command, input.args);
}
