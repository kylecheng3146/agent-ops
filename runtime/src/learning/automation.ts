import {randomUUID} from "node:crypto";
import {join} from "node:path";
import type {AgentOpsConfig} from "../contracts.js";
import {readPrivateFile, withPrivateFileLock, writePrivateFile} from "../security/permissions.js";
import {candidateKey, CandidateStore, type CandidateRecord} from "./history.js";
import {digest, hash, invalid, object, parseProposal, redactData, LEARNING_LIMITS, type Proposal} from "./data.js";
import {EVALUATOR, learningConditions, runLearningTrial, type LearningCall} from "./experiment.js";
import {FileLearningStore, type LearningState} from "./store.js";
import {resolveLearningSetup, type LearningSetup} from "./setup.js";
import type {LearningSource} from "./intake.js";

type EligibleSetup = Extract<LearningSetup, {status: "eligible"}>;
function appendToBaseline(candidate: Proposal, baseline: Proposal["strategies"]): Proposal {
  const key = (strategy: Proposal["strategies"][number]) => candidateKey({...candidate, strategies: [strategy]});
  const known = new Set(baseline.map(key));
  return parseProposal({...candidate, strategies: [...baseline, ...candidate.strategies.filter(s => !known.has(key(s)))]});
}
export interface LearningOwner {pid: number; identity: string; group: boolean}
export interface LearningJob {
  id: string; key: string; token: string; candidateId: string; day: string;
  status: "launching" | "running" | "adopted" | "retained" | "failed";
  reason: string; owner: LearningOwner; invocations: number; retryRequested: boolean;
  input: {candidate: CandidateRecord; setup: EligibleSetup; baseline: LearningState; authority: string};
  inputDigest: string;
  trial?: string; adopted?: string | null;
}
export interface AutomationState {
  schemaVersion: 1; jobs: LearningJob[]; waiting: Record<string, string>; cursor?: number;
}
export interface LearningAutomationOptions extends LearningSource {
  loadConfig(): Promise<AgentOpsConfig>;
  authority(config: AgentOpsConfig): Promise<{allowed: boolean; fingerprint: string; reason: string}>;
  owner(): Promise<LearningOwner>;
  alive(owner: LearningOwner): Promise<boolean>;
  launch(job: LearningJob): Promise<void>;
  now?: () => Date;
}
/** UTC days count reservations, including failed launches/calls. Terminal keys survive date rollover. */
export class LearningAutomation {
  readonly path: string;
  readonly store: FileLearningStore;
  readonly candidates: CandidateStore;
  constructor(readonly options: LearningAutomationOptions) {
    this.store = new FileLearningStore(options.commonDir);
    this.candidates = new CandidateStore(options.commonDir);
    this.path = join(this.store.directory, "automation.json");
  }
  day(): string {return (this.options.now?.() ?? new Date()).toISOString().slice(0, 10);}
  async read(): Promise<AutomationState> {
    const raw = await readPrivateFile(this.path, this.options.commonDir);
    if (raw === null) return {schemaVersion: 1, jobs: [], waiting: {}};
    if (Buffer.byteLength(raw) > 4 * 1024 * 1024) invalid("Automation state exceeds bound; preserved.");
    const value: unknown = JSON.parse(raw);
    if (!object(value) || value.schemaVersion !== 1 || !Array.isArray(value.jobs) || !object(value.waiting) ||
      (value.cursor !== undefined && (!Number.isSafeInteger(value.cursor) || (value.cursor as number) < 0)) ||
      !Object.values(value.waiting).every(v => typeof v === "string") || !value.jobs.every(j => object(j) && hash(j.id) && hash(j.key) &&
        hash(j.token) && hash(j.candidateId) && typeof j.day === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(j.day) &&
        ["launching", "running", "adopted", "retained", "failed"].includes(String(j.status)) && typeof j.reason === "string" &&
        typeof j.retryRequested === "boolean" && Number.isSafeInteger(j.invocations) && (j.invocations as number) >= 0 &&
        (j.invocations as number) <= LEARNING_LIMITS.invocations && object(j.input) && j.inputDigest === digest(j.input) && object(j.owner) &&
        Number.isSafeInteger(j.owner.pid) && (j.owner.pid as number) > 0 && typeof j.owner.identity === "string" && typeof j.owner.group === "boolean") ||
        new Set(value.jobs.map(j => (j as LearningJob).id)).size !== value.jobs.length) invalid("Invalid automation state; preserved.");
    return value as unknown as AutomationState;
  }
  async change<T>(action: (state: AutomationState) => Promise<T>): Promise<T> {
    return await withPrivateFileLock(this.path, this.options.commonDir, async () => {
      const state = await this.read(), result = await action(state), body = JSON.stringify(redactData(state));
      if (Buffer.byteLength(body) > 4 * 1024 * 1024) invalid("Automation history full; preserved.");
      await writePrivateFile(this.path, body, this.options.commonDir);
      return result;
    });
  }
  async status() {
    const state = await this.read(), day = this.day();
    return {...state, quota: {day, boundary: "UTC", attempts: state.jobs.filter(j => j.day === day).length,
      maximumAttempts: 2, maximumInvocations: LEARNING_LIMITS.invocations},
      usage: "CLI invocations are reservations before launch, not provider requests, tokens or money."};
  }
  async retry(id: string): Promise<void> {
    await this.change(async state => {
      const job = state.jobs.find(j => j.id === id);
      if (job === undefined || ["launching", "running"].includes(job.status)) invalid("Retry requires a terminal automatic trial.");
      job.retryRequested = true;
    });
  }
  async reconcile(): Promise<LearningJob | null> {
    const ids = await this.candidates.ids();
    // No candidates means no launch, model call, or daily reservation from history import alone.
    if (ids.length === 0) return null;
    const snapshot = await this.read();
    for (const job of snapshot.jobs.filter(j => ["launching", "running"].includes(j.status)))
      if (await this.options.alive(job.owner)) return null;
    // Bound foreground Git/source validation; rotate so durable pending work cannot starve.
    const cursor = (snapshot.cursor ?? 0) % ids.length;
    const selected = [...ids.slice(cursor), ...ids.slice(0, cursor)].slice(0, 4);
    const config = await this.options.loadConfig(), authority = await this.options.authority(config);
    const prepared = await Promise.all(selected.map(async id => {
      try {
        const candidate = await this.candidates.read(id);
        const setup = authority.allowed ? await resolveLearningSetup({...this.options, config, candidate})
          : {status: "waiting" as const, reason: authority.reason};
        return {id, candidate, setup};
      } catch {return {id, candidate: null, setup: {status: "waiting" as const, reason: "CANDIDATE_INVALID"}};}
    }));
    const reserved = await this.change(async state => {
      state.cursor = (cursor + selected.length) % ids.length;
      for (const job of state.jobs.filter(j => ["launching", "running"].includes(j.status))) {
        if (!await this.options.alive(job.owner)) {job.status = "failed"; job.reason = "OWNER_EXITED_NO_RETRY";}
      }
      if (state.jobs.some(j => ["launching", "running"].includes(j.status))) return null;
      const {state: baseline, version} = await this.store.current();
      for (const item of prepared) {
        if (!authority.allowed) {state.waiting[item.id] = authority.reason; continue;}
        if (item.setup.status !== "eligible" || item.candidate === null) {state.waiting[item.id] = item.setup.reason; continue;}
        let proposal: Proposal;
        try {proposal = appendToBaseline(item.candidate.proposal, version?.proposal.strategies ?? []);}
        catch {state.waiting[item.id] = "CANDIDATE_CONFLICTS_WITH_BASELINE"; continue;}
        if (version !== null && candidateKey(version.proposal) === candidateKey(proposal)) {
          state.waiting[item.id] = "ALREADY_ADOPTED"; continue;
        }
        const key = digest({candidate: candidateKey(proposal), setup: item.setup.fingerprint,
          baseline: {generation: baseline.generation, active: baseline.active}, authority: authority.fingerprint,
          evaluator: EVALUATOR, conditions: learningConditions(item.setup.settings, {})});
        const previous = state.jobs.filter(j => j.key === key).at(-1);
        if (previous !== undefined && !previous.retryRequested) {delete state.waiting[item.id]; continue;}
        if (state.jobs.filter(j => j.day === this.day()).length >= 2) {state.waiting[item.id] = "DAILY_QUOTA"; continue;}
        let owner: LearningOwner;
        try {owner = await this.options.owner();}
        catch {state.waiting[item.id] = "OWNER_UNAVAILABLE"; continue;}
        if (previous !== undefined) previous.retryRequested = false;
        const input = structuredClone({candidate: item.candidate, setup: item.setup, baseline, authority: authority.fingerprint});
        const job: LearningJob = {id: digest(randomUUID()), token: digest(randomUUID()), key, candidateId: item.id, day: this.day(),
          status: "launching", reason: "RESERVED", owner, invocations: 0, retryRequested: false,
          input, inputDigest: digest(input)};
        state.jobs.push(job); delete state.waiting[item.id];
        return structuredClone(job);
      }
      return null;
    });
    if (reserved !== null) {
      try {await this.options.launch(reserved);}
      catch {await this.fail(reserved.id, reserved.token, "LAUNCH_FAILED_NO_RETRY");}
    }
    return reserved;
  }
  async fail(id: string, token: string, reason: string): Promise<void> {
    await this.change(async state => {
      const job = state.jobs.find(j => j.id === id && j.token === token);
      if (job !== undefined && ["launching", "running"].includes(job.status)) {job.status = "failed"; job.reason = reason;}
    });
  }
  /** Bind a dormant child before allowing any provider execution. */
  async bind(id: string, token: string, owner: LearningOwner): Promise<void> {
    await this.change(async state => {
      const job = state.jobs.find(j => j.id === id && j.token === token);
      if (job?.status !== "launching") invalid("Automatic trial is no longer reserved.");
      job.owner = owner; job.status = "running"; job.reason = "RUNNING";
    });
  }
  async current(job: LearningJob): Promise<boolean> {
    const config = await this.options.loadConfig(), authority = await this.options.authority(config);
    if (!authority.allowed || authority.fingerprint !== job.input.authority) return false;
    const candidate = await this.candidates.read(job.candidateId);
    if (digest(candidate) !== digest(job.input.candidate)) return false;
    const setup = await resolveLearningSetup({...this.options, config, candidate});
    if (setup.status !== "eligible" || setup.fingerprint !== job.input.setup.fingerprint) return false;
    const baseline = await this.store.read();
    return baseline.generation === job.input.baseline.generation && baseline.active === job.input.baseline.active;
  }
  async execute(id: string, token: string, call: LearningCall): Promise<void> {
    const job = (await this.read()).jobs.find(j => j.id === id && j.token === token);
    if (job?.status !== "running" || digest(job.owner) !== digest(await this.options.owner())) invalid("Automatic trial owner mismatch.");
    try {
      if (!await this.current(job)) throw new Error("CONDITIONS_CHANGED");
      const {candidate, setup} = job.input, source = candidate.history[0]!;
      const baseline = job.input.baseline.active === null ? [] : (await this.store.version(job.input.baseline.active)).proposal.strategies;
      const proposal = appendToBaseline(candidate.proposal, baseline);
      const counted: LearningCall = async (prompt, schema) => {
        if (!await this.current(job)) throw new Error("CONDITIONS_CHANGED");
        await this.change(async state => {
          const active = state.jobs.find(j => j.id === id && j.token === token);
          if (active?.status !== "running" || active.invocations >= LEARNING_LIMITS.invocations) throw new Error("QUOTA_EXCEEDED");
          active.invocations++;
        });
        return await call(prompt, schema);
      };
      const result = await runLearningTrial({store: this.store, settings: setup.settings, suite: setup.suite, suiteCommit: setup.suiteCommit,
        source: {receipt: source.provenance.receiptDigest, taskId: source.tasks[0]!.id, commit: source.provenance.candidateHead,
          evidence: {history: candidate.history}}, suppliedCandidates: [proposal], baselineState: job.input.baseline,
        call: counted, isCurrent: async () => await this.current(job)});
      await this.change(async state => {
        const active = state.jobs.find(j => j.id === id && j.token === token);
        if (active?.status !== "running") invalid("Automatic trial was fenced.");
        active.status = result.adopted !== null ? "adopted" : result.trial.status === "RETAIN_BASELINE" ? "retained" : "failed";
        active.reason = result.trial.status === "PASS" && result.adopted === null ? "ADOPTION_FENCED" : result.trial.reason;
        active.trial = result.artifact; active.adopted = result.adopted;
      });
    } catch {await this.fail(id, token, "EXECUTION_FAILED_OR_CHANGED_NO_RETRY");}
  }
}
