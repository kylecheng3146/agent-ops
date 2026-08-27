import { CliArgumentError, parseArgs, type ParsedArgs } from "./args.js";
import { AgentOpsError } from "../../../runtime/src/fs/paths.js";
import {
  errorEnvelope,
  okEnvelope,
  writeEnvelope,
  type CliEnvelope,
  type OutputSink
} from "./output.js";
import { completeInitChoices, type WizardIo } from "./wizard.js";
import { probeReviewTarget } from "../../../runtime/src/review/probe.js";
import type { CommandRegistry } from "./commands/index.js";
import { BANNER } from "./ui.js";

export interface CliIo extends OutputSink, WizardIo {}

export interface CliServices {
  version: string;
  registry?: CommandRegistry;
  execute?(args: ParsedArgs): Promise<CliEnvelope<unknown>>;
}

export function renderWelcome(color: boolean): string {
  const cyan = color ? "\u001b[36m" : "";
  const bold = color ? "\u001b[1m" : "";
  const reset = color ? "\u001b[0m" : "";
  return `${cyan}${bold}${BANNER}${reset}\n\n`;
}

export const HELP_TEXT = `Usage: agent-ops <command> [options]

Run \`agent-ops\` without arguments in a terminal to start the interactive setup wizard.

Commands:
  init       Plan or install agent-ops
  config explain
             Inspect effective configuration provenance
  trust <status|grant|revoke>
             Manage explicit repository trust
  doctor     Diagnose an installation
  update     Update managed artifacts
  uninstall  Remove managed artifacts
  task <create|status|attach|complete|archive|export>
             Manage independent task acceptance state
  verify     Run configured verification
  review     Run an independent review

Options:
  --scope <project|user>
  --harness <all|both|claude|codex|opencode|comma-separated>  Init/update
  --hook-target <harness=surface-id>  Repeatable advanced init/update option
  --profile <core|advisory|guardrails|loop>  Repeatable
  --review-target <codex|agy|claude>  Repeatable init option; external review
                                      targets in fallback-chain order
  --check-auth                        Doctor only: probe each review target's
                                      authentication with one real call
  --task <id>
  --parent <task-id>                  Task create: record a subtask of this
                                      task; task status: list its subtasks
  --target-version <version>          Update target version (offline-capable)
  --title <text>
  --criterion <json>                    Repeatable
  --evidence <criterion-id=reference>   Repeatable
  --session <id>
  --base <git-ref>                    Verify/review a clean committed range
  --dry-run
  --json
  --yes
  --help
  --version
`;

function wantsJson(argv: readonly string[]): boolean {
  return argv.includes("--json");
}

function writeAndReturn(
  io: CliIo,
  envelope: CliEnvelope<unknown>,
  json: boolean,
  exitCode: number
): number {
  writeEnvelope(io, envelope, json);
  return exitCode;
}

export async function runCli(
  argv: readonly string[],
  io: CliIo,
  services: CliServices
): Promise<number> {
  const launchesWizard = argv.length === 0 && io.isTTY;
  const effectiveArgv = launchesWizard ? ["init"] : argv;
  if (launchesWizard) {
    io.writeStdout(
      renderWelcome(
        process.env.NO_COLOR === undefined && process.env.TERM !== "dumb"
      )
    );
  }
  const json = wantsJson(effectiveArgv);
  let args: ParsedArgs;

  try {
    args = parseArgs(effectiveArgv);
  } catch (error) {
    if (error instanceof CliArgumentError) {
      return writeAndReturn(
        io,
        errorEnvelope(error.code, error.message),
        json,
        2
      );
    }
    return writeAndReturn(
      io,
      errorEnvelope("CLI_INTERNAL_ERROR", "Unable to parse command arguments."),
      json,
      1
    );
  }

  if (args.command === "help") {
    return writeAndReturn(
      io,
      okEnvelope("CLI_HELP", { text: HELP_TEXT }),
      args.json,
      0
    );
  }
  if (args.command === "version") {
    return writeAndReturn(
      io,
      okEnvelope("CLI_VERSION", { version: services.version }),
      args.json,
      0
    );
  }

  try {
    if (args.command === "init") {
      args = await completeInitChoices(
        args,
        args.json ? { ...io, isTTY: false } : io,
        {
          probeReviewTarget: async (target) =>
            (await probeReviewTarget(target, {
              cwd: process.cwd(),
              deep: true
            })) === "ok",
          warn: (message) => io.writeStderr(`${message}\n`)
        }
      );
    }
    const execute =
      args.command === "help" || args.command === "version"
        ? services.execute
        : services.registry?.get(args.command) ?? services.execute;
    if (execute === undefined) {
      return writeAndReturn(
        io,
        errorEnvelope(
          "CLI_COMMAND_UNAVAILABLE",
          `Command is not implemented yet: ${args.command}`
        ),
        args.json,
        1
      );
    }
    const result = await execute(args);
    return writeAndReturn(
      io,
      result,
      args.json,
      result.status === "ok" ? 0 : 1
    );
  } catch (error) {
    if (error instanceof CliArgumentError) {
      return writeAndReturn(
        io,
        errorEnvelope(error.code, error.message),
        args.json,
        2
      );
    }
    if (error instanceof AgentOpsError) {
      return writeAndReturn(
        io,
        errorEnvelope(error.code, error.message),
        args.json,
        1
      );
    }
    return writeAndReturn(
      io,
      errorEnvelope("CLI_INTERNAL_ERROR", "Command execution failed."),
      args.json,
      1
    );
  }
}
