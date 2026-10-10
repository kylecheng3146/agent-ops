import {canonicalJson} from "../config/hash.js";
import {sha256} from "../fs/hash.js";
import {AgentOpsError} from "../fs/paths.js";

export const DEBUG_DEFAULTS = {enabled: true, budgetMs: 20 * 60_000, maxRounds: 5} as const;
export type DebugCause = "budget" | "iterations" | "strategy-required" | "stagnation" | "environment" | "permission";
export interface DebugHypothesis {
  id: string;
  statement: string;
  method: string;
  expected: string;
  checkId: string;
  expectedStatus: "PASS" | "FAIL";
  status: "proposed" | "investigating" | "confirmed" | "rejected" | "inconclusive";
  supporting: string[];
  opposing: string[];
  actual: string;
  history: {status: DebugHypothesis["status"]; actual: string; references: string[]; reason: string}[];
}
export interface DebugReceipt {
  id: string;
  taskId: string;
  kind: "investigate" | "verify" | "review";
  contractHash: string;
  configHash: string;
  sourceFingerprint: string;
  productDigest: string;
  durationMs: number;
  finishedAt: number;
  round: boolean;
  progress: string[];
  references: string[];
  outcome: "PASS" | "FAIL" | "UNKNOWN";
  cause: "environment" | "permission" | null;
}
export interface DebugCheckpoint {
  taskId: string;
  sessionId: string;
  root: string;
  sourceFingerprint: string;
  contractHash: string;
  configHash: string;
  cause: DebugCause | null;
  receiptId: string;
}
export interface DebugState {
  schemaVersion: 1;
  rootTaskId: string;
  ownerRoot: string;
  baselineCommit: string;
  budgetMs: number;
  maxRounds: number;
  consumedMs: number;
  regressionChecks: string[];
  hypotheses: DebugHypothesis[];
  receipts: DebugReceipt[];
  strategy: {from: string; to: string; reason: string; references: string[]; afterRound: number} | null;
  grants: {eventId: string; sessionId: string; sourceDigest: string; grantedMs: number}[];
  operation: {id: string; startedAt: number; taskId: string; contractHash: string; configHash: string; sourceFingerprint: string; productDigest: string; kind: DebugReceipt["kind"]} | null;
  checkpoint: DebugCheckpoint | null;
}
const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 4096 && !v.includes("\0");
const hash = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/u.test(v);
const integer = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
const strings = (v: unknown) => Array.isArray(v) && v.length <= 128 && v.every(text) && new Set(v).size === v.length;
const exact = (v: unknown, names: string[]): v is Record<string, unknown> => object(v) && Object.keys(v).length === names.length && names.every(k => Object.hasOwn(v,k));
const statuses = ["proposed", "investigating", "confirmed", "rejected", "inconclusive"];
export const debugCauses: readonly DebugCause[] = ["budget", "iterations", "strategy-required", "stagnation", "environment", "permission"];
export function validDebugSettings(v: unknown): boolean {
  return exact(v,["enabled","budgetMs","maxRounds"]) && typeof v.enabled === "boolean" &&
    integer(v.budgetMs) && (v.budgetMs as number) > 0 && (v.budgetMs as number) <= 86_400_000 &&
    integer(v.maxRounds) && (v.maxRounds as number) > 0 && (v.maxRounds as number) <= 100;
}
export function validDebugIntake(v: unknown): boolean {
  return exact(v,["rootTaskId","facts","unknowns"]) && text(v.rootTaskId) && strings(v.facts) && strings(v.unknowns);
}
export function validDebugState(v: unknown): v is DebugState {
  if (!exact(v,["schemaVersion","rootTaskId","ownerRoot","baselineCommit","budgetMs","maxRounds","consumedMs","regressionChecks","hypotheses","receipts","strategy","grants","operation","checkpoint"]) ||
      v.schemaVersion !== 1 || !text(v.rootTaskId) || !text(v.ownerRoot) || typeof v.baselineCommit !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(v.baselineCommit) ||
      !validDebugSettings({enabled:true,budgetMs:v.budgetMs,maxRounds:v.maxRounds}) || !integer(v.consumedMs) || !strings(v.regressionChecks) ||
      !Array.isArray(v.hypotheses) || v.hypotheses.length > 32 || !Array.isArray(v.receipts) || v.receipts.length > 256 ||
      !Array.isArray(v.grants) || v.grants.length > 128) return false;
  for (const h of v.hypotheses) {
    if (!exact(h,["id","statement","method","expected","checkId","expectedStatus","status","supporting","opposing","actual","history"]) ||
        ![h.id,h.statement,h.method,h.expected,h.checkId].every(text) || !["PASS","FAIL"].includes(String(h.expectedStatus)) || !statuses.includes(String(h.status)) ||
        !strings(h.supporting) || !strings(h.opposing) || typeof h.actual !== "string" || h.actual.length > 4096 ||
        !Array.isArray(h.history) || h.history.length > 128 || h.history.some(entry => !exact(entry,["status","actual","references","reason"]) ||
          !statuses.includes(String(entry.status)) || typeof entry.actual !== "string" || entry.actual.length > 4096 || !strings(entry.references) || !text(entry.reason))) return false;
  }
  if (new Set(v.hypotheses.map(h => h.id)).size !== v.hypotheses.length) return false;
  for (const r of v.receipts) if (!exact(r,["id","taskId","kind","contractHash","configHash","sourceFingerprint","productDigest","durationMs","finishedAt","round","progress","references","outcome","cause"]) ||
      !text(r.id) || !text(r.taskId) || !["investigate","verify","review"].includes(String(r.kind)) ||
      ![r.contractHash,r.configHash,r.sourceFingerprint,r.productDigest].every(hash) || !integer(r.durationMs) || !integer(r.finishedAt) || typeof r.round !== "boolean" ||
      !strings(r.progress) || !strings(r.references) || !["PASS","FAIL","UNKNOWN"].includes(String(r.outcome)) || ![null,"environment","permission"].includes(r.cause as null)) return false;
  if (new Set(v.receipts.map(r => r.id)).size !== v.receipts.length || v.receipts.filter(r => r.round).length > (v.maxRounds as number)) return false;
  for (const g of v.grants) if (!exact(g,["eventId","sessionId","sourceDigest","grantedMs"]) || !text(g.eventId) || !text(g.sessionId) || !hash(g.sourceDigest) || g.grantedMs !== DEBUG_DEFAULTS.budgetMs) return false;
  if (new Set(v.grants.map(g => g.eventId)).size !== v.grants.length) return false;
  if (v.strategy !== null && (!exact(v.strategy,["from","to","reason","references","afterRound"]) ||
      ![v.strategy.from,v.strategy.to,v.strategy.reason].every(text) || v.strategy.from === v.strategy.to ||
      !strings(v.strategy.references) || !integer(v.strategy.afterRound) || (v.strategy.afterRound as number) < 2)) return false;
  if (v.operation !== null && (!exact(v.operation,["id","startedAt","taskId","contractHash","configHash","sourceFingerprint","productDigest","kind"]) ||
      !text(v.operation.id) || !integer(v.operation.startedAt) || !text(v.operation.taskId) ||
      ![v.operation.contractHash,v.operation.configHash,v.operation.sourceFingerprint,v.operation.productDigest].every(hash) ||
      !["investigate","verify","review"].includes(String(v.operation.kind)))) return false;
  if (v.checkpoint !== null && (!exact(v.checkpoint,["taskId","sessionId","root","sourceFingerprint","contractHash","configHash","cause","receiptId"]) ||
      ![v.checkpoint.taskId,v.checkpoint.sessionId,v.checkpoint.root,v.checkpoint.receiptId].every(text) ||
      ![v.checkpoint.sourceFingerprint,v.checkpoint.contractHash,v.checkpoint.configHash].every(hash) || (v.checkpoint.cause !== null && !debugCauses.includes(v.checkpoint.cause as DebugCause)))) return false;
  return true;
}
export function createDebugState(rootTaskId: string, baselineCommit: string, settings: {budgetMs:number; maxRounds:number} = DEBUG_DEFAULTS, ownerRoot = "."): DebugState {
  return {schemaVersion:1,rootTaskId,ownerRoot,baselineCommit,budgetMs:settings.budgetMs,maxRounds:settings.maxRounds,consumedMs:0,regressionChecks:[],
    hypotheses:[],receipts:[],strategy:null,grants:[],operation:null,checkpoint:null};
}
export function debugRounds(state: DebugState): number { return state.receipts.filter(r => r.round).length; }
export function debugRemainingMs(state: DebugState, now = Date.now()): number {
  return Math.max(0,state.budgetMs + state.grants.reduce((n,g)=>n+g.grantedMs,0) - state.consumedMs -
    (state.operation === null ? 0 : Math.max(0,now-state.operation.startedAt)));
}
export function debugStopCause(state: DebugState, now = Date.now()): DebugCause | null {
  const latest = state.receipts.at(-1);
  if (latest?.cause !== null && latest?.cause !== undefined) return latest.cause;
  if (debugRemainingMs(state,now) === 0) return "budget";
  if (debugRounds(state) >= state.maxRounds) return "iterations";
  const rounds = state.receipts.filter(r=>r.round);
  const since = rounds.slice(state.strategy?.afterRound ?? 0);
  let stagnant = 0;
  for (const round of [...since].reverse()) { if (round.progress.length > 0) break; stagnant++; }
  return stagnant >= 2 ? state.strategy === null ? "strategy-required" : "stagnation" : null;
}
/** Only reviewed reasoning/proof belongs in the digest; operations and clocks do not. */
export function debugProofDigest(state: DebugState): string {
  return sha256(canonicalJson({rootTaskId:state.rootTaskId,baselineCommit:state.baselineCommit,regressionChecks:state.regressionChecks,hypotheses:state.hypotheses,
    strategy:state.strategy,proof:state.receipts.filter(r=>r.kind === "verify").map(r=>({taskId:r.taskId,contractHash:r.contractHash,
      configHash:r.configHash,sourceFingerprint:r.sourceFingerprint,productDigest:r.productDigest,references:r.references,outcome:r.outcome}))}));
}
export function assertDebugState(value: unknown): asserts value is DebugState {
  if (!validDebugState(value)) throw new AgentOpsError("TASK_DEBUG_STATE_INVALID","Debug state must be strict, bounded and root-bound.");
}
export async function loadDebugProof(root: string, rootTaskId: string): Promise<DebugState> {
  const {FileTaskStore}=await import("./store.js");
  const {join}=await import("node:path");
  const record=(await new FileTaskStore(join(root,".agent-ops/tasks/state.json"),root).read()).tasks.find(r=>r.task.id === rootTaskId);
  if (record?.debug === undefined || record.task.debug?.rootTaskId !== rootTaskId)
    throw new AgentOpsError("TASK_DEBUG_ROOT_MISMATCH","Original issue proof is unavailable; do not reset its limits.");
  if(record.debug.ownerRoot !== root) {
    const owned=(await new FileTaskStore(join(record.debug.ownerRoot,".agent-ops/tasks/state.json"),record.debug.ownerRoot).read()).tasks.find(r=>r.task.id === rootTaskId);
    if(owned?.debug === undefined || owned.debug.ownerRoot !== record.debug.ownerRoot || owned.task.goal !== record.task.goal)
      throw new AgentOpsError("TASK_DEBUG_ROOT_MISMATCH","Original owned issue state is unavailable; do not recreate its budget.");
    return owned.debug;
  }
  return record.debug;
}
