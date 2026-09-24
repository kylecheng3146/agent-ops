import type { ParsedArgs } from "../args.js";
import { okEnvelope, type CliEnvelope } from "../output.js";
import {
  addWorktree,
  type WorktreeAddResult,
  type WorktreeDependencies
} from "../../../../runtime/src/worktree/service.js";

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
    `Finish with: commit, then agent-ops verify/review/task complete with --base ${record.base}.`
  ].join("\n");
}

export async function runWorktreeCommand(options: {
  readonly args: ParsedArgs;
  readonly cwd: string;
  readonly deps: WorktreeDependencies;
}): Promise<CliEnvelope<unknown>> {
  const { args } = options;
  const sessionId = args.sessionId ?? process.env.AGENT_OPS_SESSION_ID;
  const result = await addWorktree(options.deps, {
    cwd: options.cwd,
    name: args.worktreeName,
    sessionId
  });
  return okEnvelope("WORKTREE_CREATED", { ...result, text: addText(result) });
}
