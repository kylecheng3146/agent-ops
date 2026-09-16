import type { AgentOpsConfig } from "../../runtime/src/contracts.js";
import type { StoredTaskRecord } from "../../runtime/src/task/store.js";
import { saveFixtureReviewAttestation } from "../review/attestation-fixture.js";
import { collectChangeSurface, type GitRunner } from "../../runtime/src/verify/change-surface.js";
import { calculateSourceFingerprint } from "../../runtime/src/verify/source-fingerprint.js";
import { buildVerificationEvidence, FileEvidenceStore } from "../../runtime/src/verify/evidence.js";

export const COMPLETION_CONFIG: AgentOpsConfig = {
  schemaVersion: 3, profiles: ["core"],
  verification: { commands: [{ id: "unit", command: "node", args: ["--test"], cwd: ".", required: true, evidence: { kind: "exit-code" } }] },
  features: { completionGate: { enabled: false }, stopVerification: { enabled: false } },
  pathMappings: [], securityExceptions: []
};

export const completionGit: GitRunner = {
  run: async (args) => ({ exitCode: 0, stdout: Buffer.from(args[0] === "rev-parse" ? `${"a".repeat(40)}\n` :
    args[0] === "diff" && args[1] === "--cached" ? "source.txt\0" : "") })
};

export function completionContext(root: string, config = COMPLETION_CONFIG, gitRunner = completionGit) {
  return { root, gitRunner, loadConfig: async () => config };
}

export async function passingCompletionEvidence(
  root: string, record: StoredTaskRecord, config = COMPLETION_CONFIG, runner = completionGit
): Promise<Record<string, string[]>> {
  const surface = await collectChangeSurface(runner);
  const sourceFingerprint = await calculateSourceFingerprint(root, { mode: "worktree", changedFiles: surface.paths }, runner);
  const store = new FileEvidenceStore(root, root);
  const references: Record<string, string[]> = {};
  for (const criterion of record.task.criteria) {
    references[criterion.id] = [];
    for (const command of config.verification.commands.filter(({ id }) => criterion.verifierIds.includes(id))) {
      references[criterion.id]!.push(await store.save(buildVerificationEvidence({
        taskId: record.task.id, criterionId: criterion.id, command, config, sourceFingerprint,
        scope: "project", startedAt: "2026-07-23T12:00:00Z", finishedAt: "2026-07-23T12:00:01Z",
        status: "PASS", exitCode: 0, testCount: 1, failureClass: "none", toolVersions: {}
      })));
    }
  }
  await saveFixtureReviewAttestation(root, sourceFingerprint, record.task.id, ["claude", "agy"]);
  return references;
}
