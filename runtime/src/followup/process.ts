import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { calculateConfigHash, canonicalJson } from "../config/hash.js";
import type { AgentOpsConfig } from "../contracts.js";
import { sha256 } from "../fs/hash.js";
import { AgentOpsError } from "../fs/paths.js";
import { assessFollowup, followupFindingDigest, isFollowupAssessmentCurrent, readFollowupAssessment,
  type AssessFollowupOptions, type FollowupAssessment, type FollowupAssessmentReference } from "../review/followup.js";
import { FileRunRepository, type RunHost, type RunState } from "../run/service.js";
import { readPrivateFile, withPrivateFileLock, writePrivateFile } from "../security/permissions.js";
import { evidenceMatchesContract } from "../task/contract.js";
import { validateEvidence } from "../schema/validate.js";
import { acceptanceCoverage } from "../verify/acceptance-coverage.js";
import { collectChangeSurface, resolveGitCommit, type GitRunner } from "../verify/change-surface.js";
import { isPassingVerificationEvidence } from "../verify/evidence.js";
import type { FollowupSource } from "./intake.js";
import { readDeliveredReceipt } from "./receipt.js";
import { FileFollowupStore, type FollowupItem } from "./store.js";

export interface FollowupRepairAttempt {
  readonly runId: string;
  readonly host: RunHost;
  readonly findingDigest: string;
  readonly assessment: FollowupAssessmentReference;
  readonly goal: string;
  readonly status: "starting" | "linked" | "refused";
  readonly code?: string;
}

export interface FollowupResolution {
  readonly at: string;
  readonly findingDigest: string;
  readonly commit: string;
  readonly targetBranch: string;
  readonly configHash: string;
  readonly proofKind: "behavioral" | "review-only";
  readonly assessment: FollowupAssessmentReference;
  readonly receipt?: { readonly path: string; readonly digest: string; readonly taskId: string; readonly runId: string };
  readonly proofDigests: readonly string[];
}

export interface FollowupProgress {
  readonly schemaVersion: 1;
  readonly itemId: string;
  readonly status: "assessing" | "unresolved" | "starting" | "linked" | "resolved";
  readonly code: string;
  readonly assessment?: FollowupAssessmentReference;
  readonly attempts: readonly FollowupRepairAttempt[];
  readonly resolutions: readonly FollowupResolution[];
}

function invalid(code = "FOLLOWUP_PROGRESS_INVALID"): never {
  throw new AgentOpsError(code, "Followup progress cannot authorize this operation; preserve it for recovery.");
}

function progressPath(commonDir: string, itemId: string): string {
  if (!/^followup-[a-f0-9]{64}$/u.test(itemId)) invalid();
  return join(commonDir, "agent-ops", "followup", "progress", `${itemId}.json`);
}

function reference(value: FollowupAssessmentReference | undefined, commonDir: string): boolean {
  return value !== undefined && typeof value.digest === "string" && /^[a-f0-9]{64}$/u.test(value.digest) &&
    value.path === join(commonDir, "agent-ops", "followup", "assessments", `${value.digest}.json`);
}

