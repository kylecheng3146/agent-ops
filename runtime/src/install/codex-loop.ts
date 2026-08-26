import type { Harness, HarnessId, InstallScope } from "../contracts.js";
import { AgentOpsError } from "../fs/paths.js";
import type { Capability } from "./types.js";
import type {
  HarnessArtifact,
  HarnessManagedBlock
} from "./harness.js";

export const LOOP_MARKER_ID = "loop-state";
export const LOOP_MARKER_VERSION = 1;

export type LoopHarness = "claude" | "codex";

export interface LoopSeed {
  readonly path: string;
  readonly content: string;
}

export interface LoopContribution {
  readonly artifacts: readonly HarnessArtifact[];
  readonly blocks: readonly HarnessManagedBlock[];
}

const LOOP_HARNESSES = new Set<HarnessId>(["claude", "codex"]);

const CODEX_CONFIG_SEED = [
  "# Created by agent-ops for the project-local loop.",
  "# This file remains user-owned after installation.",
  "[features]",
  "hooks = true",
  ""
].join("\n");

const GOAL_SEED = [
  "# Current goal",
  "",
  "Describe the current objective, acceptance criteria, and important constraints.",
  ""
].join("\n");

const STATE_SEED = [
  "# Loop state",
  "",
  "Status: idle",
  ""
].join("\n");

function isLoopHarness(value: HarnessId): value is LoopHarness {
  return LOOP_HARNESSES.has(value);
}

export function selectedLoopHarnesses(
  harnesses: readonly HarnessId[]
): readonly LoopHarness[] {
  return harnesses.filter(isLoopHarness);
}

function loopRoot(harness: LoopHarness): ".claude" | ".codex" {
  return `.${harness}`;
}

export function loopLauncherPath(harness: LoopHarness): string {
  return `${loopRoot(harness)}/hooks/agent-ops-loop.sh`;
}

export function loopLauncherArtifactId(harness: LoopHarness): string {
  return `${harness}-loop-launcher`;
}

export function loopWindowsLauncherPath(harness: "claude"): string {
  return `${loopRoot(harness)}/hooks/agent-ops-loop.ps1`;
}

export function loopWindowsLauncherArtifactId(harness: "claude"): string {
  return `${harness}-loop-launcher-windows`;
}

function assertRuntimePath(runtimePath: string): void {
  if (
    runtimePath.length === 0 ||
    runtimePath.length > 4096 ||
    /[\0\r\n]/u.test(runtimePath) ||
    !runtimePath.endsWith("hook-entry.js")
  ) {
    throw new AgentOpsError(
      "LOOP_RUNTIME_PATH_INVALID",
      "The loop runtime path must name a safe hook-entry.js file."
    );
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function powershellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function loopEntryPath(hookRuntimePath: string): string {
  assertRuntimePath(hookRuntimePath);
  return `${hookRuntimePath.slice(0, -"hook-entry.js".length)}loop-entry.js`;
}

export function buildLoopLauncher(
  harness: LoopHarness,
  hookRuntimePath: string
): string {
  const runtimePath = loopEntryPath(hookRuntimePath);
  return [
    "#!/usr/bin/env bash",
    `# agent-ops: generated ${harness} loop v1`,
    "set -uo pipefail",
    `exec node ${shellQuote(runtimePath)} ${harness} "$@"`,
    ""
  ].join("\n");
}

export function buildPowerShellLoopLauncher(
  harness: "claude",
  hookRuntimePath: string
): string {
  const runtimePath = loopEntryPath(hookRuntimePath);
  return [
    `# agent-ops: generated ${harness} Windows loop v1`,
    "$ErrorActionPreference = \"Stop\"",
    `$runtimePath = ${powershellQuote(runtimePath)}`,
    `& node $runtimePath ${harness} @args`,
    "exit $LASTEXITCODE",
    ""
  ].join("\n");
}

function statePaths(harness: LoopHarness): readonly string[] {
  const root = loopRoot(harness);
  return [
    `${root}/loop-goal.md`,
    `${root}/loop-state.md`,
    `${root}/loop-telemetry.jsonl`
  ];
}

export function loopSeeds(harnesses: readonly HarnessId[]): readonly LoopSeed[] {
  const seeds: LoopSeed[] = [];
  for (const harness of selectedLoopHarnesses(harnesses)) {
    const root = loopRoot(harness);
    if (harness === "codex") {
      seeds.push({ path: `${root}/config.toml`, content: CODEX_CONFIG_SEED });
    }
    seeds.push(
      { path: `${root}/loop-goal.md`, content: GOAL_SEED },
      { path: `${root}/loop-state.md`, content: STATE_SEED },
      { path: `${root}/loop-telemetry.jsonl`, content: "" }
    );
  }
  return seeds;
}

export function loopIgnoreContent(harnesses: readonly HarnessId[]): string {
  return selectedLoopHarnesses(harnesses)
    .flatMap((harness) => statePaths(harness))
    .join("\n");
}

/**
 * This is intentionally narrower than a TOML parser: only an unambiguous
 * boolean assignment inside the exact [features] table is a conflict. Other
 * configuration remains user-owned and is never normalized or rewritten.
 */
export function codexHooksExplicitlyDisabled(source: string): boolean {
  let inFeatures = false;
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const section = /^\[([^\]]+)\]\s*(?:#.*)?$/u.exec(line);
    if (section !== null) {
      inFeatures = section[1] === "features";
      continue;
    }
    if (
      inFeatures &&
      /^hooks\s*=\s*false\s*(?:#.*)?$/u.test(line)
    ) {
      return true;
    }
  }
  return false;
}

export function planLoopContribution(options: {
  readonly scope: InstallScope;
  readonly harnesses: Harness;
  readonly capabilities: readonly Capability[];
  readonly hookRuntimePath?: string;
}): LoopContribution {
  if (!options.capabilities.includes("project-loop")) {
    return { artifacts: [], blocks: [] };
  }
  const harnesses = selectedLoopHarnesses(options.harnesses);
  if (options.scope !== "project" || harnesses.length === 0) {
    throw new AgentOpsError(
      "LOOP_PROFILE_UNSUPPORTED",
      "The loop profile requires project scope and the Codex or Claude harness."
    );
  }
  if (options.hookRuntimePath === undefined) {
    throw new AgentOpsError(
      "LOOP_RUNTIME_REQUIRED",
      "The loop profile requires the installed hook runtime path."
    );
  }
  const artifacts = harnesses.flatMap((harness) => [
    {
      id: loopLauncherArtifactId(harness),
      path: loopLauncherPath(harness),
      content: buildLoopLauncher(harness, options.hookRuntimePath ?? "")
    },
    ...(harness === "claude"
      ? [{
          id: loopWindowsLauncherArtifactId(harness),
          path: loopWindowsLauncherPath(harness),
          content: buildPowerShellLoopLauncher(
            harness,
            options.hookRuntimePath ?? ""
          )
        }]
      : [])
  ]);
  return {
    artifacts,
    blocks: [
      {
        id: LOOP_MARKER_ID,
        path: ".gitignore",
        version: LOOP_MARKER_VERSION,
        markerStyle: "hash",
        content: loopIgnoreContent(harnesses)
      }
    ]
  };
}
