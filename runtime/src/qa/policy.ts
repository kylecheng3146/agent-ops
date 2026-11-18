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
/** Staleness is derived; mutating a progress record cannot make old proof current. */
export function qaVersionMatches(saved: QaVersion, current: QaVersion): boolean {
  return validQaVersion(saved) && validQaVersion(current) && canonicalJson(saved) === canonicalJson(current);
}
