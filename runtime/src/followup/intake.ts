import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

import { AgentOpsError } from "../fs/paths.js";
import type { WorktreeDependencies } from "../parallel/service.js";
import { readDeliveredReceipt } from "./receipt.js";
import { FileFollowupStore, followupIdentity, type FollowupItem, type FollowupProvenance } from "./store.js";

export interface FollowupCollection {
  readonly added: number;
  readonly candidates: number;
  readonly observations: number;
  readonly warnings: readonly string[];
}

export interface FollowupSource {
  readonly git: WorktreeDependencies["git"];
  readonly mainRoot: string;
  readonly commonDir: string;
}

function warning(error: unknown): string {
  const code = error instanceof AgentOpsError && /^[A-Z0-9_]{1,80}$/u.test(error.code) ? error.code : "FOLLOWUP_COLLECTION_FAILED";
  return `followup: ${code}; original completion is unchanged. Retry with followup import.`;
}

/** Metadata-only and fail-open: collection cannot invalidate a successful finish. */
export async function collectFollowupReceipt(options: FollowupSource & { readonly path: string }): Promise<FollowupCollection> {
  try {
    const { receipt, digest, reviews } = await readDeliveredReceipt(options);
    const pending: FollowupItem[] = [];
    for (const review of reviews) for (const round of ["primary", "adversarial"] as const) {
      const report = round === "primary" ? review.artifact.report! : review.artifact.adversarial!.report;
      const provenance = { receiptPath: options.path, receiptDigest: digest, receiptSchemaVersion: receipt.schemaVersion,
        candidateHead: receipt.candidateHead, targetCommit: receipt.targetCommit, sourceFingerprint: receipt.sourceFingerprint,
        taskId: review.taskId, reportDigest: review.reportDigest, round, provenanceLimit: review.provenanceLimit };
      const add = (sourceKind: FollowupProvenance["sourceKind"], original: FollowupItem["original"], index: number) => {
        const source = { ...provenance, sourceKind, index };
        pending.push({ id: followupIdentity(source), kind: sourceKind === "finding" ? "candidate" : "observation",
          original, provenance: source, disposition: "pending", history: [{ at: new Date().toISOString(), action: "collected" }] });
      };
      report.findings.forEach((finding, index) => { if (!finding.blocking) add("finding", finding, index); });
      report.residualRisks.forEach((risk, index) => add("residual-risk", risk, index));
    }
    if (pending.length === 0) return { added: 0, candidates: 0, observations: 0, warnings: [] };
    return await new FileFollowupStore(options.commonDir).mutate(items => {
      const known = new Set(items.map(item => item.id));
      const added = pending.filter(item => !known.has(item.id));
      items.push(...added);
      return { added: added.length, candidates: added.filter(item => item.kind === "candidate").length,
        observations: added.filter(item => item.kind === "observation").length, warnings: [] };
    });
  } catch (error) { return { added: 0, candidates: 0, observations: 0, warnings: [warning(error)] }; }
}

/** Historical import never launches assessment, repair, models or provider calls. */
export async function reconcileFollowups(options: FollowupSource): Promise<FollowupCollection> {
  const result = { added: 0, candidates: 0, observations: 0, warnings: [] as string[] };
  try {
    const directory = join(options.commonDir, "agent-ops", "receipts");
    // Checking through the private reader rejects symlinked ancestors before enumeration.
    await new FileFollowupStore(options.commonDir).read();
    const status = await lstat(directory);
    if (!status.isDirectory() || status.isSymbolicLink())
      throw new AgentOpsError("PRIVATE_STATE_PATH_INVALID", "Receipt directory is unsafe.");
    const names = (await readdir(directory)).filter(name => /^[a-f0-9]{64}-[a-f0-9]{40,64}\.json$/u.test(name)).sort();
    for (const name of names) {
      const collected = await collectFollowupReceipt({ ...options, path: join(directory, name) });
      result.added += collected.added;
      result.candidates += collected.candidates;
      result.observations += collected.observations;
      // Repeated malformed sources cannot flood normal CLI diagnostics.
      for (const item of collected.warnings) if (!result.warnings.includes(item) && result.warnings.length < 8) result.warnings.push(item);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") result.warnings.push(warning(error));
  }
  return result;
}
