import type { ParsedArgs } from "../args.js";
import { okEnvelope, type CliEnvelope } from "../output.js";
import {
  addWorktree,
  type WorktreeAddResult
} from "../../../../runtime/src/worktree/service.js";
import {
  finishWorktree,
  type FinishDependencies,
  type FinishResult
} from "../../../../runtime/src/worktree/finish.js";

function addText(result: WorktreeAddResult): string {
  const { record } = result;
  return [
    `Created worktree ${record.name} for session ${record.sessionId}.`,
    `Path: ${record.path}`,
    `Branch: ${record.branch} (from ${record.targetBranch} at ${record.base})`,
    `Copied: ${result.copied.length === 0 ? "nothing" : result.copied.join(", ")}`,
    `Trust: ${result.trusted ? "inherited" : "not inherited; run agent-ops trust grant inside the worktree"}`,
    ...(result.setup.length === 0 ? [] : [`Setup: ${result.setup.join("; ")}`]),
    "",
    "Work only inside that path from now on:",
    `- Claude Code: EnterWorktree with path ${record.path}`,
    `- Codex and agy: run every command with ${record.path} as its working directory`,
    `Finish with: commit, agent-ops verify/review/task complete with --base ${record.base},`,
    `then agent-ops worktree finish ${record.name} from ${record.mainRoot}`,
    "(Claude Code: ExitWorktree with action keep before finishing)."
  ].join("\n");
}

function finishText(result: FinishResult): string {
  const { record } = result;
  return [
    `Merged ${record.branch} into ${record.targetBranch} at ${result.mergedHead}${result.rebased ? " after a clean rebase and re-verification" : ""}.`,
    `Task ${result.taskId} is recorded in git notes (refs/notes/agent-ops).`,
    `Removed ${record.path}.`,
    ...result.warnings.map((warning) => `Warning: ${warning}`)
  ].join("\n");
}

export async function runWorktreeCommand(options: {
  readonly args: ParsedArgs;
  readonly cwd: string;
  readonly deps: FinishDependencies;
}): Promise<CliEnvelope<unknown>> {
  const { args } = options;
  if (args.action === "finish") {
    const finished = await finishWorktree(options.deps, { cwd: options.cwd, name: args.worktreeName });
    return okEnvelope("WORKTREE_FINISHED", { ...finished, text: finishText(finished) });
  }
  const sessionId = args.sessionId ?? process.env.AGENT_OPS_SESSION_ID;
  const result = await addWorktree(options.deps, {
    cwd: options.cwd,
    name: args.worktreeName,
    sessionId
  });
  return okEnvelope("WORKTREE_CREATED", { ...result, text: addText(result) });
}
