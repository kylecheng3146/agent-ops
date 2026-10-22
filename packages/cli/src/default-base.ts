import { readWorktreeRecord } from "../../../runtime/src/parallel/service.js";
import { collectChangeSurface, resolveGitCommit, type GitRunner } from "../../../runtime/src/verify/change-surface.js";

/**
 * The base verify and review use when `--base` is absent, so committed work is
 * judged as a range without the agent having to copy it. A dirty tree keeps the
 * working-tree mode; a session worktree compares against its merge-base with the
 * target branch (which follows a finish rebase); elsewhere the task's creation
 * commit counts when it is an ancestor of HEAD.
 */
export async function defaultBase(root: string, runner: GitRunner,
  createdSourceCommit: () => Promise<string | undefined>): Promise<string | undefined> {
  if ((await collectChangeSurface(runner)).paths.length > 0) return undefined;
  const head = await resolveGitCommit(runner, "HEAD");
  const record = await readWorktreeRecord(root);
  let base: string | undefined;
  if (record !== null) {
    const merge = await runner.run(["merge-base", "HEAD", record.targetBranch]);
    base = merge.exitCode === 0 ? Buffer.from(merge.stdout).toString("utf8").trim() : record.base;
  } else {
    const created = await createdSourceCommit().catch(() => undefined);
    if (created !== undefined && (await runner.run(["merge-base", "--is-ancestor", created, "HEAD"])).exitCode === 0) base = created;
  }
  return base === undefined || base === "" || base === head ? undefined : base;
}
