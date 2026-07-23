import type { InstallManifest } from "../contracts.js";
import { validateManifest } from "../schema/validate.js";
import { AgentOpsError } from "./paths.js";

export const PROJECT_MANIFEST_PATH = ".agent-ops/manifest.json";

export function parseInstallManifest(source: string): InstallManifest {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch (error) {
    throw new AgentOpsError(
      "MANIFEST_INVALID_JSON",
      "The installation manifest is not valid JSON.",
      { cause: error }
    );
  }
  const result = validateManifest(value);
  if (!result.ok) {
    throw new AgentOpsError(
      "MANIFEST_INVALID",
      `${result.errors[0]?.path ?? "$"}: ${
        result.errors[0]?.message ?? "Invalid installation manifest."
      }`
    );
  }
  return result.value;
}

export function formatInstallManifest(manifest: InstallManifest): string {
  const result = validateManifest(manifest);
  if (!result.ok) {
    throw new AgentOpsError(
      "MANIFEST_INVALID",
      `${result.errors[0]?.path ?? "$"}: ${
        result.errors[0]?.message ?? "Invalid installation manifest."
      }`
    );
  }
  return `${JSON.stringify(result.value, null, 2)}\n`;
}
