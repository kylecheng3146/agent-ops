import { join } from "node:path";

import { AgentOpsError } from "../fs/paths.js";
import { sha256 } from "../fs/hash.js";
import { readPrivateFile, withPrivateFileLock, writePrivateFile } from "../security/permissions.js";
import { validateReviewReport, type ReviewFinding } from "../review/report.js";
import type { DeliveredReview } from "./receipt.js";

export interface FollowupProvenance {
  readonly receiptPath: string;
  readonly receiptDigest: string;
  readonly receiptSchemaVersion: 1 | 2;
  readonly candidateHead: string;
  readonly targetCommit: string;
  readonly sourceFingerprint: string;
  readonly taskId: string;
  readonly reportDigest: string;
  readonly round: "primary" | "adversarial";
  readonly index: number;
  readonly sourceKind: "finding" | "residual-risk";
  readonly provenanceLimit: DeliveredReview["provenanceLimit"];
}

export interface FollowupHistory {
  readonly at: string;
  readonly action: "collected" | "clarified" | "accepted" | "deferred" | "reopened";
  readonly reason?: string;
  readonly finding?: ReviewFinding;
}

export interface FollowupItem {
  readonly id: string;
  readonly kind: "candidate" | "observation";
  readonly original: ReviewFinding | string;
  readonly provenance: FollowupProvenance;
  readonly clarification?: ReviewFinding;
  readonly disposition: "pending" | "accepted" | "deferred";
  readonly history: readonly FollowupHistory[];
}

export interface FollowupLedger {
  readonly schemaVersion: 1;
  readonly items: readonly FollowupItem[];
}

export function followupIdentity(provenance: FollowupProvenance): string {
  return `followup-${sha256(JSON.stringify([provenance.receiptDigest, provenance.taskId,
    provenance.reportDigest, provenance.round, provenance.sourceKind, provenance.index]))}`;
}

function invalid(): never {
  throw new AgentOpsError("FOLLOWUP_STATE_INVALID", "Followup state is malformed; preserve it for recovery.");
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && !value.includes("\0") && Buffer.byteLength(value) <= 16 * 1024;
}

/** Reuse ordinary finding validation, including safe locations and nonempty evidence. */
export function validateFollowupFinding(finding: ReviewFinding): boolean {
  return finding !== null && typeof finding === "object" && finding.blocking === false &&
    Array.isArray(finding.criterionIds) && Array.isArray(finding.locations) && validateReviewReport({
      summary: "Explicit followup clarification", results: finding.criterionIds.map(criterionId =>
        ({ criterionId, status: "PASS", summary: "Clarified", evidence: ["Explicit user clarification"] })),
      findings: [finding], residualRisks: [], changedFilesInspected: [],
      supportingFilesInspected: [...new Set(finding.locations.map(location => location?.path))]
    }, finding.criterionIds).ok;
}

function checked(value: unknown): FollowupLedger {
  if (typeof value !== "object" || value === null) invalid();
  const state = value as FollowupLedger;
  if (state.schemaVersion !== 1 || !Array.isArray(state.items) ||
      new Set(state.items.map(item => item?.id)).size !== state.items.length) invalid();
  const items: readonly FollowupItem[] = state.items;
  for (const item of items) {
    const p = item?.provenance;
    if (p === undefined || !["candidate", "observation"].includes(item.kind) ||
        !["pending", "accepted", "deferred"].includes(item.disposition) ||
        ![p.receiptDigest, p.reportDigest, p.sourceFingerprint].every(hash => typeof hash === "string" && /^[a-f0-9]{64}$/u.test(hash)) ||
        ![p.candidateHead, p.targetCommit].every(hash => typeof hash === "string" && /^[a-f0-9]{40,64}$/u.test(hash)) ||
        ![1, 2].includes(p.receiptSchemaVersion) || !text(p.taskId) || !text(p.receiptPath) ||
        !["primary", "adversarial"].includes(p.round) || !["finding", "residual-risk"].includes(p.sourceKind) ||
        !["contract-bound", "legacy-unbound-contract"].includes(p.provenanceLimit) ||
        !Number.isSafeInteger(p.index) || p.index < 0 || item.id !== followupIdentity(p) ||
        (p.sourceKind === "finding" ? typeof item.original === "string" || !validateFollowupFinding(item.original) : !text(item.original)) ||
        (item.clarification !== undefined && !validateFollowupFinding(item.clarification)) ||
        (item.kind === "observation" && (p.sourceKind !== "residual-risk" || item.clarification !== undefined)) ||
        (item.kind === "candidate" && p.sourceKind === "residual-risk" && item.clarification === undefined) ||
        !Array.isArray(item.history) || item.history.length === 0 || item.history[0].action !== "collected" ||
        item.history.some((event: FollowupHistory) => event === null || typeof event.at !== "string" || !Number.isFinite(Date.parse(event.at)) ||
          !["collected", "clarified", "accepted", "deferred", "reopened"].includes(event.action) ||
          (["accepted", "deferred", "clarified"].includes(event.action) && !text(event.reason)) ||
          (event.finding !== undefined && !validateFollowupFinding(event.finding)))) invalid();
  }
  return state;
}

