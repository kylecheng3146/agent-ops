import type {
  HookCommandEvidence,
  HookResult,
  StopVerificationOptions
} from "./events.js";

const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

function unavailable(code: string): HookResult {
  return {
    action: "continue",
    status: "UNKNOWN",
    code
  };
}

function boundedEvidence(
  results: readonly HookCommandEvidence[]
): HookCommandEvidence[] | null {
  if (
    results.length > 256 ||
    results.some(
      (result) =>
        !ID_PATTERN.test(result.commandId) ||
        (result.exitCode !== null &&
          (!Number.isSafeInteger(result.exitCode) || result.exitCode < 0)) ||
        (result.testCount !== null &&
          (!Number.isSafeInteger(result.testCount) || result.testCount < 0))
    )
  ) {
    return null;
  }
  return results.map(({ commandId, exitCode, testCount }) => ({
    commandId,
    exitCode,
    testCount
  }));
}

function evidenceSupportsStatus(
  status: "FAIL" | "PASS" | "UNKNOWN",
  results: readonly HookCommandEvidence[]
): boolean {
  if (status !== "PASS") {
    return true;
  }
  return (
    results.length > 0 &&
    results.some(
      (result) =>
        result.testCount !== null && result.testCount > 0
    ) &&
    results.every(
      (result) =>
        result.exitCode === 0 &&
        (result.testCount === null || result.testCount > 0)
    )
  );
}

export async function runStopVerification(
  options: StopVerificationOptions
): Promise<HookResult> {
  if (options.recursionMarker) {
    return unavailable("STOP_VERIFICATION_RECURSION");
  }
  if (!options.confirmedConfig || !HASH_PATTERN.test(options.configHash)) {
    return unavailable("STOP_VERIFICATION_UNCONFIRMED");
  }
  if (!options.trusted) {
    return unavailable("STOP_VERIFICATION_UNTRUSTED");
  }
  if (!options.scopeMapped) {
    return unavailable("STOP_VERIFICATION_SCOPE_UNMAPPED");
  }

  try {
    const report = await options.verify();
    const commandResults = boundedEvidence(report.results);
    const timestamp = (options.now ?? (() => new Date().toISOString()))();
    if (
      commandResults === null ||
      !evidenceSupportsStatus(report.status, commandResults) ||
      !Number.isFinite(Date.parse(timestamp))
    ) {
      return unavailable("STOP_VERIFICATION_EVIDENCE_INVALID");
    }
    return {
      action: "continue",
      status: report.status,
      code: "STOP_VERIFICATION_FINISHED",
      evidence: {
        commandResults,
        configHash: options.configHash,
        timestamp
      }
    };
  } catch {
    return unavailable("STOP_VERIFICATION_FAILED");
  }
}
