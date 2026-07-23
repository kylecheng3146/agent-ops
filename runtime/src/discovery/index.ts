import { goDiscoveryAdapter } from "./go.js";
import { makeDiscoveryAdapter } from "./make.js";
import { nodeDiscoveryAdapter } from "./node.js";
import { pythonDiscoveryAdapter } from "./python.js";
import { rustDiscoveryAdapter } from "./rust.js";
import type {
  DiscoveryAdapter,
  DiscoveryEvidence,
  DiscoveryResult,
  ProjectDiscovery,
  UserDecisionDiscoveryResult
} from "./types.js";

const DEFAULT_ADAPTERS: readonly DiscoveryAdapter[] = [
  nodeDiscoveryAdapter,
  pythonDiscoveryAdapter,
  goDiscoveryAdapter,
  rustDiscoveryAdapter,
  makeDiscoveryAdapter
];

export async function discoverProject(
  root: string,
  adapters: readonly DiscoveryAdapter[] = DEFAULT_ADAPTERS
): Promise<ProjectDiscovery> {
  const results = await Promise.all(
    adapters.map(async (adapter) => await adapter.discover(root))
  );
  const matched = results.filter(
    (result) => result.kind !== "no-match"
  );
  const evidence: DiscoveryEvidence[] = results.flatMap(
    (result) => result.evidence
  );
  if (matched.length > 0) {
    return {
      kind: "project",
      adapters: matched.map((result) => result.adapter),
      proposals: matched.flatMap((result) =>
        result.kind === "proposals" ? result.proposals : []
      ),
      decisions: matched.filter(
        (
          result
        ): result is UserDecisionDiscoveryResult =>
          result.kind === "user-decision"
      ),
      evidence,
      manualConfigAllowed: true
    };
  }

  return {
    kind: "no-match",
    adapter: "orchestrator",
    reason: "unsupported-stack",
    message: "No supported technology stack was detected.",
    evidence,
    manualConfigAllowed: true
  };
}

export { discoverGoProject, goDiscoveryAdapter } from "./go.js";
export { discoverMakeProject, makeDiscoveryAdapter } from "./make.js";
export { discoverNodeProject, nodeDiscoveryAdapter } from "./node.js";
export {
  discoverPythonProject,
  pythonDiscoveryAdapter
} from "./python.js";
export { discoverRustProject, rustDiscoveryAdapter } from "./rust.js";
export type {
  DiscoveryAdapter,
  DiscoveryConfidence,
  DiscoveryEvidence,
  DiscoveryResult,
  NoMatchDiscoveryResult,
  ProjectDiscovery,
  ProjectDiscoveryResult,
  ProposalDiscoveryResult,
  UserDecisionDiscoveryResult,
  VerifierProposal,
} from "./types.js";
