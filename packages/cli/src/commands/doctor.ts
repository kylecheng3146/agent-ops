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
  return `${[
    "Installation doctor",
    ...report.checks.map(
      ({ id, status, message }) => `- ${status} ${id}: ${message}`
    )
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
  return {
    code,
    status:
      hasFailure || hasUnsupported || hasUnknown || hasDegraded
        ? "error"
        : "ok",
    data: {
      report,
      message,
      text: formatDoctorReport(report)
    },
    errors:
      hasFailure || hasUnsupported || hasUnknown || hasDegraded
        ? [{ code, message }]
        : []
  };
}
