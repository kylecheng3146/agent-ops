import type {
  Harness,
  HarnessId,
  HookEventName,
  InstallScope,
  Profile
} from "../contracts.js";
import {
  buildClaudeHookSettings,
  mergeClaudeSettings,
  stripClaudeManagedHooks
} from "../adapters/claude/config.js";
import { normalizeClaudeHookInput } from "../adapters/claude/input.js";
import { claudeHookOutput } from "../adapters/claude/output.js";
import {
  buildCodexHookConfig,
  CODEX_MANAGED_MARKER,
  mergeCodexHookConfig,
  stripCodexManagedHooks
} from "../adapters/codex/config.js";
import { normalizeCodexHookInput } from "../adapters/codex/input.js";
import { codexHookOutput } from "../adapters/codex/output.js";
import { AgentOpsError } from "../fs/paths.js";
import type { HookResult, NormalizedHookEvent } from "../hooks/events.js";
import type { Capability } from "./types.js";

export type { HarnessId } from "../contracts.js";

export const HARNESS_IDS: readonly HarnessId[] = ["codex", "claude"];

const CLAUDE_HOOK_MARKER = "--managed-by=agent-ops";

export interface HarnessPlanContext {
  readonly scope: InstallScope;
  readonly profiles: readonly Profile[];
  readonly capabilities: readonly Capability[];
  readonly toolkitVersion?: string;
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

export interface HookProcessOutput {
  readonly exitCode: 0;
  readonly stdout: string;
  readonly stderr: string;
}

export interface HarnessHookSettings {
  readonly hooks: Readonly<Record<string, readonly unknown[]>>;
  readonly [key: string]: unknown;
}

/**
 * Everything that differs between harnesses, so selection is a registry lookup
 * rather than a chain of identity comparisons.
 */
export interface HarnessDescriptor {
  readonly id: HarnessId;
  readonly instructionFile: string;
  readonly routingBlock: string;
  readonly hookPath: string;
  /** Keys the harness settings file may contain and still count as ours. */
  readonly ownSettingsKeys: readonly string[];
  buildHooks(
    capabilities: readonly Capability[],
    runtimePath: string
  ): HarnessHookSettings;
  mergeHooks(existing: unknown, managed: HarnessHookSettings): unknown;
  stripHooks(existing: unknown): Record<string, unknown>;
  isManagedHandler(handler: unknown): boolean;
  normalizeInput(input: unknown): NormalizedHookEvent;
  formatOutput(event: HookEventName, result: HookResult): HookProcessOutput;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const DESCRIPTORS: Readonly<Record<HarnessId, HarnessDescriptor>> = {
  codex: {
    id: "codex",
    instructionFile: "AGENTS.md",
    routingBlock:
      "## Loop Engineering\n\nUse `.agent-ops/AGENTS.md` as the canonical Loop Engineering specification for this project.\n",
    hookPath: ".codex/hooks.json",
    ownSettingsKeys: ["hooks", "description"],
    buildHooks: (capabilities, runtimePath) =>
      buildCodexHookConfig(capabilities, runtimePath),
    mergeHooks: (existing, managed) =>
      mergeCodexHookConfig(existing, managed as never),
    stripHooks: (existing) =>
      stripCodexManagedHooks(existing) as Record<string, unknown>,
    isManagedHandler: (handler) =>
      isRecord(handler) &&
      typeof handler.command === "string" &&
      handler.command.includes(CODEX_MANAGED_MARKER),
    normalizeInput: normalizeCodexHookInput,
    formatOutput: (event, result) => {
      const output = codexHookOutput(event, result);
      return { exitCode: 0, stdout: output.stdout, stderr: "" };
    }
  },
  claude: {
    id: "claude",
    instructionFile: "CLAUDE.md",
    routingBlock:
      "## Loop Engineering\n\nUse `.agent-ops/CLAUDE.md` as the canonical Loop Engineering specification for this project.\n",
    hookPath: ".claude/settings.json",
    ownSettingsKeys: ["hooks"],
    buildHooks: (capabilities, runtimePath) =>
      buildClaudeHookSettings(capabilities, runtimePath),
    mergeHooks: (existing, managed) =>
      mergeClaudeSettings(existing, managed as never),
    stripHooks: (existing) =>
      stripClaudeManagedHooks(existing) as Record<string, unknown>,
    isManagedHandler: (handler) =>
      isRecord(handler) &&
      Array.isArray(handler.args) &&
      handler.args.includes(CLAUDE_HOOK_MARKER),
    normalizeInput: normalizeClaudeHookInput,
    formatOutput: (event, result) => claudeHookOutput(event, result)
  }
};

export function harnessDescriptor(id: HarnessId): HarnessDescriptor {
  const descriptor = DESCRIPTORS[id];
  if (descriptor === undefined) {
    throw new AgentOpsError(
      "HARNESS_ADAPTER_MISSING",
      `Missing harness adapter: ${id}`
    );
  }
  return descriptor;
}

export function isHarnessId(value: string): value is HarnessId {
  return Object.hasOwn(DESCRIPTORS, value);
}

/**
 * `both` predates opencode and is kept so existing scripts and prompts keep
 * working; `all` is the forward-looking spelling that follows the registry.
 */
const HARNESS_ALIASES: Readonly<Record<string, readonly HarnessId[]>> = {
  all: HARNESS_IDS,
  both: ["codex", "claude"]
};

/**
 * Parses a harness selection written as an alias or a comma-separated list.
 * Returns null when the text names anything unsupported, empty, or repeated.
 */
export function resolveHarnessSelection(value: string): Harness | null {
  const alias = HARNESS_ALIASES[value.trim()];
  if (alias !== undefined) {
    return [...alias];
  }
  const ids = value.split(",").map((entry) => entry.trim());
  return ids.length > 0 &&
    ids.every(isHarnessId) &&
    new Set(ids).size === ids.length
    ? ids
    : null;
}

export const COMMON_AGENTS_BLOCK = DESCRIPTORS.codex.routingBlock;
export const COMMON_CLAUDE_BLOCK = DESCRIPTORS.claude.routingBlock;

function managedRules(
  descriptor: HarnessDescriptor,
  context: HarnessPlanContext
): string {
  const lines = [
    "# Loop Engineering",
    "",
    "This routing specification is managed by `agent-ops`.",
    "",
    `Active profiles: ${context.profiles.join(", ")}`,
    `Active capabilities: ${context.capabilities.join(", ")}`,
    ...(context.toolkitVersion === undefined
      ? []
      : [`Toolkit version: ${context.toolkitVersion}`]),
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
    `This file is routed from the active ${descriptor.instructionFile}.`,
    ""
  );
  return lines.join("\n");
}

export function commonHarnessAdapters(): readonly HarnessInstallAdapter[] {
  return HARNESS_IDS.map((id) => {
    const descriptor = harnessDescriptor(id);
    return {
      id,
      async plan(context) {
        return {
          artifacts: [
            {
              id: `${id}-rules`,
              path: `.agent-ops/${descriptor.instructionFile}`,
              content: managedRules(descriptor, context)
            }
          ],
          blocks: [
            {
              id: `${id}-routing`,
              path:
                context.scope === "project"
                  ? descriptor.instructionFile
                  : `.${id}/${descriptor.instructionFile}`,
              version: 1,
              content: descriptor.routingBlock
            }
          ]
        };
      }
    };
  });
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

/**
 * Two harnesses may route through the same instruction file. Byte-identical
 * contributions collapse into one managed entry. Entries that share a path but
 * disagree are left in place so the install plan rejects them as a conflict
 * rather than silently picking a winner.
 */
function dedupeByPath<
  T extends { readonly path: string; readonly content: string }
>(entries: readonly T[]): T[] {
  const kept: T[] = [];
  for (const entry of entries) {
    const duplicate = kept.some(
      (existing) =>
        existing.path === entry.path && existing.content === entry.content
    );
    if (!duplicate) {
      kept.push(entry);
    }
  }
  return kept;
}

export async function planHarnessContributions(
  harness: Harness,
  context: HarnessPlanContext,
  adapters: readonly HarnessInstallAdapter[]
): Promise<HarnessContribution> {
  const selectedAdapters = harness.map((id) => selectAdapter(id, adapters));
  const artifacts: HarnessArtifact[] = [];
  const blocks: HarnessManagedBlock[] = [];

  for (const adapter of selectedAdapters) {
    const contribution = await adapter.plan(context);
    artifacts.push(...contribution.artifacts);
    blocks.push(...contribution.blocks);
  }

  return {
    artifacts: dedupeByPath(artifacts),
    blocks: dedupeByPath(blocks)
  };
}
