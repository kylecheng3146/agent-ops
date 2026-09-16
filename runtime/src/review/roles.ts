import type {
  AgentOpsConfig,
  ReviewRole,
  ReviewRoleConfig,
  ReviewTargetId
} from "../contracts.js";

export type { ReviewRole, ReviewRoleConfig, ReviewTargetId };

/** Stable option/configuration order used by init and config rendering. */
export const REVIEW_TARGET_ORDER: readonly ReviewTargetId[] = [
  "codex",
  "agy",
  "claude"
];

/**
 * What a new installation is offered and configured with.
 */
export const DEFAULT_REVIEW_TARGETS: readonly ReviewTargetId[] = [
  "codex",
  "agy",
  "claude"
];

export function resolveReviewRole(
  role: ReviewRole,
  configured: readonly ReviewRoleConfig[]
): ReviewRoleConfig | undefined {
  return configured.find((item) => item.role === role);
}

export function reviewTargets(
  config: AgentOpsConfig,
  role: ReviewRole
): readonly ReviewTargetId[] {
  return resolveReviewRole(role, config.reviewRoles ?? [])?.targets ?? [];
}

/**
 * Which review target is hosting this process, when that is knowable. Only
 * Claude Code publishes a documented marker; guessing the others would produce
 * a detector that silently fails, which is worse than no detector.
 */
export function detectHostTarget(
  env: Readonly<Record<string, string | undefined>>
): ReviewTargetId | undefined {
  const explicit = env.AGENT_OPS_HOST;
  if (explicit === "agy" || explicit === "claude" || explicit === "codex") {
    return explicit;
  }
  return undefined;
}

/**
 * Select exactly two reviewer invocations. Three configured targets require an
 * explicit host so the host can be excluded; two targets keep their configured
 * order; one target is deliberately invoked twice in fresh sessions.
 */
export interface ReviewTargetPlan {
  readonly targets: readonly ReviewTargetId[];
  readonly reason?: "host-identity-required";
}

export function planReviewTargets(
  targets: readonly ReviewTargetId[],
  host: ReviewTargetId | undefined
): ReviewTargetPlan {
  if (targets.length === 0) {
    return { targets: [] };
  }
  if (targets.length === 1) {
    return { targets: [targets[0]!, targets[0]!] };
  }
  if (targets.length === 2) {
    return { targets: [...targets] };
  }
  if (host === undefined || !targets.includes(host)) {
    return { targets: [], reason: "host-identity-required" };
  }
  const remaining = targets.filter((target) => target !== host);
  const primary = remaining.includes("agy") ? "agy" : remaining[0];
  if (primary === undefined) {
    return { targets: [] };
  }
  return {
    targets: [
      primary,
      ...remaining.filter((target) => target !== primary)
    ]
  };
}

/** @deprecated Use planReviewTargets().targets. */
export function orderChain(
  targets: readonly ReviewTargetId[],
  host: ReviewTargetId | undefined
): readonly ReviewTargetId[] {
  return planReviewTargets(targets, host).targets;
}
