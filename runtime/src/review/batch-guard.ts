import {
  collectChangeSurface,
  resolveGitCommit,
  type GitRunner
} from "../verify/change-surface.js";

/**
 * Remembers HEAD now and answers whether the batch may go on: HEAD is still
 * that commit and the working tree has no change. The first answer doubles as
 * the clean-tree check, since a batch reviews committed ranges only.
 */
export async function createSourceGuard(runner: GitRunner): Promise<() => Promise<boolean>> {
  const head = await resolveGitCommit(runner, "HEAD");
  return async () =>
    await resolveGitCommit(runner, "HEAD") === head &&
    (await collectChangeSurface(runner)).paths.length === 0;
}
