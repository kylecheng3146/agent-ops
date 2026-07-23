import type { EvidenceRequirement } from "../contracts.js";

export type DiscoveryConfidence = "high" | "low" | "medium";

export type DiscoveryEvidenceKind = "file" | "package-script";

export interface DiscoveryEvidence {
  kind: DiscoveryEvidenceKind;
  path: string;
  detail: string;
}

export interface VerifierProposal {
  id: string;
  command: string;
  args: string[];
  cwd: string;
  required: boolean;
  evidence: EvidenceRequirement;
  sourceEvidence: DiscoveryEvidence[];
  confidence: DiscoveryConfidence;
  confirmed: false;
}

export type NodePackageManager = "bun" | "npm" | "pnpm" | "yarn";

export interface ProposalDiscoveryResult {
  kind: "proposals";
  adapter: string;
  packageManager: NodePackageManager;
  proposals: VerifierProposal[];
  evidence: DiscoveryEvidence[];
  manualConfigAllowed: true;
}

export type UserDecisionReason =
  | "invalid-package-json"
  | "missing-lockfile"
  | "multiple-package-managers"
  | "no-known-scripts";

export interface UserDecisionDiscoveryResult {
  kind: "user-decision";
  adapter: string;
  reason: UserDecisionReason;
  message: string;
  evidence: DiscoveryEvidence[];
  manualConfigAllowed: true;
}

export type NoMatchReason = "not-node-project" | "unsupported-stack";

export interface NoMatchDiscoveryResult {
  kind: "no-match";
  adapter: string;
  reason: NoMatchReason;
  message: string;
  evidence: DiscoveryEvidence[];
  manualConfigAllowed: true;
}

export type DiscoveryResult =
  | NoMatchDiscoveryResult
  | ProposalDiscoveryResult
  | UserDecisionDiscoveryResult;

export interface DiscoveryAdapter {
  id: string;
  discover(root: string): Promise<DiscoveryResult>;
}
