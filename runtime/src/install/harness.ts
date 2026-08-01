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
import { CLAUDE_CAPABILITY_REGISTRATIONS } from "../adapters/claude/events.js";
import { normalizeClaudeHookInput } from "../adapters/claude/input.js";
import { claudeHookOutput } from "../adapters/claude/output.js";
import { claudeSurfaces } from "../adapters/claude/surfaces.js";
import {
  buildCodexHookConfig,
  CODEX_MANAGED_MARKER,
  mergeCodexHookConfig,
  stripCodexManagedHooks
} from "../adapters/codex/config.js";
import { CODEX_CAPABILITY_REGISTRATIONS } from "../adapters/codex/events.js";
import { normalizeCodexHookInput } from "../adapters/codex/input.js";
import { codexHookOutput } from "../adapters/codex/output.js";
import { codexSurfaces } from "../adapters/codex/surfaces.js";
import {
  buildOpencodePlugin,
  isOpencodePluginRegistered,
  opencodePluginTarget
} from "../adapters/opencode/config.js";
import { OPENCODE_CAPABILITY_REGISTRATIONS } from "../adapters/opencode/events.js";
import { normalizeOpencodeHookInput } from "../adapters/opencode/input.js";
import { opencodeHookOutput } from "../adapters/opencode/output.js";
import { opencodeSurfaces } from "../adapters/opencode/surfaces.js";
import { AgentOpsError } from "../fs/paths.js";
import type { HookResult, NormalizedHookEvent } from "../hooks/events.js";
import type {
  Capability,
  CapabilityRegistrationSpec,
  HarnessSurface
} from "./types.js";
import {
  findSurfaceById,
  findSurfaceByPath,
  isWritableSurface
} from "./surfaces.js";

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

export interface HarnessControlAdapter {
  readonly instructionFile: string;
  readonly routing: HarnessRoutingSpec;
  readonly hookPath: string;
  readonly hookPathForScope?: (scope: InstallScope, root?: string) => string;
  readonly surfaces: (
    scope: InstallScope,
    root?: string
  ) => readonly HarnessSurface[];
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
  readonly registrations: readonly CapabilityRegistrationSpec[];
  readonly hookRegistered: (
    source: unknown,
    capabilities: readonly Capability[]
  ) => boolean;
  readonly plan: (
    context: HarnessPlanContext
  ) => Promise<HarnessContribution>;
}

export interface HarnessRuntimeAdapter {
  readonly normalizeInput: (input: unknown) => NormalizedHookEvent;
  readonly formatOutput: (
    event: HookEventName,
    result: HookResult
  ) => HookProcessOutput;
  readonly formatRuntimeFailure: (
    event: HookEventName,
    capability: Capability,
    remedy?: string
  ) => HookProcessOutput;
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

export interface HarnessDescriptor {
  readonly id: HarnessId;
  readonly control: HarnessControlAdapter;
  readonly runtime: HarnessRuntimeAdapter;
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
  control: HarnessControlAdapter,
  source: unknown,
  capabilities: readonly Capability[]
): boolean {
  if (
    control.buildHooks === undefined ||
    control.isManagedHandler === undefined
  ) {
    return false;
  }
  const events = Object.keys(
    control.buildHooks(capabilities, "probe").hooks
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
          group.hooks.some(control.isManagedHandler as (value: unknown) => boolean)
      )
    );
  });
}

function runtimeFailureResult(
  capability: Capability,
  registrations: readonly CapabilityRegistrationSpec[],
  remedy?: string
): HookResult {
  const runtimeFailure = registrations.find(
    (registration) => registration.capability === capability
  )?.runtimeFailure;
  return {
    action: runtimeFailure === "fail-closed" ? "block" : "continue",
    status: "UNKNOWN",
    code: `${capability.replaceAll("-", "_").toUpperCase()}_UNAVAILABLE`,
    ...(remedy === undefined ? {} : { remedy })
  };
}

function createJsonDescriptor(options: {
  readonly id: HarnessId;
  readonly instructionFile: string;
  readonly routing: HarnessRoutingSpec;
  readonly hookPath: string;
  readonly surfaces: (
    scope: InstallScope,
    root?: string
  ) => readonly HarnessSurface[];
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
  readonly registrations: readonly CapabilityRegistrationSpec[];
  readonly normalizeInput: (input: unknown) => NormalizedHookEvent;
  readonly formatOutput: (
    event: HookEventName,
    result: HookResult
  ) => HookProcessOutput;
}): HarnessDescriptor {
  const control: HarnessControlAdapter = {
    instructionFile: options.instructionFile,
    routing: options.routing,
    hookPath: options.hookPath,
    surfaces: options.surfaces,
    ownSettingsKeys: options.ownSettingsKeys,
    buildHooks: options.buildHooks,
    mergeHooks: options.mergeHooks,
    stripHooks: options.stripHooks,
    isManagedHandler: options.isManagedHandler,
    registrations: options.registrations,
    plan: (context) => planCommonHarnessContribution(options.id, context),
    hookRegistered: (source, capabilities) =>
      jsonHookRegistered(control, source, capabilities)
  };
  return {
    id: options.id,
    control,
    runtime: {
      normalizeInput: options.normalizeInput,
      formatOutput: options.formatOutput,
      formatRuntimeFailure: (event, capability, remedy) =>
        options.formatOutput(
          event,
          runtimeFailureResult(capability, options.registrations, remedy)
        )
    }
  };
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
    surfaces: codexSurfaces,
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
    registrations: CODEX_CAPABILITY_REGISTRATIONS,
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
    surfaces: claudeSurfaces,
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
    registrations: CLAUDE_CAPABILITY_REGISTRATIONS,
    normalizeInput: normalizeClaudeHookInput,
    formatOutput: (event, result) => claudeHookOutput(event, result)
  }),
  opencode: {
    id: "opencode",
    control: {
      instructionFile: "AGENTS.md",
      routing: AGENTS_ROUTING,
      hookPath: opencodePluginTarget("project").path,
      hookPathForScope: (scope, root) => opencodePluginTarget(scope, root).path,
      surfaces: opencodeSurfaces,
      registrations: OPENCODE_CAPABILITY_REGISTRATIONS,
      plan: (context) => planCommonHarnessContribution("opencode", context),
      hookRegistered: (source, capabilities) =>
        isOpencodePluginRegistered(source, capabilities)
    },
    runtime: {
      normalizeInput: normalizeOpencodeHookInput,
      formatOutput: (event, result) => opencodeHookOutput(event, result),
      formatRuntimeFailure: (event, capability, remedy) =>
        opencodeHookOutput(
          event,
          runtimeFailureResult(
            capability,
            OPENCODE_CAPABILITY_REGISTRATIONS,
            remedy
          )
        )
    }
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
  return descriptor.control.hookPathForScope?.(scope, root) ??
    descriptor.control.hookPath;
}

