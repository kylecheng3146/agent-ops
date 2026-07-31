import type { HarnessId } from "../contracts.js";

export type ReviewRole =
  | "mechanical"
  | "implementation"
  | "deep-reasoning"
  | "independent-review";

export interface ReviewRoleConfig {
  readonly role: ReviewRole;
  readonly harness: HarnessId;
  readonly model: string;
  readonly effort: string;
}

export function resolveReviewRole(
  role: ReviewRole,
  configured: readonly ReviewRoleConfig[]
): ReviewRoleConfig | undefined {
  return configured.find((item) => item.role === role);
}
