import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

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
  task <create|status|attach|revise|replan|pin-finding|advance|complete|archive|export>
             Manage independent task acceptance state
  verify     Run configured verification
  review     Run an independent review or show recorded reports
  run        Start or control a supervised Claude/Codex native goal
  office     Open the local pixel office (Preview; opt-in)
  followup   Collect and process retained review findings and risk observations
  escapes    Report escaped bugs, gate catches and learned rules (read-only)
  batch      Verify and review a parent task's subtasks together
  allow-stop Grant one fingerprint-bound completion-gate Stop permit (requires --session)
  agy-run    Run headless agy with a process-exit completion recheck
  worktree <add|finish|list|resume|remove>
             Give one session its own Git worktree for parallel work

Options:
  --scope <project|user>
  --harness <all|both|agy|claude|codex|opencode|comma-separated>  Init/update/uninstall; review uses configured targets
  --hook-target <harness=surface-id>  Repeatable advanced init/update option
  --profile <core|advisory|guardrails|loop|run>  Repeatable
  --review-target <codex|agy|claude>  Repeatable init option; review pair order
  --completion-gate                  Init only: enable the project-loop completion gate
  --office <on|off>                   Init/update: enable or disable Office (Preview)
  --auto-run <on|off>                 Update: add or remove the run profile (loop stays)
  --worktree <auto|off>              Init/update: configure session worktree isolation
  --check-auth                        Doctor only: probe selected review targets'
                                      authentication with one real call
  --check-auth-target <target>        Repeatable doctor filter with --check-auth
  --task <id>
  --parent <task-id>                  Task create: record a subtask of this
                                      task; task status: list its subtasks;
                                      batch: the task whose subtasks it covers
  --parent-base <git-ref>             Batch only: base for the parent task
  --width <n>                         Batch only: reviews allowed at once (default 2)
  --target-version <version>          Update target version (offline-capable)
  --title <text>
  --criteria                          Review only: one pre-edit advisory, no time budget
  --criterion <json>                    Repeatable
  --evidence <criterion-id=reference>   Repeatable
  --session <id>
  --base <git-ref>                    Verify/review/batch/complete a clean committed range
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
  followup: `Usage: agent-ops followup [list] [--json]
       agent-ops followup <show|reopen> <followup-id> [--json]
       agent-ops followup <import|sync> [--json]
       agent-ops followup <accept|defer> <followup-id> --reason <text> [--json]
       agent-ops followup clarify <followup-id> --finding-file <json> --reason <text> [--json]
       agent-ops followup process <followup-id> --host <claude|codex> [--review-only-reason <text>] [--json]

Receipt collection and history import are metadata-only: no model calls or repairs.
State is private under the Git common directory, shared by linked worktrees.
Text observations require a concrete nonblocking ReviewFinding JSON clarification
(severity, blocking=false, title, details, locations, evidence, recommendation,
criterionIds). Accept/defer require a reason; neither resolves the finding.
Reopen retains history. Process again to revalidate a selected candidate.
Process authorizes independent current-source assessment and a new bounded native
repair only when conclusively PRESENT. UNKNOWN stays unresolved. Native start
refusals retain the item and exact reason; macOS, clean main, checked-out target,
trust, run policy and native controls still apply. Run through the trusted outer
host as: env -u CODEX_SANDBOX_NETWORK_DISABLED agent-ops followup process ...
ABSENT closure requires an explicit justified review-only contract and two fresh
reviews. Reproducible bugs require corresponding behavioral red-to-green proof.
Closure records the exact commit and finding-specific evidence; generic PASS,
changed paths, completed run status, acceptance and deferral cannot resolve.
Collection warnings are advisory and retryable with followup import.
`,
  escapes: `Usage: agent-ops escapes [--json]

Read-only Escape Loop report: misses per gate from the tracked
.agent-ops-escapes ledger, gate catches from this machine's local log, origin
and link-state mix, and per-rule fire/included/excluded counts with retirement
candidates. Counts are raw with n; fewer than 10 observations are marked
insufficient-data. It never writes files and fails open.
`,
  office: `Usage: agent-ops office [--json]

Office (Preview) is opt-in: select it during init/update or run
agent-ops update --office on. Disable with --office off. A missing choice is off.

Print the URL of this repository's office: a read-only pixel page on
127.0.0.1. All run teams and ordinary sessions appear in a single-screen room
overview; walk the Supervisor with arrows/WASD or click a room for details.
Switch Chinese/English in the header. Movement and animation run locally.
When enabled, managed sessions start the shared server automatically. A new Office opens the
browser once; later sessions reuse it. It exits after 10 minutes without active
runs or sessions. Recently completed rooms remain for at most 2 hours.
The URL carries an access token; do not share it.
`,
  run: `Usage: agent-ops run [start] "<goal>" --host <claude|codex> [--jobs <1|2>] [--wait] [--json]
       agent-ops run [start] --goal-file <path> --host <claude|codex>
       agent-ops run <status|logs|resume|stop> <run-id> [--json]
       agent-ops run resume <run-id> [--retry-approval <auth-event-id>]... [--json]
       agent-ops run resume <run-id> --retry-delivery <task-id> [--json]
       agent-ops run respond <run-id> --question-id <id> <--answer <text>|--answer-file <path>> [--json]

New runs have no total time cap. Manual resume upgrades legacy finite runs and keeps accounting.
Command/review timeouts, provider limits and stop controls remain effective.
Native goal state is observational. Completion requires current verification,
two fresh reviews, task completion and a target-bound integration receipt.
--retry-approval explicitly retries an intact Codex approval-review usage-limit
failure. Original denials remain recorded; every command needs fresh approval.
--retry-delivery requeues one stopped child blocked by interrupted handoff proof.
Inspect and repair the harness cause first. History is retained; fresh native
generation, verification and delivery are required. It grants no command approval.
Status includes phase, original cause, recorded sealed proof, cleanup state,
resumability and remediation. Resume revalidates authority and sealed artifacts;
receipt-bound recovery executes only missing cleanup steps. Resolve the saved
blocker before retrying: unchanged cleanup inputs are refused.
`,
  init: `Usage: agent-ops init [options]

Plan or install agent-ops into this repository.

Options:
  --scope <project|user>
  --harness <all|both|agy|claude|codex|opencode|comma-separated>
  --hook-target <harness=surface-id>   Repeatable
  --profile <core|advisory|guardrails|loop|run>  Repeatable
  --review-target <codex|agy|claude>   Repeatable, in fallback-chain order
  --completion-gate                    Enable the project-loop completion gate
  --office <on|off>                   Office (Preview); default off, update preserves choice
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
  --output <file>
                 Write the JSON envelope to <file> (mode 0600) and print one
                 summary line, so no shell redirect is needed
  --json
`,
  update: `Usage: agent-ops update [options]

Update managed artifacts to this toolkit version.

Options:
  --scope <project|user>
  --harness <all|both|agy|claude|codex|opencode|comma-separated>
  --target-version <version>   Offline-capable update target
  --office <on|off>           Office (Preview); preserve choice unless supplied
  --auto-run <on|off>          Add or remove the run profile (loop stays); preserve unless supplied
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
  task: `Usage: agent-ops task <create|status|attach|revise|replan|pin-finding|advance|complete|archive|export> [options]

