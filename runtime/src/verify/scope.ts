import type { AgentOpsConfig, PathMapping } from "../contracts.js";
import { AgentOpsError } from "../fs/paths.js";

export type ScopeSelectionReason =
  | "mapped"
  | "no-changes"
  | "unknown-path"
  | "ambiguous-path"
  | "conflicting-scope"
  | "empty-mapping";

export interface ScopeMappingEvidence {
  readonly changedPath: string;
  readonly mappingPaths: readonly string[];
  readonly verifierIds: readonly string[];
}

export interface ScopeSelectionEvidence {
  readonly changedPaths: readonly string[];
  readonly mappings: readonly ScopeMappingEvidence[];
  readonly requiredVerifierIds: readonly string[];
}

export interface ScopeSelection {
  readonly verifierIds: readonly string[];
  readonly fallback: boolean;
  readonly reason: ScopeSelectionReason;
  readonly evidence: ScopeSelectionEvidence;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function mappingMatches(path: string, mapping: PathMapping): boolean {
  return path === mapping.path || path.startsWith(`${mapping.path}/`);
}

function mappingEvidence(
  path: string,
  mappings: readonly PathMapping[]
): ScopeMappingEvidence {
  return {
    changedPath: path,
    mappingPaths: sortedUnique(mappings.map((mapping) => mapping.path)),
    verifierIds: sortedUnique(
      mappings.flatMap((mapping) => mapping.verifierIds)
    )
  };
}

function sameVerifierIds(
  left: readonly string[],
  right: readonly string[]
): boolean {
  return (
    left.length === right.length &&
    left.every((verifierId, index) => verifierId === right[index])
  );
}

function fallbackSelection(
  reason: Exclude<ScopeSelectionReason, "mapped">,
  evidence: ScopeSelectionEvidence
): ScopeSelection {
  if (evidence.requiredVerifierIds.length === 0) {
    return { verifierIds: [], fallback: true, reason, evidence };
  }
  return {
    verifierIds: evidence.requiredVerifierIds,
    fallback: true,
    reason,
    evidence
  };
}

export function selectVerificationScope(
  paths: readonly string[],
  config: AgentOpsConfig
): ScopeSelection {
  const changedPaths = sortedUnique(paths);
  const requiredVerifierIds = sortedUnique(
    config.verification.commands
      .filter((command) => command.required)
      .map((command) => command.id)
  );
  const mappings = changedPaths.map((changedPath) => {
    const matches = config.pathMappings.filter((mapping) =>
      mappingMatches(changedPath, mapping)
    );
    return mappingEvidence(changedPath, matches);
  });
  const evidence: ScopeSelectionEvidence = {
    changedPaths,
    mappings,
    requiredVerifierIds
  };

  if (changedPaths.length === 0) {
    return fallbackSelection("no-changes", evidence);
  }
  if (mappings.some((mapping) => mapping.mappingPaths.length === 0)) {
    return fallbackSelection("unknown-path", evidence);
  }
  if (mappings.some((mapping) => mapping.mappingPaths.length > 1)) {
    return fallbackSelection("ambiguous-path", evidence);
  }
  if (mappings.some((mapping) => mapping.verifierIds.length === 0)) {
    return fallbackSelection("empty-mapping", evidence);
  }

  const selectedVerifierIds = mappings[0]?.verifierIds ?? [];
  if (
    mappings.some(
      (mapping) => !sameVerifierIds(mapping.verifierIds, selectedVerifierIds)
    )
  ) {
    return fallbackSelection("conflicting-scope", evidence);
  }
  if (selectedVerifierIds.length === 0) {
    return fallbackSelection("empty-mapping", evidence);
  }

  return {
    verifierIds: selectedVerifierIds,
    fallback: false,
    reason: "mapped",
    evidence
  };
}
