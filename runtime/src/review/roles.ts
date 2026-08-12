import type {
  AgentOpsConfig,
  ReviewRole,
  ReviewRoleConfig,
  ReviewTargetId
} from "../contracts.js";

export type { ReviewRole, ReviewRoleConfig, ReviewTargetId };

/**
 * Default chain order. codex first because its stdout is the bare final message
 * (nothing to unwrap), then agy's flat envelope. claude is last because it is
 * the only host we can detect, and `orderChain` would push it back anyway.
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
  return env.CLAUDECODE === undefined ? undefined : "claude";
}

/**
 * Move the hosting target to the end so an independent reviewer is preferred,
 * without ever dropping it — a single configured target still runs, self-review
 * warning and all.
 */
export function orderChain(
  targets: readonly ReviewTargetId[],
  host: ReviewTargetId | undefined
): readonly ReviewTargetId[] {
  if (host === undefined) {
    return [...targets];
  }
  return [
    ...targets.filter((target) => target !== host),
    ...targets.filter((target) => target === host)
  ];
}
