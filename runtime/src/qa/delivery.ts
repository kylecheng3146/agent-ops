import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentOpsConfig, ReviewTargetId } from "../contracts.js";
import { canonicalJson } from "../config/hash.js";
import { sha256 } from "../fs/hash.js";
import { AgentOpsError } from "../fs/paths.js";
import { removeTemporary } from "../fs/temporary.js";
import type { CriteriaReviewView } from "../review/criteria.js";
import type { NativeGoalHost } from "../run/hosts/types.js";
import type { NativeHostKind } from "../run/types.js";
import type { StoredTaskRecord } from "../task/store.js";
import { collectChangeSurface, resolveGitCommit, type GitRunner } from "../verify/change-surface.js";
import type { FileEvidenceStore } from "../verify/evidence.js";
import type { VerificationProcessRunner } from "../verify/spawn.js";
import { resumeQaAuthor, runQaAuthor, type QaAuthorResult } from "./author.js";
import { FULL_QA_SCOPE, qaDeliveryTree, qaDeliveryVersion, type QaDeliveryScope } from "./gate.js";
import { importQaMaterials } from "./materials.js";
import { runQaPlanning } from "./planning.js";
import { requireQaPlatform } from "./policy.js";
import { currentQaAttestation, executeQaAttempt, qaContractsMatch, qaUsageSum, sealQaAttestation } from "./proof.js";
import { claimQaControl, releaseQaControl, stopQa, type QaProcessProbe } from "./session.js";
import type { FileQaStore } from "./store.js";
import type { QaAuthorResponse, QaControl, QaPlan, QaReference, QaState, QaUsage } from "./types.js";

export interface QaDeliveryOptions {
  readonly store: FileQaStore;
  /** The delivery checkout: the ordinary task's worktree or the run coordinator's integrated candidate. */
  readonly root: string;
  readonly rootTaskId: string;
  readonly records: readonly StoredTaskRecord[];
  readonly config: AgentOpsConfig;
  readonly trusted: boolean;
  readonly scope?: QaDeliveryScope;
  /** The same source fingerprint rule the delivery gate and verify use for this candidate. */
  readonly fingerprint: () => Promise<string>;
  readonly gitRunner: GitRunner;
  readonly processRunner: VerificationProcessRunner;
  readonly evidenceStore: FileEvidenceStore;
  readonly controllerId: string;
  readonly available: readonly ReviewTargetId[];
  readonly implementationHost: ReviewTargetId | null;
  readonly implementationSessionId: string;
  readonly advisory: CriteriaReviewView | null;
  readonly host: (kind: NativeHostKind) => NativeGoalHost;
  /** Parent directory for isolated QA author checkouts; a failed one is preserved for diagnosis. */
  readonly checkouts?: string;
  /** Timing of a plan this call has to make; a supplement to an earlier early plan stays early. */
  readonly timing?: "early" | "late";
  /** Production task creation: plan before implementation, never execute. */
  readonly planOnly?: boolean;
  readonly explicit?: boolean;
  readonly planningRunner?: VerificationProcessRunner;
  readonly platform?: NodeJS.Platform;
  readonly signal?: AbortSignal;
  readonly now?: () => string;
  readonly probe?: QaProcessProbe;
  readonly log?: (line: string) => void;
}
export interface QaDeliveryResult {
  readonly taskId: string;
  readonly state: QaState;
  readonly blockers: readonly string[];
  /** `qa:<report digest>:<index>` for blocking reproducible findings: pin, repair, commit and run QA again. */
  readonly pins: readonly string[];
  readonly plan: QaReference | null;
  readonly report: QaReference | null;
  readonly attestation: QaReference | null;
  readonly candidateCommit: string;
  /** QA materials were committed into the delivery checkout, so HEAD moved. */
  readonly imported: boolean;
  readonly requestedEdits: QaAuthorResponse["requestedEdits"];
  /** Planner and author sessions this call started; reuse spends none. */
  readonly sessions: number;
  readonly usage: QaUsage;
}

const UNKNOWN_USAGE: QaUsage = {inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null};

