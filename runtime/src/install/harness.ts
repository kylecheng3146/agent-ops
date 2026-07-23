import type { Harness, InstallScope, Profile } from "../contracts.js";
import { AgentOpsError } from "../fs/paths.js";
import type { Capability } from "./types.js";

export type HarnessId = "codex" | "claude";

export interface HarnessPlanContext {
  readonly scope: InstallScope;
  readonly profiles: readonly Profile[];
  readonly capabilities: readonly Capability[];
}

export interface HarnessArtifact {
  readonly id: string;
  readonly path: string;
  readonly content: string;
}

export interface HarnessManagedBlock {
  readonly id: string;
  readonly path: string;
  readonly version: number;
  readonly content: string;
}

export interface HarnessContribution {
  readonly artifacts: readonly HarnessArtifact[];
  readonly blocks: readonly HarnessManagedBlock[];
}

export interface HarnessInstallAdapter {
  readonly id: HarnessId;
  plan(context: HarnessPlanContext): Promise<HarnessContribution>;
}

function requestedHarnessIds(harness: Harness): readonly HarnessId[] {
  return harness === "both" ? ["codex", "claude"] : [harness];
}

function selectAdapter(
  id: HarnessId,
  adapters: readonly HarnessInstallAdapter[]
): HarnessInstallAdapter {
  const matches = adapters.filter((adapter) => adapter.id === id);
  if (matches.length === 0) {
    throw new AgentOpsError(
      "HARNESS_ADAPTER_MISSING",
      `Missing harness adapter: ${id}`
    );
  }
  if (matches.length > 1) {
    throw new AgentOpsError(
      "HARNESS_ADAPTER_DUPLICATE",
      `Duplicate harness adapter: ${id}`
    );
  }

  const adapter = matches[0];
  if (adapter === undefined) {
    throw new AgentOpsError(
      "HARNESS_ADAPTER_MISSING",
      `Missing harness adapter: ${id}`
    );
  }
  return adapter;
}

export async function planHarnessContributions(
  harness: Harness,
  context: HarnessPlanContext,
  adapters: readonly HarnessInstallAdapter[]
): Promise<HarnessContribution> {
  const selectedAdapters = requestedHarnessIds(harness).map((id) =>
    selectAdapter(id, adapters)
  );
  const artifacts: HarnessArtifact[] = [];
  const blocks: HarnessManagedBlock[] = [];

  for (const adapter of selectedAdapters) {
    const contribution = await adapter.plan(context);
    artifacts.push(...contribution.artifacts);
    blocks.push(...contribution.blocks);
  }

  return { artifacts, blocks };
}
