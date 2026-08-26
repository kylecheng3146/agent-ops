import { redactSecrets } from "../security/redact.js";
import { safeTaskText } from "../task/render.js";
import type { ReviewRunResult } from "./runner.js";

function safe(value: string): string {
  return safeTaskText(redactSecrets(value));
}

function lineList(values: readonly string[]): readonly string[] {
  return values.length === 0 ? ["- none"] : values.map((value) => `- ${safe(value)}`);
}

export function renderReviewResult(result: ReviewRunResult): string {
  const lines = [
    `Independent review: ${result.status}`,
    `Reviewer: ${result.harness}; model: ${safe(result.model)}; effort: ${safe(result.effort)}.`
  ];
  if (result.scope !== undefined) {
    lines.push(
      result.scope.mode === "base"
        ? `Scope: ${result.scope.mode} ${safe(result.scope.baseRef)} (${safe(result.scope.resolvedBase)}).`
        : "Scope: worktree."
    );
  }
  if (result.independence !== undefined) {
    lines.push(`Independence: ${result.independence}.`);
  }
  if (result.attempts !== undefined) {
    lines.push("Attempts:");
    for (const attempt of result.attempts) {
      lines.push(
        `- ${attempt.target}: ${attempt.status}` +
        `${attempt.reason === undefined ? "" : ` (${safe(attempt.reason)})`}`
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
    lines.push("Run: agent-ops doctor --check-auth to verify target authentication.");
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
  lines.push("", "Residual risks:", ...lineList(report.residualRisks));
  lines.push("", "Changed files inspected:", ...lineList(report.changedFilesInspected));
  lines.push("", "Supporting files inspected:", ...lineList(report.supportingFilesInspected));
  return `${lines.join("\n")}\n`;
}
