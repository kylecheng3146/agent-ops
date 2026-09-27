export type TestCountStatus = "FAIL" | "PASS" | "UNKNOWN";

export type TestCountCode =
  | "TEST_COUNT_BELOW_MINIMUM"
  | "TEST_COUNT_INVALID"
  | "TEST_COUNT_OK"
  | "TEST_COUNT_REQUIREMENT_INVALID"
  | "TEST_COUNT_UNPARSEABLE"
  | "ZERO_TESTS";

export interface TestCountEvaluation {
  readonly status: TestCountStatus;
  readonly code: TestCountCode;
  readonly testCount: number | null;
}

const MAX_SUMMARY_BYTES = 1024 * 1024;
const NUMBER_SOURCE = String.raw`\d+`;

function safeCount(value: string): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0
    ? parsed
    : null;
}

export interface TestSummary {
  readonly passed: number | null;
  readonly failed: number;
}

/** Counts outcomes, never discovery totals. Conflicting summaries fail closed. */
export function parseTestSummary(output: string): TestSummary {
  if (output.includes("\0") || Buffer.byteLength(output, "utf8") > MAX_SUMMARY_BYTES) {
    return { passed: null, failed: 0 };
  }
  const summaries: TestSummary[] = [];
  let nodePassed: number | null = null;
  let nodeFailed = 0;
  let nodeSeen = false;
  let invalid = false;
  const nodeCounts = new Map<string, number>();
  for (const raw of output.replace(/\u001b\[[0-9;]*m/gu, "").split(/\r?\n/u)) {
    const line = raw.trim();
    const node = new RegExp(`^(?:#|ℹ) (tests|pass|fail|cancelled|skipped|todo) (${NUMBER_SOURCE})$`, "u").exec(line);
    if (node !== null) {
      nodeSeen = true;
      const count = safeCount(node[2]!);
      if (count === null || (nodeCounts.has(node[1]!) && nodeCounts.get(node[1]!) !== count)) invalid = true;
      else nodeCounts.set(node[1]!, count);
      continue;
    }
    if (/^(?:#|ℹ) (?:tests|pass|fail|cancelled|skipped|todo)\b/u.test(line)) {
      invalid = true;
      continue;
    }
    const rust = new RegExp(`^test result: (ok|FAILED)\\. (${NUMBER_SOURCE}) passed; (${NUMBER_SOURCE}) failed;`, "u").exec(line);
    if (rust !== null) {
      const passed = safeCount(rust[2]!);
      const failed = safeCount(rust[3]!);
      if (passed === null || failed === null) invalid = true;
      summaries.push({ passed, failed: Math.max(failed ?? 0, rust[1] === "FAILED" ? 1 : 0) });
      continue;
    }
    const isJest = /^Tests:/u.test(line);
    const isVitest = /^Tests\s+/u.test(line) && /\(\d+\)\s*$/u.test(line);
    const isPytest = /\bin \d+(?:\.\d+)?s(?:\s|=|$)/u.test(line);
    if (isJest || isVitest || isPytest) {
      let passed = 0;
      let failed = 0;
      let matched = false;
      let total = 0;
      const seen = new Set<string>();
      for (const match of line.matchAll(new RegExp(`(${NUMBER_SOURCE}) (passed|failed|skipped|todo|error|errors|cancelled|xfailed|xpassed|deselected)\\b`, "gu"))) {
        matched = true;
        const count = safeCount(match[1]!);
        const status = match[2]!;
        if (count === null || seen.has(status)) { invalid = true; continue; }
        seen.add(status);
        if (status !== "deselected") total += count;
        if (!Number.isSafeInteger(total)) invalid = true;
        if (status === "passed") passed = count;
        if (["failed", "error", "errors", "cancelled"].includes(status)) {
          failed += count;
          if (!Number.isSafeInteger(failed)) invalid = true;
        }
      }
      const totalMatch = isJest ? /\b(\d+) total(?:\s|$)/u.exec(line) : isVitest ? /\((\d+)\)\s*$/u.exec(line) : null;
      if (matched && totalMatch !== null && safeCount(totalMatch[1]!) !== total) invalid = true;
      // Missing passed in a recognized outcome summary means zero passes;
      // a discovery/total-only line gives no outcome evidence.
      summaries.push({ passed: matched ? passed : null, failed });
      continue;
    }
    if (/^collected 0 items?$/u.test(line)) summaries.push({ passed: 0, failed: 0 });
  }
  if (nodeSeen) {
    nodePassed = nodeCounts.get("pass") ?? (nodeCounts.get("tests") === 0 ? 0 : null);
    nodeFailed = (nodeCounts.get("fail") ?? 0) + (nodeCounts.get("cancelled") ?? 0);
    if (!Number.isSafeInteger(nodeFailed)) invalid = true;
    const total = nodeCounts.get("tests");
    const outcomes = (nodePassed ?? 0) + nodeFailed + (nodeCounts.get("skipped") ?? 0) + (nodeCounts.get("todo") ?? 0);
    if (!Number.isSafeInteger(outcomes) || (total !== undefined && outcomes > total)) invalid = true;
    summaries.push({ passed: nodePassed, failed: nodeFailed });
  }
  const first = summaries[0];
  const failed = summaries.some((summary) => summary.failed > 0) ? 1 : 0;
  if (invalid || first === undefined || summaries.some((summary) => summary.passed !== first.passed || summary.failed !== first.failed)) {
    return { passed: null, failed };
  }
  return { passed: first.passed, failed: first.failed };
}

export function parseTestCount(output: string): number | null {
  return parseTestSummary(output).passed;
}

export function evaluateTestCount(
  testCount: number | null,
  minimum = 1
): TestCountEvaluation {
  if (!Number.isSafeInteger(minimum) || minimum < 0) {
    return {
      status: "UNKNOWN",
      code: "TEST_COUNT_REQUIREMENT_INVALID",
      testCount
    };
  }
  if (testCount === null) {
    return {
      status: "UNKNOWN",
      code: "TEST_COUNT_UNPARSEABLE",
      testCount: null
    };
  }
  if (!Number.isSafeInteger(testCount) || testCount < 0) {
    return {
      status: "UNKNOWN",
      code: "TEST_COUNT_INVALID",
      testCount: null
    };
  }
  if (testCount === 0) {
    return {
      status: "FAIL",
      code: "ZERO_TESTS",
      testCount
    };
  }
  if (testCount < minimum) {
    return {
      status: "FAIL",
      code: "TEST_COUNT_BELOW_MINIMUM",
      testCount
    };
  }
  return {
    status: "PASS",
    code: "TEST_COUNT_OK",
    testCount
  };
}
