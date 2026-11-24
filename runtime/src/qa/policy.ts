import type { AgentOpsConfig } from "../contracts.js";
import { canonicalJson } from "../config/hash.js";
import { sha256 } from "../fs/hash.js";
import { AgentOpsError } from "../fs/paths.js";
import type { QaPolicyBinding, QaVersion } from "./types.js";
import { validQaVersion } from "./validate.js";

export function requireQaPlatform(platform: NodeJS.Platform = process.platform): void {
  if (platform !== "darwin") throw new AgentOpsError("QA_UNSUPPORTED_PLATFORM", "Required QA is supported only on macOS.");
}
export function qaPolicyBinding(config: AgentOpsConfig, enrolledAt: string,
  enrollment: QaPolicyBinding["enrollment"], late = false, platform: NodeJS.Platform = process.platform): QaPolicyBinding {
  if (config.qa?.enabled !== true) throw new AgentOpsError("QA_NOT_ENABLED", "This project must explicitly opt in before enrolling a delivery.");
  requireQaPlatform(platform);
  return {schemaVersion: 1, required: true, policyHash: sha256(canonicalJson({domain: "agent-ops-qa-policy-v1", qa: config.qa})),
    enrolledAt, enrollment, late};
}
/**
 * The version 1.4.1 and earlier wrote for the same inputs (full task/tree contract and config hashes).
 * Kept beside each current version so an unchanged legacy seal or plan stays current after upgrading.
 */
const LEGACY = new WeakMap<QaVersion, QaVersion>();
export function withLegacyQaVersion(current: QaVersion, legacy: QaVersion): QaVersion {
  LEGACY.set(current, legacy);
  return current;
}
export function legacyQaVersion(current: QaVersion): QaVersion | undefined {
  return LEGACY.get(current);
}
/**
 * Only an environment the planner observed missing blocks. A read-only planner cannot probe a toolchain or a desktop
 * session, so unknown is advisory: execution proves mechanical cases (a failure stays UNKNOWN and blocks as unexecuted),
 * and nonmechanical cases never execute.
 */
export const qaEnvironmentBlocks = (e: {readonly required: boolean; readonly status: string}): boolean => e.required && e.status === "missing";
/** Staleness is derived; mutating a progress record cannot make old proof current. */
export function qaVersionMatches(saved: QaVersion, current: QaVersion): boolean {
  if (!validQaVersion(saved) || !validQaVersion(current)) return false;
  const legacy = LEGACY.get(current);
  return canonicalJson(saved) === canonicalJson(current) || (legacy !== undefined && canonicalJson(saved) === canonicalJson(legacy));
}
