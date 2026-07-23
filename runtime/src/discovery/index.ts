import { nodeDiscoveryAdapter } from "./node.js";
import type {
  DiscoveryAdapter,
  DiscoveryEvidence,
  DiscoveryResult,
} from "./types.js";

const DEFAULT_ADAPTERS: DiscoveryAdapter[] = [nodeDiscoveryAdapter];

export async function discoverProject(
  root: string,
  adapters: readonly DiscoveryAdapter[] = DEFAULT_ADAPTERS,
): Promise<DiscoveryResult> {
  const evidence: DiscoveryEvidence[] = [];

  for (const adapter of adapters) {
    const result = await adapter.discover(root);
    if (result.kind !== "no-match") {
      return result;
    }
    evidence.push(...result.evidence);
  }

  return {
    kind: "no-match",
    adapter: "orchestrator",
    reason: "unsupported-stack",
    message: "No supported technology stack was detected.",
    evidence,
    manualConfigAllowed: true,
  };
}

export { discoverNodeProject, nodeDiscoveryAdapter } from "./node.js";
export type {
  DiscoveryAdapter,
  DiscoveryConfidence,
  DiscoveryEvidence,
  DiscoveryResult,
  NoMatchDiscoveryResult,
  ProposalDiscoveryResult,
  UserDecisionDiscoveryResult,
  VerifierProposal,
} from "./types.js";
