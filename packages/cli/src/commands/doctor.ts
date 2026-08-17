import {
  doctorInstallation,
  type DoctorInstallationOptions,
  type DoctorReport
} from "../../../../runtime/src/install/doctor.js";
import type { CliEnvelope } from "../output.js";

export interface DoctorCommandData {
  readonly report: DoctorReport;
  readonly message: string;
  readonly text: string;
}

function formatDoctorReport(report: DoctorReport): string {
  const surfaces = report.surfaces ?? [];
  return `${[
    "Installation doctor",
    ...report.checks.flatMap(({ id, status, message, code, remediation }) => [
      `- ${status} ${id}${code === undefined ? "" : ` [${code}]`}: ${message}`,
      ...(remediation === undefined ? [] : [`  → ${remediation}`])
    ]),
    ...(surfaces.length === 0
      ? []
      : [
          "Surfaces:",
          ...surfaces.map(
            ({
              harness,
              surfaceId,
              path,
              status,
              managedHandlerCount,
              foreignHandlerCount,
              reason
            }) =>
              `- ${status} ${harness}/${surfaceId}: ${path} ` +
              `(managed ${managedHandlerCount}, foreign ${foreignHandlerCount})` +
              (reason === undefined ? "" : ` (${reason})`)
          )
        ])
  ].join("\n")}\n`;
}

export async function runDoctorCommand(
  options: DoctorInstallationOptions
): Promise<CliEnvelope<DoctorCommandData>> {
  const report = await doctorInstallation(options);
  const hasFailure = report.checks.some(
    ({ status }) => status === "FAIL"
  );
  const hasUnknown = report.checks.some(
    ({ status }) => status === "UNKNOWN"
  );
  const hasUnsupported = report.checks.some(
    ({ status }) => status === "UNSUPPORTED"
  );
  const hasDegraded = report.checks.some(
    ({ status }) => status === "DEGRADED"
  );
  const code = hasFailure
    ? "DOCTOR_FAILED"
    : hasUnsupported
      ? "DOCTOR_UNSUPPORTED"
      : hasUnknown
      ? "DOCTOR_UNKNOWN"
      : hasDegraded
        ? "DOCTOR_DEGRADED"
        : "DOCTOR_OK";
  const message = hasFailure
    ? "Installation diagnostics found failures."
    : hasUnsupported
      ? "Installation diagnostics found unsupported capabilities."
      : hasUnknown
      ? "Installation diagnostics contain unknown checks."
      : hasDegraded
        ? "Installation diagnostics found degraded checks."
        : "Installation diagnostics passed.";
  // Exit non-zero only when there is something to do: a hard failure, or a
  // check that names an agent-ops command via `code`. UNKNOWN, UNSUPPORTED,
  // and codeless DEGRADED (e.g. a harness-declared permanent degradation)
  // are benign findings and must not force a non-zero exit.
  const isActionable = report.checks.some(
    ({ status, code: checkCode }) => status === "FAIL" || checkCode !== undefined
  );
  return {
    code,
    status: isActionable ? "error" : "ok",
    data: {
      report,
      message,
      text: formatDoctorReport(report)
    },
    errors: isActionable ? [{ code, message }] : []
  };
}
