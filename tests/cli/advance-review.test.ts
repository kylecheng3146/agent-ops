import assert from "node:assert/strict";
import test from "node:test";

import { reviewFinalTree, type AdvanceStep } from "../../packages/cli/src/commands/advance.js";
import { AgentOpsError } from "../../runtime/src/fs/paths.js";
import { renderReviewHighlights } from "../../runtime/src/review/render.js";
import { reportFor } from "../review/report-fixture.js";

const pass = { code: "REVIEW_RESULT", status: "ok" as const, data: { result: { status: "PASS" } } };

test("normal final review makes one two-session tree call for all tasks", async () => {
  const calls: string[][] = [];
  const step: AdvanceStep = async (_cwd, args) => { calls.push([...args]); return pass; };
  assert.equal(await reviewFinalTree(step, "/candidate", "parent", ["parent", "child-a", "child-b"], "base"), "tree");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ["review", "--task", "parent", "--tree", "--base", "base", "--yes"]);
});

test("only scope-too-large falls back to one complete review per task", async () => {
  const calls: string[][] = [];
  const step: AdvanceStep = async (_cwd, args) => {
    calls.push([...args]);
    return calls.length === 1
      ? { code: "REVIEW_NOT_RUN", status: "error", data: { result: { status: "NOT_RUN", reason: "scope-too-large" } } }
      : pass;
  };
  assert.equal(await reviewFinalTree(step, "/candidate", "parent", ["parent", "child-a", "child-b"], "base"), "per-task-fallback");
  assert.deepEqual(calls.slice(1).map((args) => args[2]), ["parent", "child-a", "child-b"]);
  assert.equal(calls.slice(1).every((args) => !args.includes("--tree")), true);
});

test("a substantive FAIL or other NOT_RUN stops without fallback", async () => {
  for (const result of [
    { code: "REVIEW_FAILED", status: "error" as const, data: { result: { status: "FAIL" } } },
    { code: "REVIEW_NOT_RUN", status: "error" as const, data: { result: { status: "NOT_RUN", reason: "host-required" } } }
  ]) {
    let calls = 0;
    await assert.rejects(reviewFinalTree(async () => { calls += 1; return result; },
      "/candidate", "parent", ["parent", "child"], "base"),
    (failure: unknown) => failure instanceof AgentOpsError && failure.code === result.code);
    assert.equal(calls, 1);
  }
});

test("a failed final review surfaces its finding and names the missing second round", async () => {
  const report = reportFor([{ id: "parent:behavior" }], "FAIL");
  const failed = { code: "REVIEW_FAILED", status: "error" as const,
    data: { result: { status: "FAIL", harness: "agy", report,
      attempts: [{ target: "agy", status: "FAIL" }] } } };
  await assert.rejects(reviewFinalTree(async () => failed, "/candidate", "parent", ["parent"], "base"),
    (error: unknown) => error instanceof AgentOpsError &&
      error.message.includes("Criterion failed") && error.message.includes("Round 2 — adversarial") &&
      error.message.includes("NOT_RUN"));
});

test("finish summary keeps concrete nonblocking findings and residual risks from both rounds", () => {
  const first = reportFor([{ id: "behavior" }]);
  const finding = { severity: "minor" as const, blocking: false, title: "Check logs",
    details: "Inspect rollout logs.", locations: [], evidence: ["reviewed source"],
    recommendation: "Watch the rollout.", criterionIds: [] };
  const summary = renderReviewHighlights([{ taskId: "parent", title: "Parent", artifact: {
    report: { ...first, findings: [finding] },
    adversarial: { target: "agy", report: { ...first, residualRisks: ["Rare concurrent update."] } }
  } }]);
  assert.match(summary, /Check logs: Inspect rollout logs/);
  assert.match(summary, /Risk: Rare concurrent update/);
});
