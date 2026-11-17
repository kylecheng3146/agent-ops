import type { AcceptanceBinding, AcceptanceMaterial, ReviewTargetId } from "../contracts.js";
import type { AcceptanceRun } from "../verify/acceptance-protocol.js";
import type { ScenarioId, SurfaceScenario } from "../surface/schema.js";

export const QA_SCHEMA_VERSION = 1 as const;
export interface QaConfig { readonly enabled: boolean }
export interface QaPolicyBinding {
  readonly schemaVersion: 1;
  readonly required: true;
  readonly policyHash: string;
  readonly enrolledAt: string;
  readonly enrollment: "new" | "adopted";
  readonly late: boolean;
}
export type QaState = "planning" | "plan-ready" | "testing" | "passed" | "awaiting-repair" |
  "awaiting-input" | "blocked" | "stopped";
export type QaArtifactKind = "plan" | "attempt" | "report" | "execution" | "decision" | "attestation";
export interface QaReference { readonly kind: QaArtifactKind; readonly digest: string }
export interface QaFileReference { readonly path: string; readonly digest: string }
export interface QaMaterial extends AcceptanceMaterial { readonly digest: string }
/** All version inputs are explicit. A stored report is data, never an attestation by itself. */
export interface QaVersion {
  readonly taskId: string;
  readonly goalHash: string;
  readonly taskContractHash: string;
  readonly treeContractHash: string;
  readonly scopeHash: string;
  readonly policyHash: string;
  readonly configHash: string;
  readonly candidateCommit: string;
  readonly sourceFingerprint: string;
}
export interface QaSession {
  readonly host: ReviewTargetId;
  readonly sessionId: string;
  readonly implementationSessionId: string;
  readonly implementationHost: ReviewTargetId | null;
  readonly writable: boolean;
  readonly fallbackReason: string | null;
}
export interface QaEnvironment {
  readonly name: string;
  readonly required: boolean;
  readonly status: "available" | "missing" | "unknown";
  readonly evidence: readonly string[];
}
export interface QaQuestion {
  readonly id: string;
  readonly prompt: string;
  readonly required: boolean;
  readonly criterionIds: readonly string[];
}
export interface QaCase {
  readonly id: string;
  readonly criterionIds: readonly string[];
  readonly surfaceIds: readonly string[];
  readonly required: boolean;
  readonly mode: "behavioral" | "invariant" | "nonmechanical";
  readonly preconditions: readonly string[];
  readonly actions: readonly string[];
  readonly expected: string;
  readonly bindings: readonly AcceptanceBinding[];
  readonly nonmechanicalReason?: string;
}
export interface QaPlan {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly version: QaVersion;
  readonly originalGoal: string;
  readonly taskIds: readonly string[];
  readonly dependencyTaskIds: readonly string[];
  readonly scope: "full" | "partial";
  readonly session: QaSession;
  readonly createdAt: string;
  readonly timing: "early" | "late";
  readonly advisoryReferences: readonly QaFileReference[];
  readonly cases: readonly QaCase[];
  readonly scenarios: Readonly<Record<ScenarioId, SurfaceScenario>>;
  readonly environment: readonly QaEnvironment[];
  readonly questions: readonly QaQuestion[];
}
export interface QaUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly costUsd: number | null;
}
/** Import changes the candidate: anything observed before importedCommit is never final proof. */
export interface QaMaterialLineage {
  readonly authoredCommit: string;
  readonly importedCommit: string;
  /**
   * Re-execution of materials an earlier attempt imported: this attempt imported nothing, so authored and imported
   * name the current candidate, and this names the earlier import commit. Material digests are re-checked at the candidate.
   */
  readonly materialsFrom?: string;
}
/** What a writable QA author reports. DATA only: never a verdict, and never trusted for paths or versions. */
export interface QaAuthorResponse {
  readonly schemaVersion: 1;
  readonly generation: number;
  readonly plan: string;
  readonly candidateCommit: string;
  readonly materials: readonly (AcceptanceMaterial & { readonly caseIds: readonly string[] })[];
  /** Existing-file changes QA needs: returned to the developer, never merged from the QA checkout. */
  readonly requestedEdits: readonly { readonly path: string; readonly reason: string }[];
  readonly observations: readonly { readonly caseId: string; readonly notes: readonly string[] }[];
  readonly questions: readonly QaQuestion[];
}
export interface QaAttempt {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly version: QaVersion;
  readonly generation: number;
  readonly plan: QaReference;
  readonly session: QaSession;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly materials: readonly QaMaterial[];
  readonly materialDigest: string;
  readonly executions: readonly QaReference[];
  readonly usage: QaUsage;
  readonly lineage?: QaMaterialLineage;
}
export interface QaExecution {
  readonly schemaVersion: 1;
  readonly version: QaVersion;
  readonly caseId: string;
  readonly runnerId: string;
  readonly materialDigest: string;
  readonly run: AcceptanceRun;
  readonly evidenceReferences: readonly QaFileReference[];
}
export interface QaFinding {
  readonly id: string;
  readonly caseId: string;
  readonly criterionIds: readonly string[];
  readonly surfaceIds: readonly string[];
  readonly blocking: boolean;
  readonly introduced: boolean;
  readonly reproducible: boolean;
  readonly summary: string;
  readonly reproduction: readonly string[];
  readonly expected: string;
  readonly actual: string;
  readonly locations: readonly { readonly path: string; readonly line: number }[];
  readonly executions: readonly QaReference[];
}
export interface QaReport {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly version: QaVersion;
  readonly attempt: QaReference;
  readonly createdAt: string;
  readonly results: readonly { readonly caseId: string; readonly status: "PASS" | "FAIL" | "UNKNOWN";
    readonly executions: readonly QaReference[]; readonly observations: readonly string[] }[];
  readonly findings: readonly QaFinding[];
  readonly questions: readonly QaQuestion[];
}
export interface QaDecision {
  readonly schemaVersion: 1;
  readonly version: QaVersion;
  readonly plan: QaReference;
  readonly questionId: string;
  readonly answer: string;
  readonly answeredBy: string;
  readonly answeredAt: string;
}
/** Only the controller may issue this after validating execution, decisions and writer death. */
export interface QaAttestation {
  readonly schemaVersion: 1;
  readonly version: QaVersion;
  readonly plan: QaReference;
  readonly report: QaReference;
  readonly executions: readonly QaReference[];
  readonly decisions: readonly QaReference[];
  readonly materialDigest: string;
  readonly caseIds: readonly string[];
  /** Required cases judged by reasoned inspection: both final reviewers must examine them; never executed proof. The controller always writes it. */
  readonly nonmechanicalCaseIds?: readonly string[];
  readonly session: QaSession;
  readonly generation: number;
  readonly sealedAt: string;
}
export interface QaProgress {
  readonly semanticHash: string;
  readonly consecutive: number;
  readonly at: string;
}
export interface QaOwner {
  readonly controllerId: string;
  readonly session: QaSession;
  readonly processId: number | null;
  readonly processIdentity: string | null;
}
/** A paused native QA author: provider limits may resume; a native denial resumes only by explicit user command. */
export interface QaNativeSession {
  readonly session: QaSession;
  readonly nativeSessionId: string;
  readonly checkout: string;
  readonly reason: "provider-limit" | "denied";
  readonly resetAt: string | null;
  readonly observedAt: string;
}
export interface QaControl {
  readonly schemaVersion: 1;
  readonly taskId: string;
  readonly revision: number;
  readonly generation: number;
  readonly state: QaState;
  readonly continuation: boolean;
  readonly owner: QaOwner | null;
  readonly plan: QaReference | null;
  readonly attempt: QaReference | null;
  readonly report: QaReference | null;
  readonly attestation: QaReference | null;
  readonly progress: QaProgress | null;
  readonly updatedAt: string;
  /** Genuine human answers bound to this task's plan and report questions. */
  readonly decisions?: readonly QaReference[];
  readonly native?: QaNativeSession;
}
export interface QaArtifacts {
  plan: QaPlan;
  attempt: QaAttempt;
  execution: QaExecution;
  report: QaReport;
  decision: QaDecision;
  attestation: QaAttestation;
}
