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
import {
  buildOpencodePlugin,
  isOpencodePluginRegistered,
  opencodePluginTarget
} from "../adapters/opencode/config.js";
import { normalizeOpencodeHookInput } from "../adapters/opencode/input.js";
import { opencodeHookOutput } from "../adapters/opencode/output.js";
import { AgentOpsError } from "../fs/paths.js";
import type { HookResult, NormalizedHookEvent } from "../hooks/events.js";
import type { Capability } from "./types.js";

export type { HarnessId } from "../contracts.js";

export const HARNESS_IDS: readonly HarnessId[] = [
  "codex",
  "claude",
  "opencode"
];

const CLAUDE_HOOK_MARKER = "--managed-by=agent-ops";

export interface HarnessPlanContext {
  /** The root against which managed relative paths are resolved. */
  readonly root?: string;
  readonly scope: InstallScope;
  readonly profiles: readonly Profile[];
  readonly capabilities: readonly Capability[];
  readonly toolkitVersion?: string;
  /** The absolute runtime entry point used by hook-bearing adapters. */
  readonly runtimePath?: string;
  /** Reuse an existing opencode plugin location during update reconciliation. */
  readonly opencodePluginPath?: string;
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

export interface HarnessRoutingSpec {
  readonly desired: string;
  readonly legacy: readonly string[];
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
 * Harness-specific behavior is kept in one registry entry. JSON hook
 * settings use the build/merge/strip functions; file-backed plugins use only
 * hookRegistered because their source is already a managed artifact.
 */
export interface HarnessDescriptor {
  readonly id: HarnessId;
  readonly instructionFile: string;
  readonly routing: HarnessRoutingSpec;
  readonly hookPath: string;
  readonly hookPathForScope?: (scope: InstallScope, root?: string) => string;
  /** Settings keys that may remain when only our JSON hook file is left. */
  readonly ownSettingsKeys?: readonly string[];
  readonly buildHooks?: (
    capabilities: readonly Capability[],
    runtimePath: string
  ) => HarnessHookSettings;
  readonly mergeHooks?: (
    existing: unknown,
    managed: HarnessHookSettings
  ) => unknown;
  readonly stripHooks?: (existing: unknown) => Record<string, unknown>;
  readonly isManagedHandler?: (handler: unknown) => boolean;
  hookRegistered(
    source: unknown,
    capabilities: readonly Capability[]
  ): boolean;
  normalizeInput(input: unknown): NormalizedHookEvent;
  formatOutput(event: HookEventName, result: HookResult): HookProcessOutput;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonSource(source: unknown): unknown {
  if (typeof source !== "string") {
    return source;
  }
  if (source.trim().length === 0) {
    return {};
  }
  try {
    return JSON.parse(source) as unknown;
  } catch {
    return null;
  }
}

function jsonHookRegistered(
  descriptor: HarnessDescriptor,
  source: unknown,
  capabilities: readonly Capability[]
): boolean {
  if (
    descriptor.buildHooks === undefined ||
    descriptor.isManagedHandler === undefined
  ) {
    return false;
  }
  const events = Object.keys(
    descriptor.buildHooks(capabilities, "probe").hooks
  );
  if (events.length === 0) {
    return true;
  }
  const parsed = parseJsonSource(source);
  if (!isRecord(parsed) || !isRecord(parsed.hooks)) {
    return false;
  }
  const hooks = parsed.hooks;
  return events.every((event) => {
    const groups = hooks[event];
    return (
      Array.isArray(groups) &&
      groups.some(
        (group) =>
          isRecord(group) &&
          Array.isArray(group.hooks) &&
          group.hooks.some(descriptor.isManagedHandler as (value: unknown) => boolean)
      )
    );
  });
}

function createJsonDescriptor(options: {
  readonly id: HarnessId;
  readonly instructionFile: string;
  readonly routing: HarnessRoutingSpec;
  readonly hookPath: string;
  readonly ownSettingsKeys: readonly string[];
  readonly buildHooks: (
    capabilities: readonly Capability[],
    runtimePath: string
  ) => HarnessHookSettings;
  readonly mergeHooks: (
    existing: unknown,
    managed: HarnessHookSettings
  ) => unknown;
  readonly stripHooks: (existing: unknown) => Record<string, unknown>;
  readonly isManagedHandler: (handler: unknown) => boolean;
  readonly normalizeInput: (input: unknown) => NormalizedHookEvent;
  readonly formatOutput: (
    event: HookEventName,
    result: HookResult
  ) => HookProcessOutput;
}): HarnessDescriptor {
  const descriptor: HarnessDescriptor = {
    ...options,
    hookRegistered: (source, capabilities) =>
      jsonHookRegistered(descriptor, source, capabilities)
  };
  return descriptor;
}

const AGENTS_ROUTING: HarnessRoutingSpec = {
  desired:
    "## Loop Engineering\n\nLoad `.agent-ops/AGENTS.md` as the agent-ops managed baseline.\nProject-specific instructions in this file remain authoritative.\n",
  legacy: [
    "## Loop Engineering\n\nUse `.agent-ops/AGENTS.md` as the canonical Loop Engineering specification for this project.\n"
  ]
};

const CLAUDE_ROUTING: HarnessRoutingSpec = {
  desired:
    "## Loop Engineering\n\nLoad `.agent-ops/CLAUDE.md` as the agent-ops managed baseline.\nProject-specific instructions in this file remain authoritative.\n",
  legacy: [
    "## Loop Engineering\n\nUse `.agent-ops/CLAUDE.md` as the canonical Loop Engineering specification for this project.\n"
  ]
};

const DESCRIPTORS: Readonly<Record<HarnessId, HarnessDescriptor>> = {
  codex: createJsonDescriptor({
    id: "codex",
    instructionFile: "AGENTS.md",
    routing: AGENTS_ROUTING,
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
  }),
  claude: createJsonDescriptor({
    id: "claude",
    instructionFile: "CLAUDE.md",
    routing: CLAUDE_ROUTING,
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
  }),
  opencode: {
    id: "opencode",
    instructionFile: "AGENTS.md",
    routing: AGENTS_ROUTING,
    hookPath: opencodePluginTarget("project").path,
    hookPathForScope: (scope, root) => opencodePluginTarget(scope, root).path,
    hookRegistered: (source, capabilities) =>
      isOpencodePluginRegistered(source, capabilities),
    normalizeInput: normalizeOpencodeHookInput,
    formatOutput: (event, result) => opencodeHookOutput(event, result)
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

export function harnessHookPath(
  id: HarnessId,
  scope: InstallScope,
  root?: string
): string {
  const descriptor = harnessDescriptor(id);
  return descriptor.hookPathForScope?.(scope, root) ?? descriptor.hookPath;
}

export function isHarnessId(value: string): value is HarnessId {
  return Object.hasOwn(DESCRIPTORS, value);
}

/**
 * `both` predates opencode and remains an input alias. `all` follows the
 * registry and selects every registered harness.
 */
const HARNESS_ALIASES: Readonly<Record<string, readonly HarnessId[]>> = {
  all: HARNESS_IDS,
  both: ["codex", "claude"]
};

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

export const COMMON_AGENTS_BLOCK = DESCRIPTORS.codex.routing.desired;
export const COMMON_CLAUDE_BLOCK = DESCRIPTORS.claude.routing.desired;

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

function instructionStem(instructionFile: string): string {
  return instructionFile.replace(/\.md$/iu, "").toLowerCase();
}

export function rulesArtifactId(descriptor: HarnessDescriptor): string {
  return `${instructionStem(descriptor.instructionFile)}-rules`;
}

export function routingBlockId(
  id: HarnessId,
  scope: InstallScope,
  descriptor = harnessDescriptor(id)
): string {
  return scope === "project" && descriptor.instructionFile === "AGENTS.md"
    ? "agents-routing"
    : `${id}-routing`;
}

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

export function commonHarnessAdapters(): readonly HarnessInstallAdapter[] {
  return HARNESS_IDS.map((id) => {
    const descriptor = harnessDescriptor(id);
    return {
      id,
      async plan(context) {
        const artifacts: HarnessArtifact[] = [
          {
            id: rulesArtifactId(descriptor),
            path: `.agent-ops/${descriptor.instructionFile}`,
            content: managedRules(descriptor, context)
          }
        ];
        if (id === "opencode" && context.runtimePath !== undefined) {
          const plugin = buildOpencodePlugin(
            context.capabilities,
            context.runtimePath
          );
          if (plugin !== null) {
            artifacts.push({
              id: "opencode-plugin",
              path:
                context.opencodePluginPath ??
                opencodePluginTarget(context.scope, context.root).path,
              content: plugin
            });
          }
        }
        return {
          artifacts,
          blocks: [
            {
              id: routingBlockId(id, context.scope, descriptor),
              path:
                context.scope === "project"
                  ? descriptor.instructionFile
                  : `.${id}/${descriptor.instructionFile}`,
              version: 1,
              content: descriptor.routing.desired
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