Manage independent task acceptance state. Task commands accept none of
--harness, --profile or --dry-run. Only advance accepts --yes.

Options:
  --title <text>                        create
  --goal <text>                         create: immutable original issue/goal
  --debug                               create: bug fix; needs --goal and a behavioral criterion with redCheckIds
  --intent <text>                       create: intended behavior and constraints before editing
  --criterion <json>                    create, repeatable, two to five total
  --criterion-file <path>               create: one criterion object, repeatable; pin-finding: exactly one
  --criteria-file <path>                revise: replacement criterion array
  --surface-file <path>                 create (required), revise: EVIDENCE-SURFACE-001
                                        audit JSON, or {"covers":[surface-id]} under a surfaced parent
  --escape-of <commit>                  create, revise: the commit this bug escaped from (Escape Loop)
  --escape-label <label>                with --escape-of: requirement|surface|scenario|criteria|verify|review|flagged|out-of-model
  --escape-receipt <id>                 with --escape-of: link this local finish receipt instead of resolving one
  --escape-fix <commit>                 with --escape-of: backfill; missed paths come from this past fix commit
  --escape-promote <runner:check>       with --escape-of: the red-to-green check proving a criteria/verify escape
  --plan-file <path>                    replan: split-task array with requirement mappings
  --expected-contract <hash>            revise, pin-finding: current task contract from status
  --expected-tree-contract <hash>       replan: current tree contract from status
  --reason <text>                       required for revise/replan; optional for pin-finding
  --baseline <git-ref>                  create: baseline for typed criteria; revise: move every typed baseline
  --parent <task-id>                    create: record a subtask; status: list subtasks
  --task <id>                           status, attach, revise, replan, pin-finding, complete, archive, export, advance
  --session <id>                        create, attach, status, advance
  --evidence <criterion-id=reference>   complete, repeatable
  --base <git-ref>                      complete: a clean committed range
  --yes                                 advance: authorize the two review sessions
  --json

Each --criterion or --criterion-file supplies one criterion object. Legacy example:

  {"id":"kebab-id","description":"what must hold","verifierIds":["node-test"]}

