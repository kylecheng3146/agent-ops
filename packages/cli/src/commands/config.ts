import {
  explainConfig,
  type ConfigExplanation
} from "../../../../runtime/src/config/explain.js";
import type { MergedConfig } from "../../../../runtime/src/config/merge.js";
import {
  okEnvelope,
  type CliEnvelope
} from "../output.js";

export interface ConfigExplainOutput extends ConfigExplanation {
  message: string;
}

export function explainConfigCommand(
  merged: MergedConfig
): CliEnvelope<ConfigExplainOutput> {
  return okEnvelope("CONFIG_EXPLAIN", {
    ...explainConfig(merged),
    message: "Effective configuration provenance calculated."
  });
}
