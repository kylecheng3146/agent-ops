import { homedir } from "node:os";
import {
  isAbsolute,
  join,
  relative,
  resolve,
  sep
} from "node:path";

import type { InstallScope } from "../../contracts.js";
import { AgentOpsError } from "../../fs/paths.js";
import type { Capability } from "../../install/types.js";
import type { OpencodeSupportedEvent } from "./events.js";

export const OPENCODE_MANAGED_MARKER = "--managed-by=agent-ops";
export const OPENCODE_PLUGIN_PATH = ".opencode/plugins/agent-ops.js";
export const OPENCODE_USER_PLUGIN_PATH = ".config/opencode/plugins/agent-ops.js";

export interface OpencodePluginTarget {
  readonly path: string;
  readonly representation: "javascript";
  readonly requiresProjectTrust: boolean;
}

function userPluginPath(
  root?: string,
  configuredHome = process.env.XDG_CONFIG_HOME,
  configuredDirectory = process.env.OPENCODE_CONFIG_DIR
): string {
  const installationRoot = resolve(
    root ?? process.env.AGENT_OPS_HOME ?? homedir()
  );
  const customConfigDirectory = configuredDirectory?.trim();
  const configDirectory =
    customConfigDirectory !== undefined && customConfigDirectory.length > 0
      ? customConfigDirectory
      : configuredHome === undefined || configuredHome.trim().length === 0
        ? join(installationRoot, ".config", "opencode")
        : join(configuredHome, "opencode");
  if (!isAbsolute(configDirectory)) {
    throw new AgentOpsError(
      "OPENCODE_CONFIG_PATH_INVALID",
      "OpenCode's config directory must be an absolute path for user-scope installation."
    );
  }
  const target = resolve(
    configDirectory,
    "plugins",
    "agent-ops.js"
  );
  const relativeTarget = relative(installationRoot, target);
  if (
    relativeTarget.length === 0 ||
    relativeTarget === ".." ||
    relativeTarget.startsWith(`..${sep}`) ||
    isAbsolute(relativeTarget)
  ) {
    throw new AgentOpsError(
      "OPENCODE_CONFIG_PATH_INVALID",
      "OpenCode's config directory must stay inside the managed user-scope root."
    );
  }
  return relativeTarget.split(sep).join("/");
}

export function opencodePluginTarget(
  scope: InstallScope,
  root?: string,
  configuredHome?: string,
  configuredDirectory?: string
): OpencodePluginTarget {
  return {
    path:
      scope === "project"
        ? OPENCODE_PLUGIN_PATH
        : root === undefined && configuredHome === undefined &&
            configuredDirectory === undefined &&
            process.env.XDG_CONFIG_HOME === undefined &&
            process.env.OPENCODE_CONFIG_DIR === undefined
          ? OPENCODE_USER_PLUGIN_PATH
          : userPluginPath(root, configuredHome, configuredDirectory),
    representation: "javascript",
    requiresProjectTrust: scope === "project"
  };
}

/**
 * Validates the persisted plugin shape without consulting the current
 * environment. User-scope installations may use a custom config directory,
 * so their manifest path is allowed to have any safe prefix but must still
 * name OpenCode's plugin entrypoint.
 */
export function isOpencodePluginPath(
  scope: InstallScope,
  path: string
): boolean {
  if (scope === "project") {
    return path === OPENCODE_PLUGIN_PATH;
  }
  return /^(?:[A-Za-z0-9._-]+\/)*plugins\/agent-ops\.js$/u.test(path);
}

function isAbsoluteRuntimePath(value: string): boolean {
  return (
    value.startsWith("/") ||
    /^[A-Za-z]:[\\/]/u.test(value) ||
    value.startsWith("\\\\")
  );
}

function assertRuntimePath(runtimePath: string): void {
  if (
    !isAbsoluteRuntimePath(runtimePath) ||
    runtimePath.length > 4096 ||
    runtimePath.includes("\0") ||
    runtimePath.includes("\n") ||
    runtimePath.includes("\r")
  ) {
    throw new AgentOpsError(
      "OPENCODE_PLUGIN_PATH_INVALID",
      "opencode plugin runtime path must be absolute and valid."
    );
  }
}

export function opencodePluginEvents(
  capabilities: readonly Capability[]
): readonly OpencodeSupportedEvent[] {
  const events: OpencodeSupportedEvent[] = [];
  if (capabilities.includes("lifecycle-summary")) {
    events.push("SessionStart");
  }
  if (capabilities.includes("command-policy")) {
    events.push("PreToolUse");
  }
  if (capabilities.includes("optional-stop-verify")) {
    events.push("Stop");
  }
  return events;
}

