import type { EvidenceKind } from "../contracts.js";
import type {
  ConfigSource,
  MergedConfig
} from "./merge.js";

interface SourceExplanation {
  source: ConfigSource;
  sourcePath: string;
}

export interface ProfileExplanation extends SourceExplanation {
  id: string;
}

export interface CommandExplanation extends SourceExplanation {
  id: string;
  required: boolean;
  shell: boolean;
  evidence: {
    kind: EvidenceKind;
    minimum: number | null;
  };
}

export interface MappingExplanation extends SourceExplanation {
  path: string;
  verifierIds: string[];
}

export interface SecurityExceptionExplanation extends SourceExplanation {
  ruleId: string;
  scope: string;
  expiresAt: string;
}

export interface ConfigExplanation {
  schemaVersion: number;
  features: {
    completionGate: {
      enabled: boolean;
      source: ConfigSource;
      sourcePath: string;
    };
    stopVerification: {
      enabled: boolean;
      source: ConfigSource;
      sourcePath: string;
    };
  };
  profiles: ProfileExplanation[];
  verificationCommands: CommandExplanation[];
  pathMappings: MappingExplanation[];
  securityExceptions: SecurityExceptionExplanation[];
}

export function explainConfig(merged: MergedConfig): ConfigExplanation {
  return {
    schemaVersion: merged.config.schemaVersion,
    features: {
      completionGate: {
        enabled: merged.config.features.completionGate.enabled,
        source: merged.provenance.features.source,
        sourcePath: merged.provenance.features.sourcePath
      },
      stopVerification: {
        enabled: merged.config.features.stopVerification.enabled,
        source: merged.provenance.features.source,
        sourcePath: merged.provenance.features.sourcePath
      }
    },
    profiles: merged.provenance.profiles.map((entry) => ({
      id: entry.value,
      source: entry.source,
      sourcePath: entry.sourcePath
    })),
    verificationCommands:
      merged.provenance.verificationCommands.map((entry) => ({
        id: entry.value.id,
        required: entry.value.required,
        shell: entry.value.shell === true,
        evidence: {
          kind: entry.value.evidence.kind,
          minimum: entry.value.evidence.minimum ?? null
        },
        source: entry.source,
        sourcePath: entry.sourcePath
      })),
    pathMappings: merged.provenance.pathMappings.map((entry) => ({
      path: entry.value.path,
      verifierIds: [...entry.value.verifierIds],
      source: entry.source,
      sourcePath: entry.sourcePath
    })),
    securityExceptions:
      merged.provenance.securityExceptions.map((entry) => ({
        ruleId: entry.value.ruleId,
        scope: entry.value.scope,
        expiresAt: entry.value.expiresAt,
        source: entry.source,
        sourcePath: entry.sourcePath
      }))
  };
}
