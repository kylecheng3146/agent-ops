import {
  GUARDRAIL_RULE_IDS,
  type CommandGuardrailInput,
  type GuardrailDecision
} from "./types.js";

const AMBIGUOUS_TARGET = /(?:^|[^\\])(?:\$\{?|\*|\?|\[)/;
const WINDOWS_ROOT = /^[A-Za-z]:\/?$/;

function executableName(command: string): string {
  return command.split(/[\\/]/).at(-1)?.replace(/\.exe$/i, "").toLowerCase() ?? "";
}

function isShortFlag(argument: string, flag: string): boolean {
  return (
    argument.startsWith("-") &&
    !argument.startsWith("--") &&
    argument.slice(1).includes(flag)
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
      ? argument === "--recursive" || isShortFlag(argument, "r")
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
  if (targets.some((target) => AMBIGUOUS_TARGET.test(target))) {
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
    subcommand.args.some(
      (argument) =>
        argument === "--force" ||
        argument.startsWith("--force-with-lease") ||
        isShortFlag(argument, "f")
    )
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
