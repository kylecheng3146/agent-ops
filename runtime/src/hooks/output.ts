import { AgentOpsError } from "../fs/paths.js";
import type { HookResult } from "./events.js";

export const DEFAULT_HOOK_OUTPUT_BYTES = 8 * 1024;

export function encodeHookOutput(
  output: HookResult,
  maxBytes = DEFAULT_HOOK_OUTPUT_BYTES
): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new AgentOpsError(
      "HOOK_OUTPUT_LIMIT_INVALID",
      "Hook output limit must be a positive safe integer."
    );
  }
  const encoded = JSON.stringify(output);
  if (Buffer.byteLength(encoded, "utf8") > maxBytes) {
    throw new AgentOpsError(
      "HOOK_OUTPUT_TOO_LARGE",
      "Hook output exceeds the configured byte limit."
    );
  }
  return encoded;
}
