import type {
  AgentOpsConfig,
  PathMapping,
  Profile,
  SecurityException,
  VerificationCommand
} from "../contracts.js";
import { AgentOpsError } from "../fs/paths.js";
import { validateConfig } from "../schema/validate.js";

export type ConfigSource = "default" | "project" | "user";

export interface ConfigLayer {
  source: ConfigSource;
  sourcePath: string;
  config: AgentOpsConfig;
}

export interface EffectiveValue<T> {
  value: T;
  source: ConfigSource;
  sourcePath: string;
}

export interface ConfigProvenance {
  schemaVersion: EffectiveValue<number>;
  profiles: EffectiveValue<Profile>[];
  verificationCommands: EffectiveValue<VerificationCommand>[];
  pathMappings: EffectiveValue<PathMapping>[];
  securityExceptions: EffectiveValue<SecurityException>[];
}

export interface MergedConfig {
  config: AgentOpsConfig;
  provenance: ConfigProvenance;
}

const SOURCE_RANK: Record<ConfigSource, number> = {
  default: 0,
  user: 1,
  project: 2
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

function mappingKey(mapping: PathMapping): string {
  return mapping.path.toLowerCase();
}

function exceptionKey(exception: SecurityException): string {
  return `${exception.ruleId}\0${exception.scope.toLowerCase()}`;
}

function sameException(
  left: SecurityException,
  right: SecurityException
): boolean {
  return (
    left.ruleId === right.ruleId &&
    left.scope.toLowerCase() === right.scope.toLowerCase() &&
    left.expiresAt === right.expiresAt &&
    left.reason === right.reason
  );
}

function assertUniqueKeys<T>(
  values: readonly T[],
  keyOf: (value: T) => string,
  layer: ConfigLayer,
  collection: string
): void {
  const keys = new Set<string>();
  for (const value of values) {
    const key = keyOf(value);
    if (keys.has(key)) {
      throw new AgentOpsError(
        "CONFIG_DUPLICATE_ID",
        `Duplicate ${collection} stable ID in ${layer.source} config.`
      );
    }
    keys.add(key);
  }
}

function assertLayer(layer: ConfigLayer): void {
  const validation = validateConfig(layer.config);
  if (!validation.ok) {
    const first = validation.errors[0];
    throw new AgentOpsError(
      first?.code === "DUPLICATE_ID"
        ? "CONFIG_DUPLICATE_ID"
        : "CONFIG_INVALID",
      `Invalid ${layer.source} config${
        first === undefined ? "." : `: ${first.code} at ${first.path}.`
      }`
    );
  }
  assertUniqueKeys(
    layer.config.verification.commands,
    (command) => command.id,
    layer,
    "verification command"
  );
  assertUniqueKeys(
    layer.config.pathMappings,
    mappingKey,
    layer,
    "path mapping"
  );
  assertUniqueKeys(
    layer.config.securityExceptions,
    exceptionKey,
    layer,
    "security exception"
  );
}

function assertProjectCommandIsMonotonic(
  existing: EffectiveValue<VerificationCommand> | undefined,
  candidate: VerificationCommand
): void {
  if (
    existing === undefined ||
    existing.source === "project"
  ) {
    return;
  }
  const previous = existing.value;
  const previousMinimum = previous.evidence.minimum ?? 0;
  const candidateMinimum = candidate.evidence.minimum ?? 0;
  const weakensRequired = previous.required && !candidate.required;
  const enablesShell = previous.shell !== true && candidate.shell === true;
  const lowersEvidence =
    previous.evidence.kind !== candidate.evidence.kind ||
    candidateMinimum < previousMinimum;
  const weakensTimeout =
    previous.timeoutMs !== undefined &&
    (candidate.timeoutMs === undefined ||
      candidate.timeoutMs > previous.timeoutMs);

  if (
    weakensRequired ||
    enablesShell ||
    lowersEvidence ||
    weakensTimeout
  ) {
    throw new AgentOpsError(
      "PROJECT_GUARDRAIL_WEAKENING",
      `Project command cannot weaken protected verifier ID: ${candidate.id}`
    );
  }
}

function assertProjectMappingIsMonotonic(
  existing: EffectiveValue<PathMapping> | undefined,
  candidate: PathMapping
): void {
  if (existing === undefined || existing.source === "project") {
    return;
  }
  const candidateIds = new Set(candidate.verifierIds);
  if (
    existing.value.verifierIds.some(
      (verifierId) => !candidateIds.has(verifierId)
    )
  ) {
    throw new AgentOpsError(
      "PROJECT_GUARDRAIL_WEAKENING",
      `Project mapping cannot drop verifier coverage for: ${candidate.path}`
    );
  }
}

function effective<T>(
  value: T,
  layer: ConfigLayer
): EffectiveValue<T> {
  return {
    value: clone(value),
    source: layer.source,
    sourcePath: layer.sourcePath
  };
}

export function mergeConfigLayers(
  inputLayers: readonly ConfigLayer[]
): MergedConfig {
  if (inputLayers.length === 0) {
    throw new AgentOpsError(
      "CONFIG_LAYER_REQUIRED",
      "At least one configuration layer is required."
    );
  }
  const sources = new Set<ConfigSource>();
  for (const layer of inputLayers) {
    if (sources.has(layer.source)) {
      throw new AgentOpsError(
        "CONFIG_LAYER_DUPLICATE",
        `Configuration source may appear only once: ${layer.source}`
      );
    }
    sources.add(layer.source);
    assertLayer(layer);
  }
  const layers = [...inputLayers].sort(
    (left, right) => SOURCE_RANK[left.source] - SOURCE_RANK[right.source]
  );

  const profiles = new Map<Profile, EffectiveValue<Profile>>();
  const commands = new Map<
    string,
    EffectiveValue<VerificationCommand>
  >();
  const mappings = new Map<string, EffectiveValue<PathMapping>>();
  const exceptions = new Map<
    string,
    EffectiveValue<SecurityException>
  >();
  let schemaVersion: EffectiveValue<number> | undefined;

  for (const layer of layers) {
    schemaVersion = effective(layer.config.schemaVersion, layer);
    for (const profile of layer.config.profiles) {
      profiles.set(profile, effective(profile, layer));
    }
    for (const command of layer.config.verification.commands) {
      if (layer.source === "project") {
        assertProjectCommandIsMonotonic(commands.get(command.id), command);
      }
      commands.set(command.id, effective(command, layer));
    }
    for (const mapping of layer.config.pathMappings) {
      const key = mappingKey(mapping);
      if (layer.source === "project") {
        assertProjectMappingIsMonotonic(mappings.get(key), mapping);
      }
      mappings.set(key, effective(mapping, layer));
    }
    for (const securityException of layer.config.securityExceptions) {
      const key = exceptionKey(securityException);
      const existing = exceptions.get(key);
      if (layer.source === "project") {
        if (
          existing === undefined ||
          !sameException(existing.value, securityException)
        ) {
          throw new AgentOpsError(
            "PROJECT_SECURITY_WEAKENING",
            `Project config cannot authorize security exception: ${securityException.ruleId}`
          );
        }
        continue;
      }
      exceptions.set(key, effective(securityException, layer));
    }
  }

  if (schemaVersion === undefined) {
    throw new AgentOpsError(
      "CONFIG_LAYER_REQUIRED",
      "At least one configuration layer is required."
    );
  }
  const provenance: ConfigProvenance = {
    schemaVersion,
    profiles: [...profiles.values()],
    verificationCommands: [...commands.values()],
    pathMappings: [...mappings.values()],
    securityExceptions: [...exceptions.values()]
  };
  const config: AgentOpsConfig = {
    schemaVersion: 1,
    profiles: provenance.profiles.map(({ value }) => value),
    verification: {
      commands: provenance.verificationCommands.map(({ value }) => value)
    },
    pathMappings: provenance.pathMappings.map(({ value }) => value),
    securityExceptions: provenance.securityExceptions.map(({ value }) => value)
  };
  const validation = validateConfig(config);
  if (!validation.ok) {
    const first = validation.errors[0];
    throw new AgentOpsError(
      "CONFIG_MERGE_INVALID",
      `Merged config is invalid${
        first === undefined ? "." : `: ${first.code} at ${first.path}.`
      }`
    );
  }
  return {
    config: clone(validation.value),
    provenance: clone(provenance)
  };
}
