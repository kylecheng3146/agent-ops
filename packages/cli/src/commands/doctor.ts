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
  const code = hasFailure
    ? "DOCTOR_FAILED"
    : hasUnknown
      ? "DOCTOR_UNKNOWN"
      : "DOCTOR_OK";
  const message = hasFailure
    ? "Installation diagnostics found failures."
    : hasUnknown
      ? "Installation diagnostics contain unknown checks."
      : "Installation diagnostics passed.";
  return {
    code,
    status: hasFailure || hasUnknown ? "error" : "ok",
    data: {
      report,
      message,
      text: formatDoctorReport(report)
    },
    errors:
      hasFailure || hasUnknown ? [{ code, message }] : []
  };
}