/**
 * The one QA step for an integrated delivery, shared by ordinary verify/advance and the native
 * supervisor's finalize and land: plan if needed, author fresh material in an isolated session,
 * import and commit it, execute every case on the final candidate, then seal. Every waiting,
 * repair or blocked state returns its blockers; nothing here waives a failure.
 */
export async function runQaDelivery(options: QaDeliveryOptions): Promise<QaDeliveryResult> {
  const now = options.now ?? (() => new Date().toISOString());
  const log = options.log ?? (() => undefined);
  requireQaPlatform(options.platform);
  const {store, rootTaskId: taskId} = options;
  const tree = qaDeliveryTree(options.records, taskId);
  const root = tree[0];
  if (root?.task.qa === undefined) throw new AgentOpsError("QA_NOT_ENROLLED", `${taskId} is not an enrolled delivery root; QA is not required.`);
  const tasks = tree.map(r => r.task), scope = options.scope ?? FULL_QA_SCOPE;
  const version = async () => qaDeliveryVersion({tasks, config: options.config,
    candidateCommit: await resolveGitCommit(options.gitRunner, "HEAD"), sourceFingerprint: await options.fingerprint()});
  let current = await version(), sessions = 0, usage = UNKNOWN_USAGE, imported = false;
  let requestedEdits: QaAuthorResponse["requestedEdits"] = [];
  const result = async (state: QaState, blockers: readonly string[] = [], pins: readonly string[] = []): Promise<QaDeliveryResult> => {
    const control = await store.readControl(taskId);
    return {taskId, state, blockers, pins, plan: control?.plan ?? null, report: control?.report ?? null,
      attestation: state === "passed" ? control?.attestation ?? null : null, candidateCommit: current.candidateCommit, imported,
      requestedEdits, sessions, usage};
  };
  // Unchanged conditions: the sealed verdict stands and no model is called.
  if (!options.planOnly && await currentQaAttestation(store, current) !== null) return await result("passed");
  // QA authors from, imports into and executes an exact commit; uncommitted work would be proof of nothing.
  if (!options.planOnly && (await collectChangeSurface(options.gitRunner)).paths.length > 0)
    throw new AgentOpsError("QA_CANDIDATE_UNCOMMITTED", `Commit the delivery before independent QA for ${taskId}; QA tests an exact committed candidate.`);
  let control = await store.readControl(taskId);
  if (control !== null && !control.continuation && options.explicit !== true)
    throw new AgentOpsError("QA_CONTINUATION_DISABLED", `QA for ${taskId} was stopped; only an explicit QA command may continue it.`);
  let plan: QaPlan | null = control?.plan == null ? null : await store.get({...control.plan, kind: "plan"});
  const ids = tasks.map(t => t.id);
  const planCurrent = plan !== null && qaContractsMatch(plan.version, current) && canonicalJson(plan.taskIds) === canonicalJson(ids) &&
    plan.scope === scope.scope && canonicalJson([...plan.dependencyTaskIds].sort()) === canonicalJson([...scope.dependencyTaskIds].sort());
  if (!planCurrent) {
    log(`QA planning for ${taskId}: one independent read-only planner session.`);
    const surface = root.task.surface;
    const planned = await runQaPlanning({store, root: options.root, version: current,
      originalGoal: root.task.goal ?? root.task.intent ?? root.task.title, tasks, dependencyTaskIds: scope.dependencyTaskIds, scope: scope.scope,
      timing: plan?.timing === "early" ? "early" : options.timing ?? "late",
      ...(surface !== undefined && "included" in surface ? {surfaceIds: surface.included.map(s => s.id)} : {}),
      runners: options.trusted ? options.config.verification.acceptanceRunners ?? [] : [], advisory: options.advisory,
      ...(root.createdSourceCommit === undefined ? {} : {baselineCommit: root.createdSourceCommit}),
      available: options.available, implementationHost: options.implementationHost, implementationSessionId: options.implementationSessionId,
      controllerId: options.controllerId, ...(options.explicit === undefined ? {} : {explicit: options.explicit}),
      ...(options.planningRunner === undefined ? {} : {runner: options.planningRunner}), ...(options.signal === undefined ? {} : {signal: options.signal}),
      now, ...(options.probe === undefined ? {} : {probe: options.probe})});
    sessions++; usage = planned.usage;
    control = await store.readControl(taskId);
    if (planned.state !== "plan-ready") return await result(planned.state, planned.state === "awaiting-input" ? await openQuestions(store, control!) : planned.blockers);
    plan = await store.get({...control!.plan!, kind: "plan"});
  }
  if (options.planOnly) return await result(control!.state, control!.state === "awaiting-input" ? await openQuestions(store, control!) : []);
  control = control!;
  const planRef = control.plan!;
  if (control.state === "awaiting-input") return await result("awaiting-input", await openQuestions(store, control));
  const environment = plan!.environment.filter(e => e.required && e.status !== "available").map(e => `environment:${e.name}`);
  if (environment.length > 0) return await result("blocked", environment);
  const baselineCommit = root.createdSourceCommit;
  if (baselineCommit === undefined) throw new AgentOpsError("QA_BASELINE_REQUIRED", `${taskId} has no immutable creation baseline for red checks.`);
  const head = current.candidateCommit;
  // The previous author's committed materials still describe this plan: re-execute them on this candidate, no new session.
  const previous = control.attempt === null ? null : await store.get({...control.attempt, kind: "attempt"});
  let reusable = previous !== null && previous.plan.digest === planRef.digest && previous.lineage !== undefined;
  for (const material of reusable ? previous!.materials : []) {
    const blob = await options.gitRunner.run(["show", `${head}:${material.path}`]);
    if (blob.exitCode !== 0 || sha256(Buffer.from(blob.stdout)) !== material.digest) reusable = false;
  }
  let author: Parameters<typeof executeQaAttempt>[0]["author"];
  if (reusable) {
    const held = await claimQaControl(store, {taskId, controllerId: options.controllerId, session: previous!.session, state: "testing",
      ...(options.explicit === undefined ? {} : {explicit: options.explicit}), now: now(), ...(options.probe === undefined ? {} : {probe: options.probe})});
    const released = await releaseQaControl(store, held, {state: "testing"}, now());
    author = {session: previous!.session, generation: released.generation, startedAt: now(), usage: UNKNOWN_USAGE, materials: previous!.materials,
      materialDigest: previous!.materialDigest, observations: [], questions: [],
      // The same candidate keeps its import lineage; a later one names the earlier import its materials came from.
      lineage: previous!.lineage!.importedCommit === head ? previous!.lineage! : previous!.materials.length === 0 ? {authoredCommit: head, importedCommit: head}
        : {authoredCommit: head, importedCommit: head, materialsFrom: previous!.lineage!.materialsFrom ?? previous!.lineage!.importedCommit}};
  } else {
    const startedAt = now();
    let authored: QaAuthorResult;
    let parent: string | undefined;
    if (control.native !== undefined && control.state === "blocked") {
      log(`QA author for ${taskId}: resuming the paused native session.`);
      authored = await resumeQaAuthor({store, version: current, plan: planRef, controllerId: options.controllerId, host: options.host,
        ...(options.explicit === undefined ? {} : {explicit: options.explicit}), ...(options.signal === undefined ? {} : {signal: options.signal}),
        now, ...(options.probe === undefined ? {} : {probe: options.probe})});
    } else {
      log(`QA author for ${taskId}: one fresh isolated writable session.`);
      parent = await mkdtemp(join(options.checkouts ?? tmpdir(), `agent-ops-qa-${taskId.slice(0, 40)}-`));
      authored = await runQaAuthor({store, root: options.root, version: current, plan: planRef, checkout: join(parent, "checkout"),
        available: options.available, implementationHost: options.implementationHost, implementationSessionId: options.implementationSessionId,
        controllerId: options.controllerId, host: options.host, ...(options.explicit === undefined ? {} : {explicit: options.explicit}),
        ...(options.signal === undefined ? {} : {signal: options.signal}), now, ...(options.probe === undefined ? {} : {probe: options.probe})});
    }
    sessions++; usage = qaUsageSum(usage, authored.usage); requestedEdits = authored.inspected.requestedEdits;
    const material = await importQaMaterials({checkout: authored.checkout, target: options.root, inspected: authored.inspected, taskId});
    imported = material.lineage.importedCommit !== material.lineage.authoredCommit;
    // Imported bytes are committed and verified; the isolated clone is no longer diagnostic.
    if (parent !== undefined) await removeTemporary(parent);
    current = await version();
    author = {session: authored.session, generation: authored.control.generation, startedAt, usage: authored.usage, materials: material.materials,
      materialDigest: material.materialDigest, lineage: material.lineage, observations: authored.response.observations, questions: authored.response.questions};
  }
  const executed = await executeQaAttempt({store, root: options.root, version: current, baselineCommit, config: options.config,
    trusted: options.trusted, gitRunner: options.gitRunner, processRunner: options.processRunner, evidenceStore: options.evidenceStore,
    author, now, ...(options.signal === undefined ? {} : {signal: options.signal})});
  const report = await store.get({...executed.report, kind: "report"});
  const pins = report.findings.flatMap((f, i) => f.blocking && f.reproducible ? [`qa:${executed.report.digest}:${i}`] : []);
  if (executed.state !== "testing") return await result(executed.state, executed.blockers, pins);
  try {
    await sealQaAttestation({store, version: current, tasks, gitRunner: options.gitRunner, now});
  } catch (error) {
    // Seal refusals (unmet case, missing decision or environment, mechanical downgrade) leave QA testing, not passed.
    if (error instanceof AgentOpsError && error.code.startsWith("QA_")) return await result("testing", [error.message], pins);
    throw error;
  }
  return await result("passed");
}