/**
 * Generates the dependency-free plugin installed under the selected local
 * or user plugin directory.
 * The only host dependency is opencode's Bun `$` shell tag, supplied by the
 * plugin context. Keeping the shell function in the context makes the source
 * importable under Node tests with a small fake.
 */
export function buildOpencodePlugin(
  capabilities: readonly Capability[],
  runtimePath: string
): string | null {
  const events = opencodePluginEvents(capabilities);
  if (events.length === 0) {
    return null;
  }
  assertRuntimePath(runtimePath);

  const lines = [
    "// Managed by agent-ops. Do not edit: `agent-ops update` rewrites this file.",
    `const RUNTIME_PATH = ${JSON.stringify(runtimePath)};`,
    `const MARKER = ${JSON.stringify(OPENCODE_MANAGED_MARKER)};`,
    "",
    "function outputText(result) {",
    "  if (typeof result?.stdout === \"string\") return result.stdout;",
    "  return new TextDecoder().decode(result?.stdout ?? new Uint8Array());",
    "}",
    "",
    "async function invokeRuntime($, event, payload, projectRoot) {",
    "  try {",
    "    const result = await $`node ${RUNTIME_PATH} opencode ${event} ${MARKER} < ${new Response(JSON.stringify(payload))}`.cwd(projectRoot).quiet();",
    "    const decision = JSON.parse(outputText(result).trim());",
    "    if (decision?.decision !== \"allow\" && decision?.decision !== \"deny\") return null;",
    "    return decision;",
    "  } catch {",
    "    return null;",
    "  }",
    "}",
    "",
    "async function runManagedHook($, event, payload) {",
    "  const decision = await invokeRuntime($, event, payload, payload.projectRoot);",
    "  if (decision === null) {",
    "    if (event === \"PreToolUse\") throw new Error(\"agent-ops: command policy is unavailable\");",
    "    return;",
    "  }",
    "  if (decision.decision === \"deny\") {",
    "    throw new Error(`agent-ops: ${decision.reason ?? \"denied\"}`);",
    "  }",
    "}",
    "",
    "export const AgentOps = async ({ $, directory, worktree } = {}) => {",
    "  const projectRoot = directory ?? worktree ?? process.cwd();",
    "  const hooks = {};"
  ];

  if (events.includes("SessionStart")) {
    lines.push(
      "  // opencode initializes plugins once per app, not once per session.",
      "  await runManagedHook($, \"SessionStart\", {",
      "    event: \"SessionStart\",",
      "    projectRoot",
      "  });"
    );
  }
  if (events.includes("PreToolUse")) {
    lines.push(
      '  hooks["tool.execute.before"] = async (input, output) => {',
      '    if (input?.tool !== "bash") return;',
      "    await runManagedHook($, \"PreToolUse\", {",
      "      event: \"PreToolUse\",",
      "      projectRoot,",
      "      input,",
      "      output",
      "    });",
      "  };"
    );
  }
  if (events.includes("Stop")) {
    lines.push(
      "  hooks.event = async ({ event }) => {",
      '    if (event?.type !== "session.idle") return;',
      "    await runManagedHook($, \"Stop\", { event: \"Stop\", projectRoot });",
      "  };"
    );
  }
  lines.push("  return hooks;", "};", "");
  return lines.join("\n");
}

export function isOpencodeManagedPlugin(source: string | null): boolean {
  return (
    source !== null &&
    source.includes("Managed by agent-ops") &&
    source.includes(OPENCODE_MANAGED_MARKER)
  );
}

/**
 * Registration probing checks the generated source's managed marker and the
 * capability-implied hook registrations. The artifact hash check remains the
 * exact-content check; this probe answers whether the relevant hooks exist.
 */
export function isOpencodePluginRegistered(
  source: unknown,
  capabilities: readonly Capability[]
): boolean {
  if (typeof source !== "string") {
    return opencodePluginEvents(capabilities).length === 0;
  }
  if (!isOpencodeManagedPlugin(source)) {
    return false;
  }
  return opencodePluginEvents(capabilities).every((event) => {
    if (event === "SessionStart") {
      return source.includes('runManagedHook($, "SessionStart"');
    }
    if (event === "PreToolUse") {
      return source.includes('"tool.execute.before"') &&
        source.includes('runManagedHook($, "PreToolUse"');
    }
    return source.includes('event?.type !== "session.idle"') &&
      source.includes('runManagedHook($, "Stop"');
  });
}