/** One repository-local, private ledger shared by every linked checkout. */
export class FileFollowupStore {
  readonly path: string;
  constructor(readonly commonDir: string) {
    this.path = join(commonDir, "agent-ops", "followup", "ledger.json");
  }

  async read(): Promise<FollowupLedger> {
    const source = await readPrivateFile(this.path, this.commonDir);
    if (source === null) return { schemaVersion: 1, items: [] };
    if (Buffer.byteLength(source) > 16 * 1024 * 1024) invalid();
    try { return checked(JSON.parse(source) as unknown); }
    catch (error) { if (error instanceof AgentOpsError) throw error; return invalid(); }
  }

  async mutate<T>(action: (items: FollowupItem[]) => T | Promise<T>): Promise<T> {
    return await withPrivateFileLock(this.path, this.commonDir, async () => {
      const state = await this.read();
      const items = structuredClone([...state.items]);
      const before = JSON.stringify(items);
      const result = await action(items);
      checked({ schemaVersion: 1, items });
      if (JSON.stringify(items) !== before) {
        const content = `${JSON.stringify({ schemaVersion: 1, items }, null, 2)}\n`;
        if (Buffer.byteLength(content) > 16 * 1024 * 1024) invalid();
        await writePrivateFile(this.path, content, this.commonDir);
      }
      return structuredClone(result);
    });
  }

  async get(id: string): Promise<FollowupItem> {
    const item = (await this.read()).items.find(item => item.id === id);
    if (item === undefined) throw new AgentOpsError("FOLLOWUP_NOT_FOUND", "No followup item has that identity.");
    return item;
  }
}

export async function setFollowupDisposition(store: FileFollowupStore, id: string,
  action: "accept" | "defer" | "reopen", reason?: string): Promise<FollowupItem> {
  if (!["accept", "defer", "reopen"].includes(action) ||
      (action !== "reopen" && !text(reason)) || (reason !== undefined && !text(reason)))
    throw new AgentOpsError("FOLLOWUP_REASON_REQUIRED", "Accepting or deferring a followup requires a nonempty bounded reason.");
  return await store.mutate(items => {
    const index = items.findIndex(item => item.id === id);
    if (index < 0) throw new AgentOpsError("FOLLOWUP_NOT_FOUND", "No followup item has that identity.");
    const item = items[index]!;
    const next: FollowupItem = { ...item, disposition: action === "accept" ? "accepted" : action === "defer" ? "deferred" : "pending",
      history: [...item.history, { at: new Date().toISOString(), action: action === "accept" ? "accepted" : action === "defer" ? "deferred" : "reopened",
        ...(reason === undefined ? {} : { reason: reason.trim() }) }] };
    items[index] = next;
    return next;
  });
}

export async function clarifyFollowup(store: FileFollowupStore, id: string, finding: ReviewFinding, reason: string): Promise<FollowupItem> {
  if (!text(reason) || !validateFollowupFinding(finding))
    throw new AgentOpsError("FOLLOWUP_CLARIFICATION_INVALID", "Clarification requires a concrete nonblocking finding and a nonempty reason.");
  return await store.mutate(items => {
    const index = items.findIndex(item => item.id === id);
    if (index < 0) throw new AgentOpsError("FOLLOWUP_NOT_FOUND", "No followup item has that identity.");
    const item = items[index]!;
    if (item.provenance.sourceKind !== "residual-risk")
      throw new AgentOpsError("FOLLOWUP_NOT_OBSERVATION", "Only an original residual-risk observation can be clarified.");
    const next: FollowupItem = { ...item, kind: "candidate", clarification: structuredClone(finding), disposition: "pending",
      history: [...item.history, { at: new Date().toISOString(), action: "clarified", reason: reason.trim(), finding: structuredClone(finding) }] };
    items[index] = next;
    return next;
  });
}