export async function readFollowupProgress(commonDir: string, itemId: string, currentItem?: FollowupItem): Promise<FollowupProgress> {
  const source = await readPrivateFile(progressPath(commonDir, itemId), commonDir);
  if (source === null) return { schemaVersion: 1, itemId, status: "unresolved", code: "FOLLOWUP_PENDING", attempts: [], resolutions: [] };
  try {
    const state = JSON.parse(source) as FollowupProgress;
    if (Buffer.byteLength(source) > 4 * 1024 * 1024 || state.schemaVersion !== 1 || state.itemId !== itemId ||
        !["assessing", "unresolved", "starting", "linked", "resolved"].includes(state.status) ||
        typeof state.code !== "string" || !/^[A-Z0-9_-]{1,128}$/u.test(state.code) ||
        (state.assessment !== undefined && !reference(state.assessment, commonDir)) ||
        !Array.isArray(state.attempts) || !Array.isArray(state.resolutions) ||
        state.attempts.some(a => !a || !/^run-[a-z0-9-]{4,60}$/u.test(a.runId) || !["codex", "claude"].includes(a.host) ||
          !["starting", "linked", "refused"].includes(a.status) || !/^[a-f0-9]{64}$/u.test(a.findingDigest) ||
          typeof a.goal !== "string" || a.goal.trim() === "" || a.goal.length > 1024 * 1024 || !reference(a.assessment, commonDir)) ||
        state.resolutions.some(r => !r || !Number.isFinite(Date.parse(r.at)) || !/^[a-f0-9]{40,64}$/u.test(r.commit) ||
          !/^[a-f0-9]{64}$/u.test(r.findingDigest) || !["behavioral", "review-only"].includes(r.proofKind) ||
          !reference(r.assessment, commonDir) || !/^[a-f0-9]{64}$/u.test(r.configHash) || typeof r.targetBranch !== "string" || r.targetBranch.trim() === "" ||
          (r.receipt !== undefined && (typeof r.receipt.path !== "string" || !/^[a-f0-9]{64}$/u.test(r.receipt.digest) ||
            typeof r.receipt.taskId !== "string" || !/^run-[a-z0-9-]{4,60}$/u.test(r.receipt.runId))) ||
          !Array.isArray(r.proofDigests) || r.proofDigests.length === 0 || r.proofDigests.some((d: string) => !/^[a-f0-9]{64}$/u.test(d)))) invalid();
    const item = currentItem ?? await new FileFollowupStore(commonDir).get(itemId), resolution = state.resolutions.at(-1);
    if (state.status === "resolved" && (resolution === undefined || resolution.findingDigest !== followupFindingDigest(item) ||
        item.history.some(event => ["reopened", "clarified"].includes(event.action) && Date.parse(event.at) >= Date.parse(resolution.at))))
      return { ...state, status: "unresolved", code: "FOLLOWUP_REOPENED" };
    return state;
  } catch { return invalid(); }
}

async function save(commonDir: string, state: FollowupProgress): Promise<FollowupProgress> {
  const content = `${JSON.stringify(state, null, 2)}\n`;
  if (Buffer.byteLength(content) > 4 * 1024 * 1024) invalid();
  await writePrivateFile(progressPath(commonDir, state.itemId), content, commonDir);
  return state;
}

export function followupResolutionDescription(itemId: string, findingDigest: string): string {
  return `Resolve the exact original finding ${itemId} (finding-sha256: ${findingDigest}) with corresponding evidence; generic test PASS or changed paths are insufficient.`;
}

/** The ordinary run goal is the immutable link; no historical run is resumed or rewritten. */
function repairGoal(item: FollowupItem, proof: FollowupAssessment, reference: FollowupAssessmentReference): string {
  return ["Repair this selected, conclusively PRESENT followup and nothing unrelated.",
    canonicalJson({ itemId: item.id, findingDigest: proof.findingDigest, original: item.original, provenance: item.provenance,
      finding: proof.finding, assessment: reference, binding: proof.binding }),
    "Keep the original goal fixed. Preserve normal task advisory, mandatory verification, trust, permissions, two fresh reviews and finish.",
    "Include a root acceptance criterion with id followup-resolution and this exact description:",
    followupResolutionDescription(item.id, proof.findingDigest),
    proof.reviewOnlyReason === undefined
      ? `Use behavioral acceptance for followup-resolution, baselineCommit ${proof.binding!.commit}, with designated failing baseline checks for the original finding and corresponding passing candidate checks. Invariant or generic suite PASS cannot resolve it.`
      : `Use an explicit review-only acceptance contract for followup-resolution, baselineCommit ${proof.binding!.commit}, reviewOnlyReason ${JSON.stringify(proof.reviewOnlyReason)}. Both fresh reviewers must assess this exact finding and the fallback reason. A reproducible bug still requires behavioral red-to-green; reject this fallback if executable checks can establish the claim.`,
    "Do not declare the followup resolved yourself. Its delivered sealed receipt is reconciled against the original finding, exact candidate and evidence."].join("\n\n");
}

export interface ProcessFollowupOptions extends AssessFollowupOptions {
  readonly host: RunHost;
  /** Production callers must supply productionRunContext's checked start, never bare RunService.start. */
  readonly start: (input: { readonly runId: string; readonly goal: string; readonly host: RunHost }, proof: FollowupAssessment) => Promise<RunState>;
}

