import { redactSecrets } from "../security/redact.js";
import { safeTaskText } from "../task/render.js";
import type { ReviewRunResult } from "./runner.js";

function safe(value: string): string {
  return safeTaskText(redactSecrets(value));
}

/**
 * NOT_RUN reasons that mean the task's verification evidence, not the reviewer,
 * stopped the run: every one of them is cleared by producing fresh evidence.
 */
const VERIFICATION_EVIDENCE_REASONS: ReadonlySet<string> = new Set([
  "stale-verification",
  "missing-verification-evidence",
  "unreadable-verification-evidence",
  "verification-not-passed"
]);

function lineList(values: readonly string[]): readonly string[] {
  return values.length === 0 ? ["- none"] : values.map((value) => `- ${safe(value)}`);
}

export function renderReviewResult(result: ReviewRunResult): string {
  const plannedTargets = result.plannedTargets ?? [result.harness];
  const lines = [
    `Independent review: ${result.status}`,
    `Reviewer: ${result.harness}; model: ${safe(result.model)}; effort: ${safe(result.effort)}.`,
    `Planned reviewers: ${plannedTargets.length === 0 ? "none" : plannedTargets.join(" → ")}.`
  ];
  if (result.scope !== undefined) {
    lines.push(
      result.scope.mode === "base"
        ? `Scope: ${result.scope.mode} ${safe(result.scope.baseRef)} (${safe(result.scope.resolvedBase)}).`
        : "Scope: worktree."
    );
  }
  if (result.independence !== undefined) {
    lines.push(
      result.independence === "same-target"
        ? "Independence: DEGRADED (same-target isolated self-review)."
        : `Independence: ${result.independence}.`
    );
  }
  if (result.sessionIsolation !== undefined) {
    lines.push(`Session isolation: ${result.sessionIsolation}.`);
  }
  if (result.attempts !== undefined) {
    lines.push("Attempts:");
    for (const attempt of result.attempts) {
      lines.push(
        `- ${attempt.target}: ${attempt.status}` +
        `${attempt.reason === undefined ? "" : ` (${safe(attempt.reason)})`}` +
        `${attempt.diagnostic === undefined ? "" : ` — ${safe(attempt.diagnostic)}`}`
      );
    }
  }
  if (result.verification !== undefined) {
    lines.push("Machine verification:");
    for (const command of result.verification.commands) {
      lines.push(
        `- ${safe(command.criterionId)}/${safe(command.commandId)}: ${command.status}` +
        `${command.required ? " (required)" : " (optional)"}` +
        `${command.evidenceReference === undefined ? "" : ` — ${safe(command.evidenceReference)}`}`
      );
    }
  }
  if (result.report === undefined) {
    lines.push(`Reason: ${result.reason ?? "unknown"}.`);
    for (const error of result.validationErrors ?? []) {
      lines.push(`- ${safe(error.path)}: ${safe(error.code)} — ${safe(error.message)}`);
    }
    if (
      result.reason === "login-required" ||
      result.attempts?.some((attempt) => attempt.reason === "login-required")
    ) {
      lines.push("Run: agent-ops doctor --check-auth to verify target authentication.");
    }
    // Evidence is pinned to the source it was produced from, so any edit to a
    // changed file after the verifier ran — a doc rewritten by a later step
    // counts — voids it. Without the next command the caller reads
    // "stale-verification" as a review failure and retries review instead.
    if (result.reason === "stale-verification") {
      lines.push(
        "The source changed after this evidence was recorded, so it no longer " +
        "describes the worktree under review."
      );
    }
    const verifyCommand =
      `agent-ops verify --task ${result.taskId ?? "<task-id>"}`;
    if (result.reason === "verification-not-passed") {
      // No review invitation: the verifier failed, and review is refused until
      // a passing run replaces that evidence. Naming review here is what sent
      // the caller back to the command that had just refused them.
      lines.push(
        "The recorded verification did not pass. Fix what failed, then run: " +
        `${verifyCommand}. Re-running review cannot turn a failing verifier ` +
        "into a PASS."
      );
    } else if (VERIFICATION_EVIDENCE_REASONS.has(result.reason ?? "")) {
      lines.push(`Run: ${verifyCommand}, then run this review again.`);
    }
    if (result.reason === "host-sandboxed") {
      lines.push(
        "No target ran: the sandbox around this process blocks the network a " +
        "reviewer needs. Run agent-ops review outside the sandbox, or grant " +
        "this command escalated execution and run it again."
      );
    }
    // Deliberately not the authentication line: a stalled reviewer started and
    // then went silent, so re-running it with more permission only spends the
    // same wait again.
    if (
      result.reason === "stalled" ||
      result.attempts?.some((attempt) => attempt.reason === "stalled")
    ) {
      lines.push(
        "A stalled reviewer is usually blocked by the host sandbox. Escalating " +
        "permission and retrying does not help; run agent-ops review outside " +
        "the sandbox instead."
      );
    }
    return `${lines.join("\n")}\n`;
  }
  const report = result.report;
  const nonBlocking = report.findings.filter((finding) => !finding.blocking).length;
  lines.push(`Non-blocking findings: ${nonBlocking}.`, "", "Summary:", safe(report.summary), "", "Criteria:");
  for (const item of report.results) {
    lines.push(`- ${safe(item.criterionId)}: ${item.status} — ${safe(item.summary)}`);
    lines.push(...item.evidence.map((evidence) => `  - ${safe(evidence)}`));
  }
  lines.push("", "Findings:");
  if (report.findings.length === 0) {
    lines.push("- none");
  } else {
    for (const finding of report.findings) {
      lines.push(`- [${finding.severity}] ${finding.blocking ? "blocking" : "non-blocking"}: ${safe(finding.title)}`);
      lines.push(`  ${safe(finding.details)}`);
      lines.push(`  Recommendation: ${safe(finding.recommendation)}`);
      lines.push(...finding.locations.map((location) => `  Location: ${safe(location.path)}${location.line === undefined ? "" : `:${location.line}`}`));
      lines.push(...finding.evidence.map((evidence) => `  Evidence: ${safe(evidence)}`));
    }
  }
  if (result.adversarial !== undefined) {
    const { target, refuted, report: challenge } = result.adversarial;
    // Without this block a refuted review reads as all-criteria-PASS yet FAIL.
    lines.push(
      "",
      `Adversarial re-check (${target}): ${refuted ? "refuted the PASS" : "upheld the PASS"}.`,
      safe(challenge.summary)
    );
    for (const finding of challenge.findings.filter((item) => item.blocking)) {
      lines.push(`- [${finding.severity}] blocking: ${safe(finding.title)}`);
      lines.push(`  ${safe(finding.details)}`);
      lines.push(`  Recommendation: ${safe(finding.recommendation)}`);
      lines.push(...finding.locations.map((location) => `  Location: ${safe(location.path)}${location.line === undefined ? "" : `:${location.line}`}`));
      lines.push(...finding.evidence.map((evidence) => `  Evidence: ${safe(evidence)}`));
    }
  }
  lines.push("", "Residual risks:", ...lineList(report.residualRisks));
  lines.push("", "Changed files inspected:", ...lineList(report.changedFilesInspected));
  lines.push("", "Supporting files inspected:", ...lineList(report.supportingFilesInspected));
  return `${lines.join("\n")}\n`;
}
