import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs } from "../../packages/cli/src/args.js";
import {
  runVerifyCommand,
  type VerificationExecutor,
  type VerifyTaskResolver
} from "../../packages/cli/src/commands/verify.js";
import { AgentOpsError } from "../../runtime/src/fs/paths.js";
import type {
  VerificationReport
} from "../../runtime/src/verify/service.js";

const SECRET = `ghp_${"b".repeat(24)}`;

function report(
  status: VerificationReport["status"]
): VerificationReport {
  return {
    taskId: "task-one",
    status,
    surface: {
      staged: ["src/example.ts"],
      unstaged: [],
      untracked: [],
      paths: ["src/example.ts"]
    },
    selection: {
      verifierIds: ["unit"],
      fallback: false,
      reason: "mapped",
      evidence: {
        changedPaths: ["src/example.ts"],
        mappings: [
          {
            changedPath: "src/example.ts",
            mappingPaths: ["src"],
            verifierIds: ["unit"]
          }
        ],
        requiredVerifierIds: ["unit"]
      }
    },
    results: [
      {
        commandId: "unit",
        required: true,
        status,
        failureClass: status === "PASS" ? "none" : "nonzero-exit",
        exitCode: status === "UNKNOWN" ? null : status === "PASS" ? 0 : 1,
        timedOut: false,
        testCount: 2,
        diagnostic: `token=${SECRET}`,
        evidenceReferences: [
          ".agent-ops/tasks/evidence/task-one/unit-evidence.json"
        ]
      }
    ],
    signal:
      status === "FAIL" ? "CHANGE_APPROACH_REQUIRED" : null
  };
}

function executor(
  status: VerificationReport["status"]
): VerificationExecutor & { readonly taskIds: string[] } {
  const taskIds: string[] = [];
  return {
    taskIds,
    verify: async (taskId) => {
      taskIds.push(taskId);
      return report(status);
    }
  };
}

const resolver: VerifyTaskResolver = {
  status: async () => ({ task: { id: "task-one" } })
};

test("verify command resolves a task directly and renders safe PASS output", async () => {
  const service = executor("PASS");
  const result = await runVerifyCommand({
    args: parseArgs(["verify", "--task", "task-one"]),
    service,
    taskService: resolver
  });

  assert.equal(result.code, "VERIFICATION_PASSED");
  assert.equal(result.status, "ok");
  assert.deepEqual(service.taskIds, ["task-one"]);
  assert.match(result.data?.text ?? "", /PASS unit \(tests: 2\)/);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(SECRET));
  assert.equal(
    "diagnostic" in (result.data?.report.results[0] ?? {}),
    false
  );
});

test("verify command resolves an attached session and preserves failure status", async () => {
  const service = executor("FAIL");
  const result = await runVerifyCommand({
    args: parseArgs(["verify", "--session", "session-one"]),
    service,
    taskService: resolver
  });

  assert.equal(result.code, "VERIFICATION_FAILED");
  assert.equal(result.status, "error");
  assert.match(result.data?.text ?? "", /CHANGE_APPROACH_REQUIRED/);
  assert.deepEqual(service.taskIds, ["task-one"]);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(SECRET));
});

test("verify command fails closed when no task target is available", async () => {
  const result = await runVerifyCommand({
    args: parseArgs(["verify"]),
    service: executor("PASS"),
    taskService: resolver
  });

  assert.equal(result.code, "VERIFY_TASK_REQUIRED");
  assert.equal(result.status, "error");
  assert.equal(result.data, null);
});

test("verify command returns UNKNOWN as an error envelope with evidence", async () => {
  const result = await runVerifyCommand({
    args: parseArgs(["verify", "--task", "task-one"]),
    service: executor("UNKNOWN"),
    taskService: resolver
  });

  assert.equal(result.code, "VERIFICATION_UNKNOWN");
  assert.equal(result.status, "error");
  assert.equal(
    result.data?.report.results[0]?.evidenceReferences.length,
    1
  );
});

test("verify command redacts and flattens verifier error messages", async () => {
  const result = await runVerifyCommand({
    args: parseArgs(["verify", "--task", "task-one"]),
    service: {
      verify: async () => {
        throw new AgentOpsError(
          "CHANGE_SURFACE_UNSAFE_PATH",
          `Unsafe path token=${SECRET}\nsecond line`
        );
      }
    },
    taskService: resolver
  });

  assert.equal(result.code, "CHANGE_SURFACE_UNSAFE_PATH");
  assert.doesNotMatch(JSON.stringify(result), new RegExp(SECRET));
  assert.doesNotMatch(result.errors[0]?.message ?? "", /\n/u);
  assert.match(
    result.errors[0]?.message ?? "",
    /\[REDACTED_VALUE\]/
  );
});
