import type { InstallManifest } from "../contracts.js";
import { MANIFEST_SCHEMA_VERSION } from "../contracts.js";
import { validateManifest } from "../schema/validate.js";
import { AgentOpsError } from "./paths.js";

export const PROJECT_MANIFEST_PATH = ".agent-ops/manifest.json";

const LEGACY_HARNESS_SELECTIONS: Readonly<Record<string, string[]>> = {
  both: ["codex", "claude"],
  claude: ["claude"],
  codex: ["codex"]
};

/**
 * Manifests written up to 0.1.4 stored a single harness string, with `"both"`
 * standing in for two harnesses. Reading one upgrades it in memory; the file is
 * rewritten the next time `update` runs.
 */
function migrateLegacyManifest(value: unknown): unknown {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return value;
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || typeof record.harness !== "string") {
    return value;
  }
  const harness = LEGACY_HARNESS_SELECTIONS[record.harness];
  if (harness === undefined) {
    return value;
  }
  return {
    ...record,
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    harness
  };
}

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
  const result = validateManifest(migrateLegacyManifest(value));
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