/** An exclusive private claim spans assessment and durable start intent, including competing CLI processes. */
export async function processFollowup(options: ProcessFollowupOptions): Promise<FollowupProgress> {
  const { commonDir, itemId } = options;
  if (!["codex", "claude"].includes(options.host)) invalid("RUN_HOST_INVALID");
  return await withPrivateFileLock(progressPath(commonDir, itemId), commonDir, async () => {
    const store = new FileFollowupStore(commonDir), item = await store.get(itemId);
    if (item.kind !== "candidate") invalid("FOLLOWUP_CLARIFICATION_REQUIRED");
    let state = await readFollowupProgress(commonDir, itemId, item);
    const runs = new FileRunRepository(join(commonDir, "agent-ops", "runs"), commonDir);
    const prior = state.attempts.at(-1);
    if (prior !== undefined && prior.status !== "refused") {
      const existing = await runs.read(prior.runId);
      if (existing !== null) {
        if (existing.goal !== prior.goal || existing.host !== prior.host) invalid("FOLLOWUP_RUN_CHANGED");
        if (!["failed", "complete"].includes(existing.status))
          return await save(commonDir, { ...state, status: "linked", code: "FOLLOWUP_RUN_LINKED",
            attempts: [...state.attempts.slice(0, -1), { ...prior, status: "linked" }] });
      } else if (prior.status === "starting") {
        // An interrupted start has one reserved identity. Never issue a second identity while its outcome is ambiguous.
        return await save(commonDir, { ...state, status: "starting", code: "FOLLOWUP_START_PENDING" });
      } else invalid("FOLLOWUP_RUN_MISSING");
    }
    state = await save(commonDir, { ...state, status: "assessing", code: "FOLLOWUP_ASSESSING" });
    const { assessment, reference } = await assessFollowup(options);
    state = await save(commonDir, { ...state, assessment: reference, status: "unresolved", code: "FOLLOWUP_" + assessment.conclusion });
    if (assessment.conclusion === "UNKNOWN" || !await isFollowupAssessmentCurrent(options, assessment)) return state;
    if (assessment.conclusion === "ABSENT") {
      if (assessment.reviewOnlyReason === undefined) return state;
      const resolution: FollowupResolution = { at: new Date().toISOString(), findingDigest: assessment.findingDigest,
        commit: assessment.binding!.commit, targetBranch: assessment.binding!.targetBranch, configHash: assessment.binding!.configHash,
        proofKind: "review-only", assessment: reference, proofDigests: [reference.digest,
          sha256(canonicalJson(assessment.review!.report)), sha256(canonicalJson(assessment.review!.adversarial!.report))] };
      return await save(commonDir, { ...state, status: "resolved", code: "FOLLOWUP_ABSENCE_PROVEN", resolutions: [...state.resolutions, resolution] });
    }
    const attempt: FollowupRepairAttempt = { runId: `run-${randomUUID().replaceAll("-", "").slice(0, 16)}`,
      host: options.host, findingDigest: assessment.findingDigest, assessment: reference,
      goal: repairGoal(item, assessment, reference), status: "starting" };
    state = await save(commonDir, { ...state, status: "starting", code: "FOLLOWUP_START_PENDING", attempts: [...state.attempts, attempt] });
    try {
      if (!await isFollowupAssessmentCurrent(options, assessment)) invalid("FOLLOWUP_SOURCE_CHANGED");
      const run = await options.start({ runId: attempt.runId, goal: attempt.goal, host: attempt.host }, assessment);
      if (run.runId !== attempt.runId || run.goal !== attempt.goal) invalid("FOLLOWUP_RUN_CHANGED");
      state = { ...state, status: "linked", code: "FOLLOWUP_RUN_STARTED", attempts: [...state.attempts.slice(0, -1), { ...attempt, status: "linked" }] };
    } catch (error) {
      const code = error instanceof AgentOpsError && /^[A-Z0-9_]{1,128}$/u.test(error.code) ? error.code : "FOLLOWUP_START_FAILED";
      const created = await runs.read(attempt.runId);
      if (created !== null && (created.goal !== attempt.goal || created.host !== attempt.host)) invalid("FOLLOWUP_RUN_CHANGED");
      state = { ...state, status: created === null ? "unresolved" : "linked", code,
        attempts: [...state.attempts.slice(0, -1), { ...attempt, status: created === null ? "refused" : "linked", code }] };
    }
    return await save(commonDir, state);
  });
}

