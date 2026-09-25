import {
  CliArgumentError,
  parseArgs,
  type ParsedArgs,
  type TopLevelCommand
} from "./args.js";
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
  allow-stop Grant one fingerprint-bound completion-gate Stop permit (requires --session)
  agy-run    Run headless agy with a process-exit completion recheck
  worktree <add|finish|list|resume|remove>
             Give one session its own Git worktree for parallel work

Options:
  --scope <project|user>
  --harness <all|both|agy|claude|codex|opencode|comma-separated>  Init/update/uninstall; review uses configured targets
  --hook-target <harness=surface-id>  Repeatable advanced init/update option
  --profile <core|advisory|guardrails|loop>  Repeatable
  --review-target <codex|agy|claude>  Repeatable init option; review pair order
  --completion-gate                  Init only: enable the project-loop completion gate
  --worktree <auto|off>              Init/update: configure session worktree isolation
  --check-auth                        Doctor only: probe selected review targets'
                                      authentication with one real call
  --check-auth-target <target>        Repeatable doctor filter with --check-auth
  --task <id>
  --parent <task-id>                  Task create: record a subtask of this
                                      task; task status: list its subtasks
  --target-version <version>          Update target version (offline-capable)
  --title <text>
  --criterion <json>                    Repeatable
  --evidence <criterion-id=reference>   Repeatable
  --session <id>
  --base <git-ref>                    Verify/review/complete a clean committed range
  --dry-run
  --json
  --yes
  --help
  --version
`;

/**
 * What `<command> --help` answers. Each entry states the option shapes that
 * command actually accepts, because the global list cannot say which options
 * belong to which command — and a caller that guesses learns only by being
 * rejected.
 */
export const COMMAND_HELP_TEXT: Readonly<Record<TopLevelCommand, string>> = {
  init: `Usage: agent-ops init [options]

Plan or install agent-ops into this repository.

Options:
  --scope <project|user>
  --harness <all|both|agy|claude|codex|opencode|comma-separated>
  --hook-target <harness=surface-id>   Repeatable
  --profile <core|advisory|guardrails|loop>  Repeatable
  --review-target <codex|agy|claude>   Repeatable, in fallback-chain order
  --completion-gate                    Enable the project-loop completion gate
  --worktree <auto|off>                Configure session worktree isolation
  --dry-run                            Print the plan without writing
  --json
  --yes
`,
  config: `Usage: agent-ops config explain [options]

Show where each effective configuration value came from.

Options:
  --scope <project|user>
  --json
`,
  trust: `Usage: agent-ops trust <status|grant|revoke> [options]

Manage the explicit trust record this repository's commands require.

Options:
  --scope <project|user>
  --json
  --yes
`,
  doctor: `Usage: agent-ops doctor [options]

Diagnose the installation and report remediation for each failed check.

Options:
  --scope <project|user>
  --harness <all|both|agy|claude|codex|opencode|comma-separated>
  --check-auth   Probe each review target's authentication with one real call
  --json
`,
  update: `Usage: agent-ops update [options]

Update managed artifacts to this toolkit version.

Options:
  --scope <project|user>
  --harness <all|both|agy|claude|codex|opencode|comma-separated>
  --target-version <version>   Offline-capable update target
  --worktree <auto|off>        Configure session worktree isolation
  --dry-run
  --json
  --yes
`,
  uninstall: `Usage: agent-ops uninstall [options]

Remove managed artifacts, leaving foreign handlers in place.

Options:
  --scope <project|user>
  --harness <all|both|agy|claude|codex|opencode|comma-separated>
  --dry-run
  --json
  --yes
`,
  task: `Usage: agent-ops task <create|status|attach|complete|archive|export> [options]

Manage independent task acceptance state. Task commands accept none of
--harness, --profile, --dry-run or --yes.

Options:
  --title <text>                        create
  --criterion <json>                    create, repeatable, two to five total
  --parent <task-id>                    create: record a subtask; status: list subtasks
  --task <id>                           status, attach, complete, archive, export
  --session <id>                        attach, status
  --evidence <criterion-id=reference>   complete, repeatable
  --base <git-ref>                      complete: a clean committed range
  --json

Each --criterion is one JSON object with exactly these keys:

  {"id":"kebab-id","description":"what must hold","verifierIds":["node-test"]}

Every criterion needs at least one verifierIds entry naming a verification
command id configured in .agent-ops/config.json. No other key is accepted.
`,
  verify: `Usage: agent-ops verify [options]

Run the configured verification commands and record their evidence.

Options:
  --task <id>
  --session <id>
  --base <git-ref>   Verify a clean committed range
  --json
`,
  review: `Usage: agent-ops review --task <id> --yes [options]

Run the complete task-bound review: one necessary reviewer followed by one
fresh adversarial reviewer from the configured pair.

Options:
  --task <id>          Required task whose original criteria are reviewed
  --base <git-ref>     Review a clean committed range
  --json
  --yes                Required authorization for both reviewer sessions
`,
  "allow-stop": `Usage: agent-ops allow-stop --session <id> [options]

Grant one fingerprint-bound Stop permit for the completion gate, on agy or
Claude Code. Requires user approval: the PreToolUse hook asks the user, so an
agent cannot self-authorize it.

Options:
  --session <id>   Required
  --json
`,
  worktree: `Usage: agent-ops worktree <add|finish|resume|remove> <name> [options]
       agent-ops worktree list [--json]

Give one writing session its own Git worktree, so parallel sessions stop
voiding each other's verification and review. Run it from the main checkout.

  add <name>   Create .worktrees/<name> on branch agent-ops/<name> from HEAD,
               copy the ignored agent-ops files and .worktreeinclude matches,
               inherit trust for an identical config, run worktree.setup, and
               point the session's completion gate at the new worktree.
  finish <name>
               Once its task is complete, fast-forward the main checkout's
               branch to the worktree's (after a clean rebase and
               re-verification if the branch moved), record the task in
               git notes, and remove the worktree. One finish runs at a time.
  list         Every agent-ops worktree: session, commits ahead, uncommitted
               changes, task status and last activity.
  resume <name>
               Hand a worktree whose session ended to --session <id>.
  remove <name>
               Delete the worktree and its branch. Uncommitted or unmerged
               work needs --force, which the completion gate asks the user
               about.

Options:
  --session <id>   add, resume: the conversation that will work there (required)
  --force          remove: discard uncommitted or unmerged work
  --json
`
};

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
    const topic = args.helpTopic;
    return writeAndReturn(
      io,
      okEnvelope("CLI_HELP", {
        text: topic === undefined ? HELP_TEXT : COMMAND_HELP_TEXT[topic],
        ...(topic === undefined ? {} : { topic })
      }),
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
      result.status === "ok"
        ? 0
        : result.code === "REVIEW_NOT_RUN"
          ? 2
          : 1
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
