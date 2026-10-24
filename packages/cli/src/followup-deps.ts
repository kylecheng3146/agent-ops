import { AgentOpsError } from "../../../runtime/src/fs/paths.js";
import { processFollowup, reconcileFollowupRepairs } from "../../../runtime/src/followup/process.js";
import { isFollowupAssessmentCurrent, type AssessFollowupOptions } from "../../../runtime/src/review/followup.js";
import { resolveReviewRole } from "../../../runtime/src/review/roles.js";
import type { RunHost } from "../../../runtime/src/run/service.js";
import { worktreeDependencies, gitRunner } from "./parallel-deps.js";
import { productionRunContext } from "./run-deps.js";
import { resolveCheckouts } from "../../../runtime/src/parallel/service.js";
import { reconcileFollowups, type FollowupCollection } from "../../../runtime/src/followup/intake.js";

export async function followupRepositoryContext(cwd: string) {
  const deps = worktreeDependencies(), checkouts = await resolveCheckouts(deps, cwd);
  return { git: deps.git, mainRoot: checkouts.mainRoot, commonDir: checkouts.commonDir,
    config: await deps.loadConfig(checkouts.mainRoot), loadConfig: async () => await deps.loadConfig(checkouts.mainRoot) };
}

/** Ordinary CLI reconciliation is advisory and never launches a provider or repair. */
export async function reconcileRepositoryFollowups(cwd: string): Promise<FollowupCollection> {
  try { return await reconcileFollowups(await followupRepositoryContext(cwd)); }
  catch (error) {
    const code = error instanceof AgentOpsError && /^[A-Z0-9_]{1,80}$/u.test(error.code) ? error.code : "FOLLOWUP_COLLECTION_FAILED";
    return { added: 0, candidates: 0, observations: 0,
      warnings: code === "WORKTREE_NOT_GIT" ? [] : [`followup: ${code}; retry with followup import.`] };
  }
}

/** Uses the ordinary production authority, including its exact native/platform/trust refusals. */
export async function productionFollowupContext(cwd: string) {
  const deps = worktreeDependencies(), checkouts = await resolveCheckouts(deps, cwd);
  const branch = await deps.git(checkouts.currentRoot, ["symbolic-ref", "--short", "HEAD"]);
  if (branch.exitCode !== 0) throw new AgentOpsError("RUN_TARGET_REQUIRED", "Followup processing requires a checked-out target branch.");
  const loadConfig = async () => await deps.loadConfig(checkouts.currentRoot);
  const assessmentOptions = async (itemId: string, reviewOnlyReason?: string): Promise<AssessFollowupOptions> => {
    const config = await loadConfig(), role = resolveReviewRole("independent-review", config.reviewRoles ?? []);
    return {
      root: checkouts.currentRoot, commonDir: checkouts.commonDir, itemId, targetBranch: branch.stdout.trim(),
      gitRunner: gitRunner(checkouts.currentRoot), loadConfig,
      review: { targets: role?.targets ?? [], ...(role?.timeoutMs === undefined ? {} : { timeoutMs: role.timeoutMs }) },
      ...(reviewOnlyReason === undefined ? {} : { reviewOnlyReason })
    };
  };
  return { ...checkouts,
    assessmentOptions,
    process: async (itemId: string, host: RunHost, reviewOnlyReason?: string) => {
      const options = await assessmentOptions(itemId, reviewOnlyReason);
      return await processFollowup({ ...options, host, start: async (input, proof) => {
        const run = await productionRunContext(cwd, { beforeStart: async () => {
          if (!await isFollowupAssessmentCurrent(options, proof))
            throw new AgentOpsError("FOLLOWUP_SOURCE_CHANGED", "The finding, target, source or config changed before repair startup.");
        } });
        return (await run.service.start({ ...input, root: run.mainRoot, commonDir: run.commonDir,
          targetBranch: run.targetBranch, ownerSessionId: run.ownerSessionId })).state;
      } });
    },
    reconcile: async () => await reconcileFollowupRepairs({ git: deps.git, mainRoot: checkouts.mainRoot,
      commonDir: checkouts.commonDir, config: await loadConfig(), loadConfig })
  };
}
