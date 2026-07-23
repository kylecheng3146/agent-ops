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

export const COMMON_AGENTS_BLOCK =
  "## Loop Engineering\n\nUse `.agent-ops/AGENTS.md` as the canonical Loop Engineering specification for this project.\n";

export const COMMON_CLAUDE_BLOCK =
  "## Loop Engineering\n\nUse `.agent-ops/CLAUDE.md` as the canonical Loop Engineering specification for this project.\n";

function managedRules(
  id: HarnessId,
  context: HarnessPlanContext
): string {
  const instructionFile = id === "codex" ? "AGENTS.md" : "CLAUDE.md";
  const lines = [
    "# Loop Engineering",
    "",
    "This routing specification is managed by `agent-ops`.",
    "",
    `Active profiles: ${context.profiles.join(", ")}`,
    `Active capabilities: ${context.capabilities.join(", ")}`,
    ""
  ];
  if (context.capabilities.includes("rules")) {
    lines.push(
      "For every change:",
      "",
      "1. Define two to five mechanically verifiable acceptance criteria.",
      "2. Inspect the smallest relevant scope and preserve unrelated changes.",
      "3. Apply the smallest safe change.",
      "4. Run evidence-producing verification for every criterion.",
      "5. Obtain independent review before claiming completion.",
      "",
      "Treat `.agent-ops/config.json` as verifier authority. Discovery output is",
      "only a proposal until a user confirms it. Repository commands require an",
      "explicit matching trust record; installation approval never grants trust.",
      ""
    );
  }
  if (context.capabilities.includes("lifecycle-summary")) {
    lines.push(
      "Advisory lifecycle summaries and local logs are informational. Advisory",
      "failures must remain fail-open and cannot become verification evidence.",
      ""
    );
  }
  if (context.capabilities.includes("command-policy")) {
    lines.push(
      "Command policy guards high-confidence unsafe actions. Optional Stop",
      "verification never marks a task complete by itself.",
      ""
    );
  }
  lines.push(
    `This file is routed from the active ${instructionFile}.`,
    ""
  );
  return lines.join("\n");
}

export function commonHarnessAdapters(): readonly HarnessInstallAdapter[] {
  return (["codex", "claude"] as const).map((id) => {
    const instructionFile = id === "codex" ? "AGENTS.md" : "CLAUDE.md";
    const blockContent =
      id === "codex" ? COMMON_AGENTS_BLOCK : COMMON_CLAUDE_BLOCK;
    return {
      id,
      async plan(context) {
        return {
          artifacts: [
            {
              id: `${id}-rules`,
              path: `.agent-ops/${instructionFile}`,
              content: managedRules(id, context)
            }
          ],
          blocks: [
            {
              id: `${id}-routing`,
              path:
                context.scope === "project"
                  ? instructionFile
                  : `.${id}/${instructionFile}`,
              version: 1,
              content: blockContent
            }
          ]
        };
      }
    };
  });
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