export function harnessSurfaces(
  id: HarnessId,
  scope: InstallScope,
  root?: string
): readonly HarnessSurface[] {
  return harnessDescriptor(id).control.surfaces(scope, root);
}

export function harnessSurfaceById(
  id: HarnessId,
  scope: InstallScope,
  surfaceId: string,
  root?: string
): HarnessSurface | undefined {
  return harnessSurfaces(id, scope, root).find(
    (surface) => surface.id === surfaceId
  );
}

export function harnessSurfaceByPath(
  id: HarnessId,
  scope: InstallScope,
  path: string,
  root?: string
): HarnessSurface | undefined {
  return harnessSurfaces(id, scope, root).find(
    (surface) => surface.path === path
  );
}

export function selectHarnessHookSurface(options: {
  readonly harness: HarnessId;
  readonly scope: InstallScope;
  readonly root?: string;
  readonly surfaceId?: string;
  readonly persistedPath?: string;
}): HarnessSurface {
  const descriptor = harnessDescriptor(options.harness);
  if (descriptor.control.buildHooks === undefined) {
    throw new AgentOpsError(
      "HOOK_TARGET_UNSUPPORTED",
      `Harness hook targets are not supported for ${options.harness}.`
    );
  }
  const surfaces = harnessSurfaces(
    options.harness,
    options.scope,
    options.root
  );
  const selected =
    options.surfaceId === undefined
      ? options.persistedPath === undefined
        ? surfaces.find(
            (surface) =>
              surface.access === "managed-default" &&
              surface.representation === "json"
          )
        : findSurfaceByPath(surfaces, options.persistedPath)
      : findSurfaceById(surfaces, options.surfaceId);
  if (
    selected === undefined ||
    selected.scope !== options.scope ||
    !isWritableSurface(selected) ||
    selected.representation !== "json"
  ) {
    const requested =
      options.surfaceId ?? options.persistedPath ?? "default surface";
    throw new AgentOpsError(
      "HOOK_TARGET_INVALID",
      `Harness hook target is not a writable ${options.scope} surface: ${options.harness}=${requested}.`
    );
  }
  return selected;
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

export const COMMON_AGENTS_BLOCK = DESCRIPTORS.codex.control.routing.desired;
export const COMMON_CLAUDE_BLOCK = DESCRIPTORS.claude.control.routing.desired;

export function managedRules(
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
      "Command policy guards high-confidence unsafe actions. Explicitly enabled",
      "Stop verification is report-only and never marks a task complete by itself.",
      ""
    );
  }
  lines.push(
    `This file is routed from the active ${descriptor.control.instructionFile}.`,
    ""
  );
  return lines.join("\n");
}

function instructionStem(instructionFile: string): string {
  return instructionFile.replace(/\.md$/iu, "").toLowerCase();
}

export function rulesArtifactId(descriptor: HarnessDescriptor): string {
  return `${instructionStem(descriptor.control.instructionFile)}-rules`;
}

export function routingBlockId(
  id: HarnessId,
  scope: InstallScope,
  descriptor = harnessDescriptor(id)
): string {
  return scope === "project" && descriptor.control.instructionFile === "AGENTS.md"
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

async function planCommonHarnessContribution(
  id: HarnessId,
  context: HarnessPlanContext
): Promise<HarnessContribution> {
  const descriptor = harnessDescriptor(id);
  const artifacts: HarnessArtifact[] = [
    {
      id: rulesArtifactId(descriptor),
      path: `.agent-ops/${descriptor.control.instructionFile}`,
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
            ? descriptor.control.instructionFile
            : `.${id}/${descriptor.control.instructionFile}`,
        version: 1,
        content: descriptor.control.routing.desired
      }
    ]
  };
}

export function commonHarnessAdapters(): readonly HarnessInstallAdapter[] {
  return HARNESS_IDS.map((id) => {
    const descriptor = harnessDescriptor(id);
    return {
      id,
      plan: (context) => descriptor.control.plan(context)
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
