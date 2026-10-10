import {randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import {join} from "node:path";
import {canonicalJson, calculateConfigHash} from "../config/hash.js";
import type {AgentOpsConfig, VerificationEvidence} from "../contracts.js";
import {sha256} from "../fs/hash.js";
import {AgentOpsError} from "../fs/paths.js";
import {readPrivateFile} from "../security/permissions.js";
import {validateEvidence} from "../schema/validate.js";
import {FileEvidenceStore} from "../verify/evidence.js";
import {acceptanceCoverage} from "../verify/acceptance-coverage.js";
import {collectBaseChangePaths, collectChangeSurface, type GitRunner} from "../verify/change-surface.js";
import {calculateSourceFingerprint} from "../verify/source-fingerprint.js";
import {resolveReviewScope} from "../review/scope.js";
import {runVerificationCommand} from "../verify/spawn.js";
import {checkTaskVerificationEvidence} from "./completion.js";
import {taskContractHash,criterionContractHash} from "./contract.js";
import {DEBUG_EXTENSION_MS, debugProofDigest, debugRemainingMs, debugRounds, debugStopCause, type DebugState, type DebugReceipt, type DebugHypothesis} from "./debug-state.js";
import {FileTaskStore, type TaskStore, type StoredTaskRecord} from "./store.js";
import type {VerificationReport} from "../verify/service.js";
import type {TaskService} from "./service.js";
import {readDebugUserEvent} from "./debug-user-event.js";
import {readWorktreeRecord} from "../parallel/service.js";
import {evaluateGuardrail} from "../guardrails/evaluate.js";
import {nativeProcessIdentity} from "../run/transport.js";

interface DebugOptions {
  root: string;
  store: TaskStore;
  tasks: TaskService;
  gitRunner: GitRunner;
  loadConfig: () => Promise<AgentOpsConfig>;
  base?: string;
}
function fail(code: string, message: string): never {throw new AgentOpsError(code,message);}
const bounded = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= 4096 && !v.includes("\0");
const session = (v: string): boolean => bounded(v) && v.length <= 256;

async function processState(operation: NonNullable<DebugState["operation"]>): Promise<"alive" | "dead" | "unknown"> {
  if (operation.processId === undefined || operation.processIdentity === undefined) return "unknown";
  try {
    process.kill(operation.processId, 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "dead";
    if (code !== "EPERM") return "unknown";
  }
  const identity = await nativeProcessIdentity(operation.processId);
  if (identity === null) return "unknown";
  return identity === operation.processIdentity ? "alive" : "dead";
}
export class DebugService {
  constructor(private readonly options: DebugOptions) {}
  async root(taskId: string): Promise<StoredTaskRecord & {debug: DebugState}> {
    const state = await this.options.store.read();
    const task = state.tasks.find(r=>r.task.id === taskId);
    let root = state.tasks.find(r=>r.task.id === task?.task.debug?.rootTaskId);
    if(root?.debug !== undefined && root.debug.ownerRoot !== this.options.root) {
      const owner=root.debug.ownerRoot;
      root=(await new FileTaskStore(join(owner,".agent-ops/tasks/state.json"),owner).read()).tasks.find(r=>r.task.id === task?.task.debug?.rootTaskId);
      if(root?.debug?.ownerRoot !== owner) fail("TASK_DEBUG_ROOT_MISMATCH","Original issue owner is unavailable; never recreate its counters.");
    }
    if (task === undefined || root?.debug === undefined) return fail("TASK_DEBUG_REQUIRED","This task is not attached to an original debug issue.");
    if (root.debug.rootTaskId !== root.task.id || root.task.goal !== task.task.goal) return fail("TASK_DEBUG_ROOT_MISMATCH","Debug root identity and original goal must match.");
    return root as StoredTaskRecord & {debug:DebugState};
  }
  async #mutate(previous: StoredTaskRecord & {debug:DebugState}, next: DebugState): Promise<void> {
    const owner=previous.debug.ownerRoot;
    const store=owner === this.options.root ? this.options.store : new FileTaskStore(join(owner,".agent-ops/tasks/state.json"),owner);
    await store.mutate(state=>{
      const index = state.tasks.findIndex(r=>r.task.id === previous.task.id);
      if (index < 0 || canonicalJson(state.tasks[index]) !== canonicalJson(previous)) fail("TASK_DEBUG_STATE_CHANGED","Concurrent state preserved; reload the debug issue.");
      state.tasks[index] = {...previous,debug:next,updatedAt:new Date().toISOString()};
    });
  }
  async #scope(taskId: string) {
    const task = await this.options.tasks.status({taskId});
    const config = await this.options.loadConfig();
    const surface=await collectChangeSurface(this.options.gitRunner);
    let scope;
    try {scope=surface.paths.length > 0 ? {mode:"worktree" as const,changedFiles:surface.paths} : await resolveReviewScope({root:this.options.root,runner:this.options.gitRunner,
      ...(this.options.base === undefined ? {} : {base:this.options.base}), ...(task.noChangePaths === undefined ? {} : {noChangePaths:task.noChangePaths})});}
    catch (error) {if (!(error instanceof AgentOpsError) || error.code !== "REVIEW_NO_CHANGE_SURFACE") throw error; scope={mode:"worktree" as const,changedFiles:surface.paths};}
    return {task,config,sourceFingerprint:await calculateSourceFingerprint(this.options.root,scope,this.options.gitRunner)};
  }
  async #productDigest(state: DebugState): Promise<string> {
    const records = await this.options.tasks.list();
    const materials = new Set(records.flatMap(r=>r.task.criteria.flatMap(c=>c.acceptance?.bindings.flatMap(b=>b.materials.map(m=>m.path)) ?? [])));
    const paths = new Set([...await collectBaseChangePaths(this.options.gitRunner,state.baselineCommit), ...(await collectChangeSurface(this.options.gitRunner)).paths]);
    const product = [...paths].filter(path=>!materials.has(path) && !/(?:^|\/)(?:tests?|fixtures)(?:\/|$)|(?:\.test|\.spec)\./u.test(path)).sort();
    const entries: {path:string; hash:string}[] = [];
    for (const path of product) {
      try {entries.push({path,hash:sha256(await readFile(join(this.options.root,path)))});}
      catch (error) {if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; entries.push({path,hash:sha256("deleted")});}
    }
    return sha256(canonicalJson(entries));
  }
  /** Seal an operation only after its persisted process identity proves death. */
  async #recoverInterrupted(root: StoredTaskRecord & {debug:DebugState}): Promise<StoredTaskRecord & {debug:DebugState}> {
    const operation = root.debug.operation;
    if (operation === null) return root;
    const state = await processState(operation);
    if (state === "alive") fail("TASK_DEBUG_OPERATION_RUNNING","The previous debug operation is still alive; preserve its checkpoint and do not take it over.");
    if (state === "unknown") fail("TASK_DEBUG_OPERATION_RECOVERY_REQUIRED","The previous debug operation has no trustworthy process-death proof; preserve it and obtain host reconciliation.");
    const finishedAt = Date.now();
    const durationMs = Math.max(0,finishedAt-operation.startedAt);
    const foreground = root.debug.foreground;
    const foregroundBeforeOperation = foreground === undefined || foreground === null ? 0 : Math.max(0,Math.min(finishedAt,operation.startedAt)-foreground.startedAt);
    const receipt: DebugReceipt = {
      id: operation.id,
      taskId: operation.taskId,
      kind: operation.kind,
      contractHash: operation.contractHash,
      configHash: operation.configHash,
      sourceFingerprint: operation.sourceFingerprint,
      productDigest: operation.productDigest,
      durationMs,
      finishedAt,
      round: false,
      progress: [],
      references: [`operation:${operation.id}`],
      outcome: "UNKNOWN",
      cause: "environment"
    };
    const next = {...root.debug,operation:null,foreground:null,consumedMs:root.debug.consumedMs+foregroundBeforeOperation+durationMs,
      receipts:[...root.debug.receipts,receipt],checkpoint:null};
    await this.#mutate(root,next);
    return await this.root(root.task.id);
  }
  async #evidence(taskId: string, reference: string): Promise<VerificationEvidence> {
    const {task,config,sourceFingerprint} = await this.#scope(taskId);
    const store = new FileEvidenceStore(this.options.root,this.options.root);
    const checked = validateEvidence(await store.load(reference));
    if (!checked.ok) return fail("TASK_DEBUG_EVIDENCE_INVALID","Use an actual current acceptance execution reference.");
    const e = checked.value, p = e.acceptance;
    const root = await this.root(taskId);
    const head=await this.options.gitRunner.run(["rev-parse","HEAD"]);
    const candidate=new TextDecoder().decode(head.stdout).trim();
    if (head.exitCode !== 0 || e.taskId !== taskId || e.taskContractHash !== taskContractHash(task.task) || e.configHash !== calculateConfigHash(config) ||
        e.sourceFingerprint !== sourceFingerprint || p === undefined || p.pairedCommit !== (p.phase === "baseline" ? candidate : root.debug.baselineCommit) || p.commit !== (p.phase === "baseline" ? root.debug.baselineCommit : candidate) ||
        !task.task.criteria.some(c=>c.id === e.criterionId && p.criterionContractHash === criterionContractHash(c) && c.acceptance?.bindings.some(b=>b.runnerId === e.commandId && sha256(canonicalJson({runnerId:b.runnerId,materials:b.materials})) === p.bindingHash) && c.acceptance?.mode === "behavioral" && c.acceptance.baselineCommit === root.debug.baselineCommit))
      return fail("TASK_DEBUG_EVIDENCE_STALE","Evidence must discriminate the original issue at its immutable baseline and current candidate.");
    const source = await readPrivateFile(join(this.options.root,p.executionArtifact),this.options.root);
    if (source === null || p.executionArtifact !== ".agent-ops/tasks/acceptance/"+sha256(source)+".json") return fail("TASK_DEBUG_EVIDENCE_INVALID","Execution artifact is missing or modified.");
    const actual = JSON.parse(source);
    if (actual.run?.completed !== true || actual.aggregate?.status === "UNKNOWN" || actual.commit !== p.commit || actual.pairedCommit !== p.pairedCommit || actual.runner?.id !== e.commandId || actual.phase !== p.phase ||
        actual.materialDigest !== p.materialDigest || actual.executionDigest !== p.executionDigest ||
        p.checks.some(check=>!actual.run.results?.some((r:{checkId:string;status:string;failureClass:string;attempts:number})=>r.checkId === check.checkId && r.status === check.status && r.attempts === 1 &&
          (r.failureClass === "assertion-failed" ? "assertion" : r.failureClass) === check.failureClass)))
      return fail("TASK_DEBUG_EVIDENCE_INVALID","Only completed, single-attempt assertion execution can resolve a hypothesis.");
    return e;
  }
  async hypothesis(taskId: string, input: {id:string;statement:string;method:string;expected:string;reason?:string;reference?:string;checkId?:string;expectedStatus?:"PASS"|"FAIL"}): Promise<DebugHypothesis> {
    if (Object.keys(input).some(k=>!["id","statement","method","expected","reason","reference","checkId","expectedStatus"].includes(k)) ||
        ![input.id,input.statement,input.method,input.expected,input.checkId].every(bounded) || !["PASS","FAIL"].includes(input.expectedStatus ?? "")) fail("TASK_DEBUG_HYPOTHESIS_INVALID","A hypothesis needs a bounded statement, verification method and expected result; status is runtime-derived.");
    if (evaluateGuardrail({kind:"content",content:JSON.stringify(input),scope:this.options.root}).action === "block") fail("TASK_DEBUG_SENSITIVE_INPUT","Do not save literal credentials in hypothesis proof.");
    const root = await this.root(taskId), next = structuredClone(root.debug);
    if (root.status !== "active" || next.operation !== null) fail("TASK_DEBUG_BUSY","Hypothesis changes need an active idle issue.");
    let h = next.hypotheses.find(h=>h.id === input.id);
    if (h === undefined) {
      if (next.hypotheses.length >= 32) fail("TASK_DEBUG_HISTORY_LIMIT","Hypothesis history is full; preserve it and report the blocker.");
      h = {id:input.id,statement:input.statement,method:input.method,expected:input.expected,checkId:input.checkId!,expectedStatus:input.expectedStatus!,status:"proposed",supporting:[],opposing:[],actual:"",history:[]};
      next.hypotheses.push(h);
    } else if (h.statement !== input.statement || h.method !== input.method || h.expected !== input.expected || h.checkId !== input.checkId || h.expectedStatus !== input.expectedStatus) fail("TASK_DEBUG_HYPOTHESIS_IMMUTABLE","Retain the hypothesis and create a distinct falsifiable alternative.");
    if (input.reference !== undefined) {
      const e = await this.#evidence(taskId,input.reference);
      const check = e.acceptance!.checks.find(c=>c.checkId === input.checkId);
      if (!root.debug.regressionChecks.includes(e.commandId+":"+input.checkId) || check === undefined || !["PASS","FAIL"].includes(check.status) || !["PASS","FAIL"].includes(input.expectedStatus ?? "") ||
          (check.status === "FAIL" && check.failureClass !== "assertion")) fail("TASK_DEBUG_HYPOTHESIS_UNPROVEN","Name a real discriminating check and its expected outcome.");
      if (h.status === "rejected" && (!bounded(input.reason) || [...h.supporting,...h.opposing].includes(input.reference)))
        fail("TASK_DEBUG_REJECTED_CAUSE","A rejected cause needs new discriminating evidence and a preserved reopening reason.");
      const matches = check.status === input.expectedStatus;
      h.actual = `${e.acceptance!.phase}:${check.checkId}:${check.status}`;
      h.status = matches ? "confirmed" : "rejected";
      (matches ? h.supporting : h.opposing).push(input.reference);
      h.history.push({status:h.status,actual:h.actual,references:[input.reference],reason:input.reason ?? "Runtime-reloaded discriminating assertion result."});
    } else if (h.status === "rejected") fail("TASK_DEBUG_REJECTED_CAUSE","Rejected hypotheses cannot reopen without new evidence.");
    next.checkpoint = null;
    await this.#mutate(root,next);
    return structuredClone(h);
  }
  async strategy(taskId: string, input: {from:string;to:string;reason:string;reference:string}): Promise<void> {
    const root = await this.root(taskId);
    if (Object.keys(input).some(k=>!["from","to","reason","reference"].includes(k)) || !Object.values(input).every(bounded) ||
        input.to.trim().length < 20 || input.reason.trim().length < 20 || input.from.replace(/\W/gu,"").toLowerCase() === input.to.replace(/\W/gu,"").toLowerCase())
      fail("TASK_DEBUG_STRATEGY_INVALID","Document a substantive different verification method and evidence-backed reason.");
    if (debugStopCause(root.debug) !== "strategy-required" || root.debug.strategy !== null || root.debug.operation !== null)
      fail("TASK_DEBUG_STRATEGY_NOT_ALLOWED","Exactly one strategy switch is allowed after two stagnant repair rounds.");
    await this.#evidence(taskId,input.reference);
    await this.#mutate(root,{...root.debug,strategy:{from:input.from,to:input.to,reason:input.reason,references:[input.reference],afterRound:debugRounds(root.debug)},checkpoint:null});
  }
  async remaining(taskId: string): Promise<number> {return debugRemainingMs((await this.root(taskId)).debug);}
  async #begin(taskId: string, kind: DebugReceipt["kind"]) {
    let root = await this.root(taskId);
    root = await this.#recoverInterrupted(root);
    const {task,config,sourceFingerprint} = await this.#scope(taskId);
    if (root.status !== "active" || root.debug.operation !== null) fail("TASK_DEBUG_BUSY","The original issue has a running or interrupted operation; preserve its checkpoint.");
    if (root.debug.receipts.length >= 256) fail("TASK_DEBUG_HISTORY_LIMIT","Execution history is full; retain it and report the blocker.");
    const productDigest = await this.#productDigest(root.debug);
    const previousCandidate = root.debug.receipts.filter(r=>r.kind === "verify" && (r.outcome === "PASS" || r.outcome === "FAIL")).at(-1)?.productDigest ?? sha256("[]");
    const latestAttempt = root.debug.receipts.filter(r=>r.kind === "verify").at(-1)?.productDigest ?? sha256("[]");
    const cause = debugStopCause(root.debug);
    if (cause !== null && !(["environment","permission"].includes(cause) && (kind === "investigate" || kind === "verify" && productDigest === latestAttempt)) && !(cause === "iterations" && kind === "review" && productDigest === previousCandidate))
      fail("TASK_DEBUG_STOP_REQUIRED",`Runtime stop predicate: ${cause}. Record a checkpoint; resume alone cannot reset it.`);
    const processIdentity = await nativeProcessIdentity(process.pid);
    if (processIdentity === null) fail("TASK_DEBUG_PROCESS_IDENTITY_REQUIRED","The host cannot prove the debug operation process identity; preserve the issue and report the unsupported environment.");
    const operation = {id:randomUUID(),taskId,kind,startedAt:Date.now(),contractHash:taskContractHash(task.task),configHash:calculateConfigHash(config),sourceFingerprint,productDigest,processId:process.pid,processIdentity};
    await this.#mutate(root,{...root.debug,operation,checkpoint:null});
    return operation;
  }
  async #end(operation: NonNullable<DebugState["operation"]>, outcome: DebugReceipt["outcome"], references: string[], progress: string[], cause: DebugReceipt["cause"]) {
    const root = await this.root(operation.taskId);
    if (root.debug.operation?.id !== operation.id) fail("TASK_DEBUG_OPERATION_CHANGED","The timed operation changed; its result cannot be adopted.");
    const finishedAt = Date.now();
    const durationMs = Math.max(0,finishedAt-operation.startedAt);
    const previous = root.debug.receipts.filter(r=>r.kind === "verify" && (r.outcome === "PASS" || r.outcome === "FAIL")).at(-1)?.productDigest ?? sha256("[]");
    const round = operation.kind === "verify" && (outcome === "PASS" || outcome === "FAIL") && operation.productDigest !== previous;
    const receipt: DebugReceipt = {id:operation.id,taskId:operation.taskId,kind:operation.kind,contractHash:operation.contractHash,configHash:operation.configHash,
      sourceFingerprint:operation.sourceFingerprint,productDigest:operation.productDigest,durationMs,finishedAt,round,progress,references,outcome,cause};
    const foreground = root.debug.foreground;
    const operationBeforeForeground = foreground === undefined || foreground === null ? durationMs : Math.max(0,Math.min(finishedAt,foreground.startedAt)-operation.startedAt);
    const next = {...root.debug,operation:null,consumedMs:root.debug.consumedMs+operationBeforeForeground,receipts:[...root.debug.receipts,receipt],checkpoint:null};
    await this.#mutate(root,next);
  }
  /** Called only around the existing verifier; outcomes are reloaded from sealed evidence. */
  async verification<T extends VerificationReport>(taskId: string, execute: () => Promise<T>): Promise<T> {
    const initial=await this.root(taskId);
    if (initial.debug.regressionChecks.length === 0) {
      const record=await this.options.tasks.status({taskId});
      const checks=[...new Set(record.task.criteria.flatMap(c=>c.acceptance?.mode === "behavioral" ? c.acceptance.bindings.flatMap(b=>(b.redCheckIds ?? []).map(id=>b.runnerId+":"+id)) : []))];
      if (checks.length > 0) await this.#mutate(initial,{...initial.debug,regressionChecks:checks});
    }
    const operation = await this.#begin(taskId,"verify");
    try {
      const result = await execute();
      const {task,config,sourceFingerprint} = await this.#scope(taskId);
      const store = new FileEvidenceStore(this.options.root,this.options.root);
      const coverage = await acceptanceCoverage(task,config,sourceFingerprint,store);
      const problem = await checkTaskVerificationEvidence(task,{root:this.options.root,config,sourceFingerprint,evidenceStore:store});
      const root = await this.root(taskId);
      const previousProgress = new Set(root.debug.receipts.flatMap(r=>r.progress));
      const proven = coverage.filter(row=>row.mode === "behavioral" && row.status === "proven").flatMap(row=>{
        const criterion=task.task.criteria.find(c=>c.id === row.criterionId);
        return criterion?.acceptance?.bindings.flatMap(b=>(b.redCheckIds ?? []).map(id=>b.runnerId+":"+id).filter(id=>root.debug.regressionChecks.includes(id))) ?? [];
      });
      const resolved = root.debug.hypotheses.filter(h=>["confirmed","rejected"].includes(h.status)).map(h=>"hypothesis:"+h.actual);
      const progress = [...proven,...resolved].filter(id=>!previousProgress.has(id));
      const refs = [...new Set(Object.values(task.evidence).flat().filter(r=>!r.startsWith("review:")))];
      let environment = false;
      for (const reference of refs) {const checked=validateEvidence(await store.load(reference)); if (checked.ok && checked.value.sourceFingerprint === operation.sourceFingerprint && checked.value.taskContractHash === operation.contractHash && checked.value.status === "UNKNOWN" && checked.value.failureClass !== "debug-budget-exhausted" && !(checked.value.failureClass.includes("timeout") && await this.remaining(taskId) === 0)) environment=true;}
      await this.#end(operation,problem === null ? "PASS" : environment ? "UNKNOWN" : "FAIL",refs,progress,environment ? "environment" : null);
      return result;
    } catch (error) {if ((await this.root(taskId)).debug.operation?.id === operation.id) await this.#end(operation,"UNKNOWN",[],[],error instanceof AgentOpsError && error.code === "TASK_DEBUG_BUDGET_EXHAUSTED" ? null : error instanceof AgentOpsError && /TRUST|DENIED|PERMISSION/u.test(error.code) ? "permission" : "environment"); throw error;}
  }
  async review<T extends {status:string}>(taskId: string, execute: () => Promise<T>): Promise<T> {
    const operation = await this.#begin(taskId,"review");
    try {const result=await execute(); await this.#end(operation,result.status === "PASS" ? "PASS" : result.status === "FAIL" ? "FAIL" : "UNKNOWN",[],[],null); return result;}
    catch (error) {if ((await this.root(taskId)).debug.operation?.id === operation.id) await this.#end(operation,"UNKNOWN",[],[],"environment"); throw error;}
  }
  async investigate(taskId: string, commandId: string, trusted: boolean) {
    const current=await this.root(taskId);
    if (current.debug.receipts.at(-1)?.cause !== null && current.debug.receipts.at(-1)?.cause !== undefined && current.debug.receipts.at(-1)?.references[0] !== "command:"+commandId)
      fail("TASK_DEBUG_RECOVERY_COMMAND_REQUIRED","Retry the same blocked command or original regression verifier; unrelated green commands cannot clear a blocker.");
    const operation = await this.#begin(taskId,"investigate");
    try {
      const config = await this.options.loadConfig();
      const command = config.verification.commands.find(c=>c.id === commandId);
      if (!trusted || command === undefined) fail("TASK_DEBUG_COMMAND_DENIED","Investigation executes only a currently trusted configured command.");
      const result = await runVerificationCommand({...command,timeoutMs:Math.min(command.timeoutMs ?? 300_000,await this.remaining(taskId))},{cwd:command.cwd === "." ? this.options.root : join(this.options.root,command.cwd)});
      await this.#end(operation,result.status,["command:"+commandId],[],result.status === "UNKNOWN" && !(result.timedOut && await this.remaining(taskId) === 0) ? "environment" : null);
      return result;
    } catch (error) {if ((await this.root(taskId)).debug.operation?.id === operation.id) await this.#end(operation,"UNKNOWN",[],[],error instanceof AgentOpsError && /DENIED/u.test(error.code) ? "permission" : "environment"); throw error;}
  }
  /** Start measuring one native foreground turn; host hooks are the only callers. */
  async foregroundStart(taskId: string, sessionId: string): Promise<void> {
    if (!session(sessionId)) fail("TASK_DEBUG_SESSION_INVALID","A native session identity is required for foreground timing.");
    let root = await this.root(taskId);
    root = await this.#recoverInterrupted(root);
    if (root.status !== "active" || root.debug.operation !== null) fail("TASK_DEBUG_BUSY","Foreground timing requires an active idle debug issue.");
    const current = root.debug.foreground;
    if (current !== undefined && current !== null) {
      const cause = debugStopCause(root.debug);
      if (current.sessionId === sessionId && (cause === null || cause === "environment" || cause === "permission")) return;
      fail("TASK_DEBUG_CLOCK_CONTESTED","A different or exhausted foreground turn owns the debug clock; preserve it and wait for its native stop event.");
    }
    const cause = debugStopCause(root.debug);
    if (cause !== null && cause !== "environment" && cause !== "permission")
      fail("TASK_DEBUG_STOP_REQUIRED",`Runtime stop predicate: ${cause}. Obtain the required checkpoint or human grant before starting another turn.`);
    await this.#mutate(root,{...root.debug,foreground:{sessionId,startedAt:Date.now()},checkpoint:null});
  }
  /** Close a native foreground turn and account only time outside a running operation. */
  async foregroundStop(taskId: string, sessionId: string): Promise<void> {
    if (!session(sessionId)) return;
    let root = await this.root(taskId);
    root = await this.#recoverInterrupted(root);
    const foreground = root.debug.foreground;
    if (foreground === undefined || foreground === null) return;
    if (foreground.sessionId !== sessionId) fail("TASK_DEBUG_CLOCK_OWNER_MISMATCH","Only the native session that opened the debug clock may close it.");
    const now = Date.now();
    const end = root.debug.operation?.startedAt ?? now;
    const durationMs = Math.max(0,Math.min(now,end)-foreground.startedAt);
    await this.#mutate(root,{...root.debug,foreground:null,consumedMs:root.debug.consumedMs+durationMs,checkpoint:null});
  }
  async checkpoint(taskId: string, sessionId: string): Promise<DebugState> {
    const recovered = await this.#recoverInterrupted(await this.root(taskId));
    const root = recovered, {task,config} = await this.#scope(taskId);
    const attached = await this.options.tasks.status({sessionId});
    if (attached.task.debug?.rootTaskId !== root.task.id || root.debug.operation !== null) fail("TASK_DEBUG_CHECKPOINT_INVALID","A stopped checkpoint must belong to this idle attached issue.");
    const cause = debugStopCause(root.debug);
    const latest=root.debug.receipts.at(-1);
    if ((cause === "environment" || cause === "permission") && (latest?.contractHash !== taskContractHash(task.task) || latest.configHash !== calculateConfigHash(config) || latest.sourceFingerprint !== (await this.#scope(taskId)).sourceFingerprint))
      fail("TASK_DEBUG_CHECKPOINT_INVALID","Blocked receipt must still match its current task, source and policy.");
    const receiptId = root.debug.receipts.at(-1)?.id ?? "intake:"+root.task.id;
    const surface=await collectChangeSurface(this.options.gitRunner);
    const sourceFingerprint=await calculateSourceFingerprint(this.options.root,{mode:"worktree",changedFiles:surface.paths},this.options.gitRunner);
    const next={...root.debug,checkpoint:{taskId,sessionId,root:this.options.root,sourceFingerprint,contractHash:taskContractHash(task.task),configHash:calculateConfigHash(config),cause,receiptId}};
    await this.#mutate(root,next);
    return next;
  }
  async validCheckpoint(taskId:string,sessionId:string,sourceFingerprint:string): Promise<boolean> {
    const root=await this.root(taskId), checkpoint=root.debug.checkpoint;
    const {task,config}=await this.#scope(taskId);
    return root.debug.operation === null && checkpoint !== null && checkpoint.taskId === taskId && checkpoint.sessionId === sessionId &&
      checkpoint.root === this.options.root && checkpoint.sourceFingerprint === sourceFingerprint && checkpoint.contractHash === taskContractHash(task.task) &&
      checkpoint.configHash === calculateConfigHash(config) && checkpoint.cause !== null && checkpoint.cause === debugStopCause(root.debug) &&
      checkpoint.receiptId === (root.debug.receipts.at(-1)?.id ?? "intake:"+root.task.id);
  }
  async proofDigest(taskId:string):Promise<string> {return debugProofDigest((await this.root(taskId)).debug);}
  async resume(taskId:string,sessionId:string):Promise<void> {
    const root=await this.#recoverInterrupted(await this.root(taskId)), checkpoint=root.debug.checkpoint, record=await readWorktreeRecord(this.options.root);
    const task=await this.options.tasks.status({taskId}), config=await this.options.loadConfig();
    const surface=await collectChangeSurface(this.options.gitRunner);
    const fingerprint=await calculateSourceFingerprint(this.options.root,{mode:"worktree",changedFiles:surface.paths},this.options.gitRunner);
    if (root.debug.operation !== null || checkpoint === null || record === null || record.path !== this.options.root || record.sessionId !== checkpoint.sessionId ||
        checkpoint.root !== record.path || checkpoint.taskId !== taskId || checkpoint.sourceFingerprint !== fingerprint ||
        checkpoint.contractHash !== taskContractHash(task.task) || checkpoint.configHash !== calculateConfigHash(config))
      fail("TASK_DEBUG_RECOVERY_CONFIRMATION_REQUIRED","Owned debug checkpoint/path/source/contract/config mismatch. Preserve the checkout and obtain user confirmation before recovery.");
    await this.options.tasks.attach(sessionId,root.task.id);
  }
  async extend(taskId:string,sessionId:string,eventId:string):Promise<void> {
    const root=await this.root(taskId),attached=await this.options.tasks.status({sessionId});
    if (attached.task.debug?.rootTaskId !== root.task.id || root.debug.operation !== null || root.debug.foreground !== undefined && root.debug.foreground !== null) fail("TASK_DEBUG_GRANT_INVALID","Extension belongs to the idle original issue and its native session.");
    const record=await readWorktreeRecord(this.options.root);
    const event=await readDebugUserEvent(record?.mainRoot ?? this.options.root,sessionId);
    if (eventId !== "latest" && eventId !== event.id) fail("TASK_DEBUG_GRANT_INVALID","The requested event is not the current native human event.");
    if (root.debug.grants.some(g=>g.eventId === event.id)) return;
    const otherCause=debugStopCause({...root.debug,consumedMs:0,budgetMs:86_400_000});
    const latestFinishedAt=root.debug.receipts.at(-1)?.finishedAt;
    if (debugRemainingMs(root.debug) !== 0 || otherCause !== null || !/^(?:繼續|继续|continue)[。.!！]?$/iu.test(event.text.trim()) ||
        latestFinishedAt !== undefined && event.timestamp < latestFinishedAt)
      fail("TASK_DEBUG_GRANT_INVALID","Only a contemporaneous human continue event extends exhausted time; other blockers remain authoritative.");
    await this.#mutate(root,{...root.debug,grants:[...root.debug.grants,{eventId:event.id,sessionId,sourceDigest:event.sourceDigest,grantedMs:DEBUG_EXTENSION_MS}],checkpoint:null});
  }
}