/** Recheck sealed specific acceptance after cleanup, using existing paired-evidence rules. */
export async function reconcileFollowupRepairs(options: FollowupSource & {
  readonly config: AgentOpsConfig; readonly path?: string;
}): Promise<readonly string[]> {
  const warnings: string[] = [];
  try {
    const store = new FileFollowupStore(options.commonDir);
    const runs = new FileRunRepository(join(options.commonDir, "agent-ops", "runs"), options.commonDir);
    const gitRunner: GitRunner = { run: async args => {
      const result = await options.git(options.mainRoot, args); return { ...result, stdout: Buffer.from(result.stdout) };
    } };
    for (const item of (await store.read()).items) {
      await withPrivateFileLock(progressPath(options.commonDir, item.id), options.commonDir, async () => {
        const state = await readFollowupProgress(options.commonDir, item.id, item), attempt = state.attempts.at(-1);
        if (attempt === undefined || attempt.status === "refused") return;
        const run = await runs.read(attempt.runId);
        if (run === null) return;
        if (run.goal !== attempt.goal || run.host !== attempt.host || run.root !== options.mainRoot ||
            run.commonDir !== options.commonDir || attempt.findingDigest !== followupFindingDigest(item)) invalid("FOLLOWUP_RUN_CHANGED");
        if (run.integration?.receiptPath == null || run.integration.receiptDigest === null ||
            (options.path !== undefined && options.path !== run.integration.receiptPath)) return;
        const proof = await readFollowupAssessment(options.commonDir, attempt.assessment);
        if (proof.conclusion !== "PRESENT" || proof.findingDigest !== attempt.findingDigest || proof.binding === null ||
            proof.itemId !== item.id || repairGoal(item, proof, attempt.assessment) !== attempt.goal) invalid();
        const original = await readDeliveredReceipt({ ...options, path: item.provenance.receiptPath });
        if (original.digest !== item.provenance.receiptDigest) invalid("FOLLOWUP_ORIGINAL_CHANGED");
        const delivered = await readDeliveredReceipt({ ...options, path: run.integration.receiptPath });
        const receipt = delivered.receipt;
        if (delivered.digest !== run.integration.receiptDigest || receipt.sessionId !== run.ownerSessionId ||
            receipt.integrationJournal?.transactionId !== run.integration.transactionId || receipt.candidateHead !== run.integration.candidate ||
            receipt.targetCommit !== run.integration.expectedTarget ||
            run.targetBranch !== proof.binding.targetBranch || run.rootTaskId === null ||
            (await collectChangeSurface(gitRunner)).paths.length !== 0 ||
            await resolveGitCommit(gitRunner, "HEAD") !== receipt.candidateHead ||
            (await gitRunner.run(["merge-base", "--is-ancestor", proof.binding.commit, receipt.candidateHead])).exitCode !== 0) return;
        const branch = await gitRunner.run(["symbolic-ref", "--short", "HEAD"]);
        if (branch.exitCode !== 0 || Buffer.from(branch.stdout).toString("utf8").trim() !== run.targetBranch) return;
        const root = receipt.tasks.find(r => r.task.id === run.rootTaskId);
        const criterion = root?.task.criteria.find(c => c.id === "followup-resolution");
        if (root === undefined || root.task.goal !== attempt.goal || criterion?.description !== followupResolutionDescription(item.id, attempt.findingDigest) ||
            criterion.acceptance === undefined || criterion.acceptance.baselineCommit !== proof.binding.commit ||
            (proof.reviewOnlyReason === undefined ? criterion.acceptance.mode !== "behavioral" :
              criterion.acceptance.mode !== "review-only" || criterion.acceptance.reviewOnlyReason !== proof.reviewOnlyReason)) return;
        const configHash = calculateConfigHash(options.config);
        const load = async (reference: string) => receipt.verification[reference]?.value ?? null;
        const readExecution = async (path: string): Promise<string | null> => {
          const seal = receipt.executionArtifacts?.[path];
          if (seal === undefined || typeof seal.value !== "string" || sha256(JSON.stringify(seal.value)) !== seal.digest) return null;
          return seal.value;
        };
        const proofDigests = [delivered.digest, attempt.assessment.digest];
        for (const record of receipt.tasks) {
          if (record.policyConfigHash !== configHash) return;
          for (const c of record.task.criteria) for (const command of options.config.verification.commands.filter(c => c.required)) {
            const evidence = (record.evidence[c.id] ?? []).filter(ref => !ref.startsWith("review:")).map(ref => {
              const seal = receipt.verification[ref];
              const result = validateEvidence(seal?.value);
              if (seal === undefined || sha256(JSON.stringify(seal.value)) !== seal.digest || !result.ok) return null;
              return { value: result.value, digest: seal.digest };
            }).filter(e => e !== null && e.value.acceptance === undefined && e.value.taskId === record.task.id &&
              e.value.criterionId === c.id && e.value.commandId === command.id && e.value.configHash === configHash &&
              e.value.sourceFingerprint === receipt.sourceFingerprint && evidenceMatchesContract(e.value.taskContractHash, record.task))
              .sort((a, b) => Date.parse(b!.value.finishedAt) - Date.parse(a!.value.finishedAt) || (a!.value.status === "PASS" ? 1 : -1))[0];
            if (evidence == null || !isPassingVerificationEvidence(command, evidence.value)) return;
            proofDigests.push(evidence.digest);
          }
          const coverage = await acceptanceCoverage(record, options.config, receipt.sourceFingerprint,
            { root: options.mainRoot, load }, readExecution);
          if (coverage.some(c => ["behavioral", "invariant"].includes(c.mode) && c.status !== "proven")) return;
          for (const c of record.task.criteria) for (const ref of record.evidence[c.id] ?? []) {
            const seal = receipt.verification[ref];
            const checked = validateEvidence(seal?.value);
            if (!checked.ok || checked.value.acceptance === undefined || checked.value.sourceFingerprint !== receipt.sourceFingerprint ||
                checked.value.configHash !== configHash || !evidenceMatchesContract(checked.value.taskContractHash, record.task)) continue;
            if (checked.value.acceptance.phase === "candidate" && checked.value.acceptance.commit !== receipt.candidateHead) return;
            proofDigests.push(seal!.digest);
            const execution = await readExecution(checked.value.acceptance.executionArtifact);
            if (execution === null) return;
            proofDigests.push(sha256(execution));
          }
        }
        for (const seals of Object.values(receipt.reviews)) {
          if ((seals.attestation.value as {schemaVersion?: number}).schemaVersion !== 3) return;
          proofDigests.push(seals.attestation.digest, seals.report.digest);
        }
        if (state.resolutions.some(r => r.receipt?.digest === delivered.digest && r.findingDigest === attempt.findingDigest)) return;
        const resolution: FollowupResolution = { at: new Date().toISOString(), findingDigest: attempt.findingDigest,
          commit: receipt.candidateHead, targetBranch: run.targetBranch, configHash, proofKind: criterion.acceptance.mode as "behavioral" | "review-only",
          assessment: attempt.assessment, receipt: { path: run.integration.receiptPath, digest: delivered.digest, taskId: root.task.id, runId: run.runId },
          proofDigests: [...new Set(proofDigests)] };
        if (followupFindingDigest(await store.get(item.id)) !== attempt.findingDigest ||
            await resolveGitCommit(gitRunner, "HEAD") !== receipt.candidateHead || (await collectChangeSurface(gitRunner)).paths.length !== 0 ||
            (options.loadConfig !== undefined && calculateConfigHash(await options.loadConfig()) !== configHash)) return;
        await save(options.commonDir, { ...state, status: "resolved", code: "FOLLOWUP_REPAIR_PROVEN", resolutions: [...state.resolutions, resolution] });
      });
    }
  } catch (error) {
    const code = error instanceof AgentOpsError ? error.code : "FOLLOWUP_RECONCILIATION_FAILED";
    warnings.push(`followup: ${code}; completion is unchanged and the item remains retryable.`);
  }
  return warnings;
}
