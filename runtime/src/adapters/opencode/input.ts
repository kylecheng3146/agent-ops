import { resolve } from "node:path";

import type { NormalizedHookEvent } from "../../hooks/events.js";
import { normalizeHookEvent } from "../../hooks/normalize.js";
import { normalizeShellHookEvent } from "../../hooks/shell.js";

/**
 * opencode tools that write a file without a shell (lowercase tool names).
 * `apply_patch` is the GPT-model replacement for `edit`/`write`; older
 * servers still report `patch`.
 */
export const OPENCODE_FILE_TOOLS: ReadonlySet<string> = new Set([
  "edit",
  "write",
  "patch",
  "apply_patch"
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sessionIdOf(value: Record<string, unknown>): string | undefined {
  const sessionId = value.sessionID;
  return typeof sessionId === "string" && sessionId.length > 0
    ? sessionId
    : undefined;
}

/**
 * Paths embedded in `apply_patch` marker lines, relative to the project root:
 * `*** Add File:`, `*** Update File:`, `*** Move to:`, `*** Delete File:`.
 */
function patchTextPaths(patchText: string): string[] {
  const paths: string[] = [];
  const marker = /^\*\*\*\s+(?:Add File|Update File|Move to|Delete File):\s*(.+?)\s*$/gmu;
  for (const match of patchText.matchAll(marker)) {
    const target = match[1]?.trim();
    if (target !== undefined && target.length > 0 && !target.includes("\0")) {
      paths.push(target);
    }
  }
  return paths;
}

function fileWritePaths(
  args: Record<string, unknown>,
  projectRoot: string
): string[] | null {
  const direct = args.filePath ?? args.file_path ?? args.path;
  if (typeof direct === "string" && direct.length > 0 && !direct.includes("\0")) {
    return [resolve(projectRoot, direct)];
  }
  if (typeof args.patchText === "string") {
    const marked = patchTextPaths(args.patchText);
    if (marked.length > 0) {
      return marked.map((target) => resolve(projectRoot, target));
    }
  }
  return null;
}

/**
 * The managed plugin forwards opencode's own hook payload untouched under
 * `input`, so every field this adapter reads is documented plugin input rather
 * than a shape the plugin invented.
 */
export function normalizeOpencodeHookInput(
  input: unknown
): NormalizedHookEvent {
  if (!isRecord(input)) {
    return normalizeHookEvent(input);
  }
  const projectRoot = input.projectRoot;
  if (input.event === "SessionStart") {
    return normalizeHookEvent({ event: "session-start", projectRoot });
  }
  if (input.event === "Stop") {
    return normalizeHookEvent({ event: "stop", projectRoot });
  }
  if (
    input.event === "PreToolUse" &&
    isRecord(input.input) &&
    typeof input.input.tool === "string" &&
    OPENCODE_FILE_TOOLS.has(input.input.tool.toLowerCase()) &&
    isRecord(input.output) &&
    isRecord(input.output.args) &&
    typeof projectRoot === "string" &&
    projectRoot.length > 0
  ) {
    const paths = fileWritePaths(input.output.args, projectRoot);
    if (paths !== null) {
      const sessionId = sessionIdOf(input.input);
      return {
        event: "file-write",
        projectRoot,
        paths,
        ...(sessionId === undefined ? {} : { sessionId })
      };
    }
  }
  if (
    input.event === "PreToolUse" &&
    isRecord(input.input) &&
    typeof input.input.tool === "string" &&
    input.input.tool.toLowerCase() === "bash" &&
    isRecord(input.output) &&
    isRecord(input.output.args) &&
    typeof input.output.args.command === "string" &&
    typeof projectRoot === "string"
  ) {
    return normalizeShellHookEvent(input.output.args.command, projectRoot);
  }
  return normalizeHookEvent({ event: "unsupported", projectRoot });
}
