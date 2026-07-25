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

export interface ProposalDiscoveryResult {
  kind: "proposals";
  adapter: string;
  proposals: VerifierProposal[];
  evidence: DiscoveryEvidence[];
  manualConfigAllowed: true;
}

export type UserDecisionReason =
  | "invalid-manifest"
  | "invalid-package-json"
  | "missing-lockfile"
  | "multiple-package-managers"
  | "no-known-commands"
  | "no-known-scripts";

export interface UserDecisionDiscoveryResult {
  kind: "user-decision";
  adapter: string;
  reason: UserDecisionReason;
  message: string;
  evidence: DiscoveryEvidence[];
  manualConfigAllowed: true;
}

export type NoMatchReason =
  | "not-go-project"
  | "not-make-project"
  | "not-node-project"
  | "not-python-project"
  | "not-rust-project"
  | "unsupported-stack";

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

export interface ProjectDiscoveryResult {
  kind: "project";
  adapters: string[];
  proposals: VerifierProposal[];
  decisions: UserDecisionDiscoveryResult[];
  evidence: DiscoveryEvidence[];
  manualConfigAllowed: true;
}

export type ProjectDiscovery =
  | NoMatchDiscoveryResult
  | ProjectDiscoveryResult;

export interface DiscoveryAdapter {
  id: string;
  discover(root: string): Promise<DiscoveryResult>;
}
