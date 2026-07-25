import type { AgentOpsConfig } from "../contracts.js";
import { SCHEMA_VERSION } from "../contracts.js";
import { AgentOpsError } from "../fs/paths.js";
import { validateConfig } from "../schema/validate.js";

export interface MigrationStep {
  fromVersion: number;
  toVersion: number;
}

export interface ConfigMigrationPreview {
  migrated: AgentOpsConfig;
  steps: MigrationStep[];
}

type UnknownRecord = Record<string, unknown>;
type Migration = (input: UnknownRecord) => UnknownRecord;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

const MIGRATIONS = new Map<number, Migration>([
  [
    0,
    (input) => {
      const { commands, schemaVersion: _schemaVersion, ...rest } = input;
      return {
        ...rest,
        schemaVersion: 1,
        verification: { commands: clone(commands) }
      };
    }
  ]
]);

function schemaVersionOf(value: unknown): number {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.schemaVersion) ||
    (value.schemaVersion as number) < 0
  ) {
    throw new AgentOpsError(
      "CONFIG_SCHEMA_INVALID",
      "Config schemaVersion must be a non-negative integer."
    );
  }
  return value.schemaVersion as number;
}

export function previewConfigMigration(
  input: unknown
): ConfigMigrationPreview {
  const sourceVersion = schemaVersionOf(input);
  if (sourceVersion > SCHEMA_VERSION) {
    throw new AgentOpsError(
      "CONFIG_SCHEMA_FUTURE",
      `Config schemaVersion ${sourceVersion} is newer than supported version ${SCHEMA_VERSION}.`
    );
  }

  let migrated: unknown = clone(input);
  let version = sourceVersion;
  const steps: MigrationStep[] = [];
  while (version < SCHEMA_VERSION) {
    const migration = MIGRATIONS.get(version);
    if (migration === undefined || !isRecord(migrated)) {
      throw new AgentOpsError(
        "CONFIG_MIGRATION_MISSING",
        `No migration is registered from config schemaVersion ${version}.`
      );
    }
    const nextVersion = version + 1;
    migrated = migration(clone(migrated));
    if (schemaVersionOf(migrated) !== nextVersion) {
      throw new AgentOpsError(
        "CONFIG_MIGRATION_INVALID",
        `Migration ${version} must produce schemaVersion ${nextVersion}.`
      );
    }
    steps.push({ fromVersion: version, toVersion: nextVersion });
    version = nextVersion;
  }

  const validation = validateConfig(migrated);
  if (!validation.ok) {
    const first = validation.errors[0];
    throw new AgentOpsError(
      "CONFIG_INVALID",
      `Migrated config is invalid${
        first === undefined ? "." : `: ${first.code} at ${first.path}.`
      }`
    );
  }
  return {
    migrated: clone(validation.value),
    steps
  };
}
