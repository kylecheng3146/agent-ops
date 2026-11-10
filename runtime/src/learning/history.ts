import {join} from "node:path";
import {globsOverlap} from "../escape/lessons.js";
import {readPrivateFile, withPrivateFileLock, writePrivateFile} from "../security/permissions.js";
import {digest, exact, hash, invalid, object, parseProposal, redactData, text, type Proposal} from "./data.js";
import type {HistoricalCaseContext} from "./intake.js";

export interface HistoricalCandidate {sourceCaseIds: string[]; proposal: Proposal}
export interface HistoricalAdvice {candidates?: HistoricalCandidate[]; historicalUses?: {caseId: string; use: string}[]}
export interface CandidateRecord {
  schemaVersion: 1; proposal: Proposal; history: HistoricalCaseContext[];
  author: {taskId: string; attemptId: string; snapshotHash: string; reportDigest?: string};
}
function authorReportPath(commonDir: string, author: CandidateRecord["author"]): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(author.taskId) || !/^[a-zA-Z0-9-]{1,64}$/u.test(author.attemptId)) invalid("Invalid author report identity.");
  return join(commonDir, "agent-ops", "criteria-advisory", `${author.taskId}-${author.attemptId}.json`);
}
/** Bind the complete seen input, not just the historical cases the author chose to cite. */
export async function candidateAuthorSnapshot(commonDir: string, candidate: CandidateRecord): Promise<Record<string, unknown>> {
  if (!hash(candidate.author.reportDigest)) invalid("Candidate has no bound author report.");
  const raw = await readPrivateFile(authorReportPath(commonDir, candidate.author), commonDir);
  if (raw === null || Buffer.byteLength(raw) > 256 * 1024 || digest(raw) !== candidate.author.reportDigest) invalid("Author report changed or unavailable.");
  const report: unknown = JSON.parse(raw);
  if (!object(report) || report.kind !== "criteria-advisory" || report.status !== "COMPLETED" ||
      report.code !== "CRITERIA_REVIEW_COMPLETED" || report.taskId !== candidate.author.taskId ||
      report.attemptId !== candidate.author.attemptId || report.snapshotHash !== candidate.author.snapshotHash ||
      !object(report.snapshot) || !Array.isArray(report.snapshot.history) || !object(report.advice) ||
      !validateHistoricalAdvice(report.advice) || !Array.isArray(report.advice.candidates)) invalid("Invalid author report.");
  const history = report.snapshot.history;
  if (!candidate.history.every(context => history.some(item => digest(item) === digest(context))) ||
      !report.advice.candidates.some(row => object(row) && digest(row.proposal) === digest(candidate.proposal) &&
        Array.isArray(row.sourceCaseIds) && digest([...row.sourceCaseIds].sort()) === digest(candidate.history.map(h => h.id).sort())))
    invalid("Candidate does not match its author report.");
  return report.snapshot;
}
export function historicalAdviceSchema(base: Record<string, unknown>): Record<string, unknown> {
  const string = {type: "string", minLength: 1, maxLength: 2048};
  return {...base, properties: {...base.properties as object,
    historicalUses: {type: "array", maxItems: 3, items: {type: "object", additionalProperties: false,
      required: ["caseId", "use"], properties: {caseId: string, use: string}}},
    candidates: {type: "array", maxItems: 2, items: {type: "object", additionalProperties: false,
      required: ["sourceCaseIds", "proposal"], properties: {
        sourceCaseIds: {type: "array", minItems: 1, maxItems: 3, items: string},
        proposal: {type: "object", additionalProperties: false, required: ["strategies", "expectedImprovement", "failureCondition"],
          properties: {expectedImprovement: string, failureCondition: string, strategies: {type: "array", minItems: 1, maxItems: 4,
            items: {type: "object", additionalProperties: false, required: ["id", "paths", "cue", "check"],
              properties: {id: string, cue: string, check: string, paths: {type: "array", minItems: 1, maxItems: 8, items: string}}}}}}}}}}};
}
/** Legacy advice remains valid; new optional fields never confer adoption authority. */
export function validateHistoricalAdvice(value: unknown, history?: readonly HistoricalCaseContext[], paths?: readonly string[]): boolean {
  if (!object(value)) return false;
  try {
    if (value.historicalUses !== undefined && (!Array.isArray(value.historicalUses) || value.historicalUses.length > 3 ||
      !value.historicalUses.every(row => object(row) && exact(row, ["caseId", "use"]) && hash(row.caseId) && text(row.use) &&
        (history === undefined || history.some(c => c.id === row.caseId))))) return false;
    if (value.candidates === undefined) return true;
    if (!Array.isArray(value.candidates) || value.candidates.length > 2 || Buffer.byteLength(JSON.stringify(value.candidates)) > 16000) return false;
    const seen = new Set<string>();
    for (const row of value.candidates) {
      if (!object(row) || !exact(row, ["sourceCaseIds", "proposal"]) || !Array.isArray(row.sourceCaseIds) ||
        row.sourceCaseIds.length < 1 || row.sourceCaseIds.length > 3 || !row.sourceCaseIds.every(hash) ||
        new Set(row.sourceCaseIds).size !== row.sourceCaseIds.length) return false;
      const proposal = parseProposal(row.proposal);
      if (proposal.strategies.length < 1 || proposal.strategies.length > 4) return false;
      const sourceIds = row.sourceCaseIds as string[];
      const sources = history?.filter(c => sourceIds.includes(c.id));
      if (sources !== undefined && sources.length !== row.sourceCaseIds.length) return false;
      if (paths !== undefined && proposal.strategies.some(s => s.paths.some(p => !paths.some(q => globsOverlap(p, q)) ||
        !sources?.some(c => c.paths.some(q => globsOverlap(p, q)))))) return false;
      const key = candidateKey(proposal);
      if (seen.has(key)) return false;
      seen.add(key);
    }
    return true;
  } catch {return false;}
}
/** Content/scope identity ignores author-chosen IDs and array order. Evaluation conditions are added by the controller. */
export function candidateKey(proposal: Proposal): string {
  return digest(proposal.strategies.map(({paths, cue, check}) => ({paths: [...paths].sort(), cue, check}))
    .sort((a, b) => digest(a).localeCompare(digest(b))));
}
export class CandidateStore {
  readonly directory: string;
  constructor(readonly commonDir: string) {this.directory = join(commonDir, "agent-ops", "learning", "candidates");}
  async ids(): Promise<string[]> {
    const raw = await readPrivateFile(join(this.directory, "index.json"), this.commonDir);
    if (raw === null) return [];
    if (Buffer.byteLength(raw) > 1024 * 1024) invalid("Candidate index exceeds bound; preserved.");
    const ids: unknown = JSON.parse(raw);
    if (!Array.isArray(ids) || !ids.every(hash) || new Set(ids).size !== ids.length) invalid("Invalid candidate index; preserved.");
    return ids;
  }
  async read(id: string): Promise<CandidateRecord> {
    if (!hash(id)) invalid("Invalid candidate identity.");
    const raw = await readPrivateFile(join(this.directory, id + ".json"), this.commonDir);
    if (raw === null || Buffer.byteLength(raw) > 32000) invalid("Candidate missing or oversized.");
    const value = JSON.parse(raw) as CandidateRecord;
    if (digest(value) !== id || value.schemaVersion !== 1 || !Array.isArray(value.history) || value.history.length > 3 ||
      !object(value.author) || !text(value.author.taskId, 128) || !text(value.author.attemptId, 64) || !hash(value.author.snapshotHash) ||
      (value.author.reportDigest !== undefined && !hash(value.author.reportDigest))) invalid("Invalid candidate record.");
    parseProposal(value.proposal);
    return value;
  }
  async enqueue(input: {taskId: string; attemptId: string; snapshotHash: string; history: HistoricalCaseContext[]; candidates: HistoricalCandidate[]}): Promise<string[]> {
    if (!validateHistoricalAdvice({candidates: input.candidates}, input.history, input.history.flatMap(c => c.paths))) invalid("Invalid historical candidates.");
    if (input.candidates.length === 0) return [];
    const report = await readPrivateFile(authorReportPath(this.commonDir, input), this.commonDir);
    if (report === null || Buffer.byteLength(report) > 256 * 1024) invalid("Author report unavailable or oversized.");
    return await withPrivateFileLock(join(this.directory, "index.json"), this.commonDir, async () => {
      const ids = await this.ids(), added: string[] = [];
      for (const candidate of input.candidates) {
        const value = redactData({schemaVersion: 1, proposal: candidate.proposal,
          history: input.history.filter(c => candidate.sourceCaseIds.includes(c.id)),
          author: {taskId: input.taskId, attemptId: input.attemptId, snapshotHash: input.snapshotHash, reportDigest: digest(report)}}) as CandidateRecord;
        // Preserve each immutable author/source record; execution dedup includes evaluation conditions later.
        const id = digest(value), body = JSON.stringify(value);
        if (Buffer.byteLength(body) > 32000) invalid("Candidate exceeds bound.");
        const path = join(this.directory, id + ".json"), previous = await readPrivateFile(path, this.commonDir);
        if (previous !== null && previous !== body) invalid("Immutable candidate changed.");
        if (previous === null) await writePrivateFile(path, body, this.commonDir);
        if (!ids.includes(id)) {ids.push(id); added.push(id);}
      }
      const body = JSON.stringify(ids);
      if (Buffer.byteLength(body) > 1024 * 1024) invalid("Candidate index full; preserved.");
      await writePrivateFile(join(this.directory, "index.json"), body, this.commonDir);
      return added;
    });
  }
}
