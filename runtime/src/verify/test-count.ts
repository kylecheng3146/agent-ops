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
const NUMBER_SOURCE = String.raw`\d{1,16}`;

function safeCount(value: string): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0
    ? parsed
    : null;
}

function addCandidate(candidates: number[], source: string): void {
  const parsed = safeCount(source);
  if (parsed !== null) {
    candidates.push(parsed);
  }
}

function parsePytestSummary(line: string): number | null {
  if (!/\bin \d+(?:\.\d+)?s(?:\s|$)/u.test(line)) {
    return null;
  }
  const statusPattern = new RegExp(
    `(${NUMBER_SOURCE}) (passed|failed|skipped|error|errors|xfailed|xpassed|deselected)`,
    "gu"
  );
  let total = 0;
  let matched = false;
  for (const match of line.matchAll(statusPattern)) {
    const source = match[1];
    const status = match[2];
    if (source === undefined || status === undefined) {
      return null;
    }
    const count = safeCount(source);
    if (
      count === null ||
      (status !== "deselected" &&
        total > Number.MAX_SAFE_INTEGER - count)
    ) {
      return null;
    }
    if (status !== "deselected") {
      total += count;
    }
    matched = true;
  }
  return matched ? total : null;
}

function parseRustSummary(line: string): number | null {
  const match = new RegExp(
    `^test result: (?:ok|FAILED)\\. (${NUMBER_SOURCE}) passed; (${NUMBER_SOURCE}) failed; ${NUMBER_SOURCE} ignored; ${NUMBER_SOURCE} measured; ${NUMBER_SOURCE} filtered out$`,
    "u"
  ).exec(line);
  if (match === null) {
    return null;
  }
  const passedSource = match[1];
  const failedSource = match[2];
  if (passedSource === undefined || failedSource === undefined) {
    return null;
  }
  const passed = safeCount(passedSource);
  const failed = safeCount(failedSource);
  if (
    passed === null ||
    failed === null ||
    passed > Number.MAX_SAFE_INTEGER - failed
  ) {
    return null;
  }
  return passed + failed;
}

export function parseTestCount(output: string): number | null {
  if (
    output.includes("\0") ||
    Buffer.byteLength(output, "utf8") > MAX_SUMMARY_BYTES
  ) {
    return null;
  }
  const candidates: number[] = [];
  const nodePattern = new RegExp(`^# tests (${NUMBER_SOURCE})$`, "u");
  const collectedPattern = new RegExp(
    `^collected (${NUMBER_SOURCE}) items?$`,
    "u"
  );
  const jestPattern = new RegExp(
    `^Tests:\\s+.*\\b(${NUMBER_SOURCE}) total(?:\\s|$)`,
    "u"
  );
  const vitestPattern = new RegExp(
    `^Tests\\s+.*\\((${NUMBER_SOURCE})\\)\\s*$`,
    "u"
  );

  for (const rawLine of output.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    const node = nodePattern.exec(line);
    if (node?.[1] !== undefined) {
      addCandidate(candidates, node[1]);
    }
    const collected = collectedPattern.exec(line);
    if (collected?.[1] !== undefined) {
      addCandidate(candidates, collected[1]);
    }
    const jest = jestPattern.exec(line);
    if (jest?.[1] !== undefined) {
      addCandidate(candidates, jest[1]);
    }
    const vitest = vitestPattern.exec(line);
    if (vitest?.[1] !== undefined) {
      addCandidate(candidates, vitest[1]);
    }
    const pytest = parsePytestSummary(line);
    if (pytest !== null) {
      candidates.push(pytest);
    }
    const rust = parseRustSummary(line);
    if (rust !== null) {
      candidates.push(rust);
    }
  }

  const first = candidates[0];
  if (
    first === undefined ||
    candidates.some((candidate) => candidate !== first)
  ) {
    return null;
  }
  return first;
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