/** Required questions of the current plan and report without a genuine recorded answer. */
async function openQuestions(store: FileQaStore, control: QaControl): Promise<string[]> {
  if (control.plan === null) return [];
  const plan = await store.get({...control.plan, kind: "plan"});
  const report = control.report === null ? null : await store.get({...control.report, kind: "report"});
  const answered = await Promise.all((control.decisions ?? []).map(ref => store.get({...ref, kind: "decision"})));
  return [...plan.questions, ...(report?.questions ?? [])].filter(q => q.required &&
    !answered.some(d => d.questionId === q.id && d.plan.digest === control.plan!.digest)).map(q => `question:${q.id}`);
}

/** A delivery path refuses to continue without QA PASS; the code names what the developer or human does next. */
export function qaDeliveryError(result: QaDeliveryResult): AgentOpsError {
  const code = result.state === "awaiting-repair" ? "QA_REPAIR_REQUIRED" : result.state === "awaiting-input" ? "QA_AWAITING_INPUT"
    : result.state === "blocked" ? "QA_BLOCKED" : "QA_NOT_PASSED";
  const next = result.state === "awaiting-repair"
    ? ` Repair the product (QA writes no product code), pin each with agent-ops task pin-finding ${result.taskId} <pin> --expected-contract <hash> --criterion-file <json>, commit, then run QA again; pins: ${result.pins.join(", ") || "none"}.`
    : result.state === "awaiting-input" ? " Relay the QA question to a human; only their genuine answer may be recorded, never an agent's." : "";
  return new AgentOpsError(code, `Independent QA for ${result.taskId} is ${result.state}: ${result.blockers.join("; ") || "no PASS"}.${next} Inspect with agent-ops qa show --task ${result.taskId}.`);
}

/**
 * Run Stop also owns its delivery's QA writer: fence it and confirm the registered group died.
 * Without a live writer nothing changes, so waiting for input or repair is never mistaken for a stop.
 */
export async function stopLiveQaWriter(store: FileQaStore, taskId: string, now: string, probe?: QaProcessProbe): Promise<boolean> {
  if ((await store.readControl(taskId))?.owner == null) return false;
  await stopQa(store, taskId, now, probe);
  return true;
}