Each legacy criterion needs at least one verifierIds entry naming a verification
command id configured in .agent-ops/config.json. Typed criteria additionally
accept an acceptance object: mode (behavioral, invariant or review-only),
bindings and optional baselineCommit/reviewOnlyReason. Mechanical bindings name
configured acceptance runner IDs, checkIds (the checks this criterion needs;
other runner output is ignored), committed materials and optional
redCheckIds; tasks cannot supply commands. Creation freezes the baseline.
Review-only example (mandatory repository policy commands still run):

  {"id":"judgment","description":"Meets the original goal","verifierIds":[],"acceptance":{"mode":"review-only","bindings":[],"reviewOnlyReason":"Requires independent judgment"}}

Pin a saved finding with task pin-finding --task <id> <report-digest:index>
--expected-contract <hash> --criterion-file <path>. Revise/replan preserve the
original goal and existing baselines unless revise --baseline moves them all.
A revise that keeps the criteria keeps verification; every revise needs review.
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
       agent-ops review --criteria --task <id> --yes [--rerun]
       agent-ops review show --task <id> [--json]

Run the complete task-bound review: one necessary reviewer followed by one
fresh adversarial reviewer from the configured pair. Show reads recorded
reports without running a reviewer, including from the main checkout.
Criteria mode runs/reads one pre-edit advisory, with no time/token budget;
only --rerun starts another attempt. It never replaces final proof.

Options:
  --task <id>          Required task whose original criteria are reviewed
  --tree               Cover this task and every non-archived descendant in one two-round review
  --base <git-ref>     Review a clean committed range
  --output <file>      Write the JSON envelope to <file> (mode 0600) and print
                       one summary line, so no shell redirect is needed
  --json
  --yes                Required authorization for both reviewer sessions
`,
  batch: `Usage: agent-ops batch --parent <task-id> --yes [options]

Verify and review the active subtasks of a parent task, and the parent itself,
together. Verify runs one task at a time and skips a task that already has
fresh PASS evidence; each review starts as soon as its own verify passes.
Nothing may commit or edit the worktree while it runs.

Options:
  --parent <task-id>   Required task whose active subtasks and itself are covered
  --base <git-ref>     Base for the subtasks (default: each task's recorded
                       review base, then the worktree base)
  --parent-base <git-ref>
                       Base for the parent task (same default)
  --width <n>          Reviews allowed at once (default 2); a transient
                       NOT_RUN lowers it to 1 and earns one retry
  --output <file>      Write the JSON envelope to <file> (mode 0600) and print
                       one summary line, so no shell redirect is needed
  --json
  --yes                Required authorization for the reviewer sessions
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
       agent-ops worktree commit --message <text> [--json]
       agent-ops worktree list [--json]

Give one writing session its own Git worktree, so parallel sessions stop
voiding each other's verification and review. Run it from the main checkout.

  add <name>   Create .worktrees/<name> on branch agent-ops/<name> from HEAD
               (or --from <commit|branch|tag>), copy the ignored agent-ops
               files and .worktreeinclude matches, inherit trust for an
               identical config, run worktree.setup, and point the session's
               completion gate at the new worktree. When the main checkout is
               detached, --target-branch <branch> is required and names the
               branch finish merges back into.
               A branch already checked out in another worktree is rejected
               before Git runs; see agent-ops worktree list.
  finish <name>
               Once its task is complete, fast-forward the main checkout's
               branch to the worktree's, record the task in git notes, and
               remove the worktree. If the branch moved, it rebases the
               worktree and stops: verify and review again with the printed
               --base, then finish again. One finish runs at a time.
  commit       Stage every change in the current worktree and commit it with
               --message. Refuses the main checkout and a worktree another
               session owns, and needs no Git in the shell.
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
  --from <ref>     add: branch the new worktree from this commit, branch or tag (default HEAD)
  --target-branch <branch>
                   add: branch finish merges back into (defaults to the current
                   branch; required when the main checkout is detached)
  --force          remove: discard uncommitted or unmerged work
  --message <text> commit: the commit message (also -m)
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
    const exitCode = result.status === "ok"
      ? 0
      : result.code === "REVIEW_NOT_RUN" || result.code === "BATCH_NOT_RUN"
        ? 2
        : 1;
    if (args.output !== undefined) {
      // The envelope goes to the file whole; stdout carries one line, so an
      // agent needs neither a shell redirect nor the whole report in context.
      try {
        await writeFile(
          resolve(args.output),
          `${JSON.stringify(result.data === undefined ? { ...result, data: null } : result)}\n`,
          { mode: 0o600 }
        );
      } catch {
        throw new AgentOpsError("CLI_OUTPUT_WRITE_FAILED", `Could not write ${args.output}.`);
      }
      io.writeStdout(`agent-ops: ${result.code} (${result.status}); envelope written to ${args.output}\n`);
      return exitCode;
    }
    return writeAndReturn(io, result, args.json, exitCode);
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
