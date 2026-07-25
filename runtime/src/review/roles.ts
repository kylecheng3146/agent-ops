export type ReviewRole = "implementer" | "spec-reviewer" | "security-reviewer";

export interface ReviewRoleConfig {
  readonly role: ReviewRole;
  readonly harness: "codex" | "claude";
  readonly model: string;
  readonly effort: string;
}

export function resolveReviewRole(
  role: ReviewRole,
  configured: readonly ReviewRoleConfig[]
): ReviewRoleConfig | undefined {
  return configured.find((item) => item.role === role);
}
