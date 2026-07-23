import { readFile } from "node:fs/promises";

import type { AgentOpsConfig } from "../contracts.js";
import { AgentOpsError } from "../fs/paths.js";
import {
  previewConfigMigration,
  type MigrationStep
} from "./migrate.js";

export interface LoadedConfig {
  config: AgentOpsConfig;
  sourcePath: string;
  migration: {
    steps: MigrationStep[];
  };
}

export async function loadConfigFile(path: string): Promise<LoadedConfig> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    throw new AgentOpsError(
      "CONFIG_READ_FAILED",
      `Unable to read config: ${path}`,
      { cause: error }
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (error) {
    throw new AgentOpsError(
      "CONFIG_PARSE_FAILED",
      `Unable to parse config JSON: ${path}`,
      { cause: error }
    );
  }
  const preview = previewConfigMigration(parsed);
  return {
    config: preview.migrated,
    sourcePath: path,
    migration: { steps: preview.steps }
  };
}
