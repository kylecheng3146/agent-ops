import { randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import type { AgentOpsConfig } from "../contracts.js";
import { calculateConfigHash, canonicalJson } from "../config/hash.js";
import { sha256 } from "../fs/hash.js";
import { AgentOpsError } from "../fs/paths.js";
import { FileFollowupStore, validateFollowupFinding, type FollowupItem } from "../followup/store.js";
import { readDeliveredReceipt } from "../followup/receipt.js";
import { readPrivateFile, withPrivateFileLock, writePrivateFile } from "../security/permissions.js";
import { collectChangeSurface, resolveGitCommit, type GitRunner } from "../verify/change-surface.js";
import { worktreeFingerprint } from "../verify/source-fingerprint.js";
import { createReviewExecutor, type ReviewExecutorOptions } from "./execute.js";
import { buildReviewPacket } from "./packet.js";
import { validateReviewReport, type ReviewFinding, type ReviewReport } from "./report.js";
import { buildReviewPrompt, runIndependentReview, type ReviewRunResult } from "./runner.js";
import { assertSafeSupportingPaths } from "./scope.js";
import { detectHostTarget, planReviewTargets } from "./roles.js";

export type FollowupConclusion = "PRESENT" | "ABSENT" | "UNKNOWN";

/** Deliberately excludes mutable disposition/history; clarification changes invalidate proof. */
export function followupFindingDigest(item: FollowupItem): string {
  return sha256(canonicalJson({ id: item.id, original: item.original, provenance: item.provenance,
    clarification: item.clarification ?? null }));
}

export interface FollowupSourceBinding {
  readonly root: string;
  readonly commonDir: string;
  readonly commit: string;
  readonly targetBranch: string;
  readonly configHash: string;
  readonly sourceFingerprint: string;
}

export interface FollowupAssessment {
  readonly schemaVersion: 1;
  readonly assessmentId: string;
  readonly createdAt: string;
  readonly itemId: string;
  readonly findingDigest: string;
  readonly original: FollowupItem["original"];
  readonly provenance: FollowupItem["provenance"];
  readonly finding: ReviewFinding;
  readonly binding: FollowupSourceBinding | null;
  readonly conclusion: FollowupConclusion;
  readonly reason: string;
  /** Review-only semantic evidence; never executable acceptance or a resolution receipt. */
  readonly proofKind: "review-only";
  readonly review: ReviewRunResult | null;
}

export interface FollowupAssessmentReference {
  readonly path: string;
  readonly digest: string;
}

export interface AssessFollowupOptions {
  readonly root: string;
  readonly commonDir: string;
  readonly itemId: string;
  readonly targetBranch: string;
  readonly gitRunner: GitRunner;
  readonly loadConfig: () => Promise<AgentOpsConfig>;
  readonly review: Omit<ReviewExecutorOptions, "cwd" | "verifySourceFingerprint">;
}

function unavailable(code: string): never {
  throw new AgentOpsError(code, "Current-source followup assessment cannot establish a conclusion.");
}

function concreteFinding(item: FollowupItem): ReviewFinding {
  const finding = item.clarification ?? item.original;
  if (item.kind !== "candidate" || typeof finding === "string" || !validateFollowupFinding(finding))
    unavailable("FOLLOWUP_CLARIFICATION_REQUIRED");
  return finding;
}

async function sourceBinding(options: AssessFollowupOptions): Promise<FollowupSourceBinding> {
  const { gitRunner } = options;
  const root = await realpath(options.root), commonDir = await realpath(options.commonDir);
  const top = await gitRunner.run(["rev-parse", "--show-toplevel"]);
  if (top.exitCode !== 0 || await realpath(Buffer.from(top.stdout).toString("utf8").trim()) !== root)
    unavailable("FOLLOWUP_REPOSITORY_CHANGED");
  const actualCommon = await gitRunner.run(["rev-parse", "--git-common-dir"]);
  const common = Buffer.from(actualCommon.stdout).toString("utf8").trim();
  if (actualCommon.exitCode !== 0 || await realpath(isAbsolute(common) ? common : resolve(root, common)) !== commonDir)
    unavailable("FOLLOWUP_REPOSITORY_CHANGED");
  if ((await collectChangeSurface(gitRunner)).paths.length !== 0) unavailable("FOLLOWUP_DIRTY_SOURCE");
  const branch = await gitRunner.run(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (branch.exitCode !== 0 || Buffer.from(branch.stdout).toString("utf8").trim() !== options.targetBranch)
    unavailable("FOLLOWUP_TARGET_CHANGED");
  const commit = await resolveGitCommit(gitRunner, "HEAD");
  return { root, commonDir, commit, targetBranch: options.targetBranch,
    configHash: calculateConfigHash(await options.loadConfig()), sourceFingerprint: worktreeFingerprint(commit) };
}

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

async function assertOriginal(options: AssessFollowupOptions, item: FollowupItem): Promise<void> {
  const source = item.provenance;
  const delivered = await readDeliveredReceipt({ commonDir: options.commonDir, mainRoot: options.root, path: source.receiptPath,
    git: async (_cwd, args) => {
      const result = await options.gitRunner.run(args);
      return { exitCode: result.exitCode, stdout: Buffer.from(result.stdout).toString("utf8"), stderr: "" };
    } });
  const review = delivered.reviews.find(review => review.taskId === source.taskId && review.reportDigest === source.reportDigest);
  const report = source.round === "primary" ? review?.artifact.report : review?.artifact.adversarial?.report;
  const original = source.sourceKind === "finding" ? report?.findings[source.index] : report?.residualRisks[source.index];
  if (review === undefined || original === undefined || !same(original, item.original) ||
      delivered.digest !== source.receiptDigest || delivered.receipt.schemaVersion !== source.receiptSchemaVersion ||
      delivered.receipt.candidateHead !== source.candidateHead || delivered.receipt.targetCommit !== source.targetCommit ||
      delivered.receipt.sourceFingerprint !== source.sourceFingerprint || review.provenanceLimit !== source.provenanceLimit)
    unavailable("FOLLOWUP_ORIGINAL_CHANGED");
}

function assessmentPacket(item: FollowupItem, binding: FollowupSourceBinding) {
  return buildReviewPacket({
    request: canonicalJson({ itemId: item.id, findingDigest: followupFindingDigest(item), original: item.original,
      provenance: item.provenance, finding: concreteFinding(item), binding }),
    criteria: [{ id: "followup-assessment", description: "Assess the exact original finding against this current source, explaining specific semantic evidence or uncertainty." }],
    artifactRefs: [], evidenceRequirements: [{ criterionId: "followup-assessment",
      requirement: "Explain the original claim using literal current-source path:line: excerpt evidence. UNKNOWN on insufficient proof; no executable acceptance is claimed." }]
  });
}

/** Validate literal source excerpts, in addition to the ordinary strict report contract. */
async function conclusionOf(root: string, git: GitRunner, report: ReviewReport): Promise<FollowupConclusion> {
  if (!validateReviewReport(report, ["followup-assessment"], []).ok ||
      !["PRESENT", "ABSENT"].includes(report.summary) || report.findings.length !== 0 || report.residualRisks.length !== 0 ||
      report.results.length !== 1 || report.results[0]!.status !== "PASS") return "UNKNOWN";
  const result = report.results[0]!;
  if (result.summary.trim().length < 32 || result.evidence.length === 0) return "UNKNOWN";
  for (const citation of result.evidence) {
    const match = /^([^\r\n]+):([1-9]\d*): ([^\r\n]+)$/u.exec(citation);
    if (match === null || !report.supportingFilesInspected.includes(match[1]!)) return "UNKNOWN";
    const path = match[1]!, line = Number(match[2]);
    await assertSafeSupportingPaths(root, [path]);
    const tree = await git.run(["ls-tree", "-z", "HEAD", "--", path]);
    if (tree.exitCode !== 0 || !/^(?:100644|100755) blob /u.test(Buffer.from(tree.stdout).toString("utf8"))) return "UNKNOWN";
    const source = await readFile(join(root, ...path.split("/")), "utf8");
    if (!Number.isSafeInteger(line) || source.split(/\r?\n/u)[line - 1] !== match[3] || match[3]!.trim() === "") return "UNKNOWN";
  }
  return report.summary as FollowupConclusion;
}

async function assessedConclusion(root: string, git: GitRunner, review: ReviewRunResult): Promise<FollowupConclusion> {
  const attempts = review.attempts ?? [];
  if (review.status !== "PASS" || review.sessionIsolation !== "fresh" || review.verification !== undefined ||
      review.report === undefined || review.adversarial === undefined || review.adversarial.refuted ||
      attempts.length !== 2 || attempts.some(a => a.status !== "PASS" || !a.sessionId) ||
      attempts[0]!.sessionId === attempts[1]!.sessionId) return "UNKNOWN";
  const primary = await conclusionOf(root, git, review.report);
  const adversarial = await conclusionOf(root, git, review.adversarial.report);
  return primary === adversarial ? primary : "UNKNOWN";
}

function evidencePath(commonDir: string, digest: string): string {
  if (!/^[a-f0-9]{64}$/u.test(digest)) unavailable("FOLLOWUP_ASSESSMENT_INVALID");
  return join(commonDir, "agent-ops", "followup", "assessments", `${digest}.json`);
}

/** No repair/start or ledger disposition mutation is reachable from assessment. */
export async function assessFollowup(options: AssessFollowupOptions): Promise<{
  readonly assessment: FollowupAssessment;
  readonly reference: FollowupAssessmentReference;
}> {
  const store = new FileFollowupStore(options.commonDir);
  const item = await store.get(options.itemId), finding = concreteFinding(item);
  const findingDigest = followupFindingDigest(item);
  let binding: FollowupSourceBinding | null = null;
  let review: ReviewRunResult | null = null;
  let conclusion: FollowupConclusion = "UNKNOWN";
  let reason = "FOLLOWUP_INSUFFICIENT_EVIDENCE";
  try {
    binding = await sourceBinding(options);
    await assertOriginal(options, item);
    const expected = binding;
    const unchanged = async (): Promise<boolean> => {
      try {
        await assertOriginal(options, item);
        return same(expected, await sourceBinding(options)) && findingDigest === followupFindingDigest(await store.get(item.id));
      }
      catch { return false; }
    };
    const packet = assessmentPacket(item, binding);
    const execute = createReviewExecutor({ ...options.review, cwd: binding.root, verifySourceFingerprint: unchanged });
    const host = detectHostTarget(options.review.env ?? process.env);
    const planned = planReviewTargets(options.review.targets, host);
    review = await runIndependentReview({ authorized: true, execute, invocation: {
      followupAssessment: true, harness: planned.targets[0] ?? options.review.targets[0] ?? "agy",
      plannedTargets: planned.targets, ...(host === undefined ? {} : { hostTarget: host }), model: options.review.model ?? "default",
      effort: options.review.effort ?? "default", sourceFingerprint: binding.sourceFingerprint,
      packet, scope: { mode: "worktree", changedFiles: [] }
    } });
    if (!await unchanged()) reason = "FOLLOWUP_SOURCE_CHANGED";
    else {
      conclusion = await assessedConclusion(binding.root, options.gitRunner, review);
      reason = conclusion === "UNKNOWN" ? review.reason ?? "FOLLOWUP_INSUFFICIENT_EVIDENCE" : "FOLLOWUP_TWO_FRESH_ASSESSMENTS";
      if (!await unchanged()) { conclusion = "UNKNOWN"; reason = "FOLLOWUP_SOURCE_CHANGED"; }
    }
  } catch (error) {
    conclusion = "UNKNOWN";
    reason = error instanceof AgentOpsError ? error.code : "FOLLOWUP_ASSESSMENT_UNAVAILABLE";
  }
  const assessment: FollowupAssessment = { schemaVersion: 1, assessmentId: randomUUID(), createdAt: new Date().toISOString(),
    itemId: item.id, findingDigest, original: item.original, provenance: item.provenance, finding,
    binding, conclusion, reason, proofKind: "review-only", review };
  const content = `${JSON.stringify(assessment, null, 2)}\n`, digest = sha256(content);
  if (Buffer.byteLength(content) > 4 * 1024 * 1024) unavailable("FOLLOWUP_ASSESSMENT_TOO_LARGE");
  const path = evidencePath(options.commonDir, digest);
  await withPrivateFileLock(path, options.commonDir, async () => {
    const existing = await readPrivateFile(path, options.commonDir);
    if (existing !== null && existing !== content) unavailable("FOLLOWUP_ASSESSMENT_CHANGED");
    if (existing === null) await writePrivateFile(path, content, options.commonDir);
  });
  return { assessment, reference: { path, digest } };
}

/** Load exact sealed bytes; consumers must also recheck current source before acting. */
export async function readFollowupAssessment(commonDir: string, reference: FollowupAssessmentReference): Promise<FollowupAssessment> {
  if (reference.path !== evidencePath(commonDir, reference.digest)) unavailable("FOLLOWUP_ASSESSMENT_INVALID");
  const content = await readPrivateFile(reference.path, commonDir);
  if (content === null || Buffer.byteLength(content) > 4 * 1024 * 1024 || sha256(content) !== reference.digest)
    unavailable("FOLLOWUP_ASSESSMENT_CHANGED");
  let proof: FollowupAssessment;
  try { proof = JSON.parse(content) as FollowupAssessment; } catch { return unavailable("FOLLOWUP_ASSESSMENT_INVALID"); }
  if (proof?.schemaVersion !== 1 || proof.proofKind !== "review-only" || !["PRESENT", "ABSENT", "UNKNOWN"].includes(proof.conclusion) ||
      !validateFollowupFinding(proof.finding) || typeof proof.findingDigest !== "string" || !/^[a-f0-9]{64}$/u.test(proof.findingDigest))
    unavailable("FOLLOWUP_ASSESSMENT_INVALID");
  return proof;
}

/** Fail closed on a changed finding, target, commit, config, or dirty checkout. */
export async function isFollowupAssessmentCurrent(options: AssessFollowupOptions, proof: FollowupAssessment): Promise<boolean> {
  try {
    const item = await new FileFollowupStore(options.commonDir).get(options.itemId);
    await assertOriginal(options, item);
    if (proof.itemId !== item.id || proof.findingDigest !== followupFindingDigest(item) ||
        !same(proof.original, item.original) || !same(proof.provenance, item.provenance) ||
        !same(proof.finding, concreteFinding(item)) || proof.binding === null || !same(proof.binding, await sourceBinding(options)) ||
        proof.review === null || proof.review.sourceFingerprint !== proof.binding.sourceFingerprint || proof.conclusion === "UNKNOWN") return false;
    const prompt = buildReviewPrompt({ followupAssessment: true, packet: assessmentPacket(item, proof.binding),
      harness: proof.review.harness, model: proof.review.model, effort: proof.review.effort });
    if (proof.review.prompt !== prompt) return false;
    if (await assessedConclusion(options.root, options.gitRunner, proof.review) !== proof.conclusion) return false;
    await assertOriginal(options, item);
    return same(proof.binding, await sourceBinding(options)) &&
      proof.findingDigest === followupFindingDigest(await new FileFollowupStore(options.commonDir).get(item.id));
  } catch { return false; }
}
