import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateReviewResults,
  type ReviewCriterionResult
} from "../../runtime/src/review/result.js";
import { buildReviewPacket } from "../../runtime/src/review/packet.js";
import { sha256 } from "../../runtime/src/fs/hash.js";
import { buildReviewPrompt, buildAdversarialPrompt, type ReviewInvocation } from "../../runtime/src/review/runner.js";
import { reportFor } from "./report-fixture.js";

test("builds an isolated packet without rationale, logs, or credentials", () => {
  const packet = buildReviewPacket({
    request: "Review the implementation.",
    criteria: [{ id: "tests", description: "Tests pass." }],
    artifactRefs: ["runtime/src/review/packet.ts"],
    evidenceRequirements: [{ criterionId: "tests", requirement: "test output" }],
    implementationRationale: "hidden rationale",
    rawLogs: "Authorization header omitted",
    credential: "credential-value"
  });

  assert.deepEqual(Object.keys(packet).sort(), [
    "artifactRefs",
    "criteria",
    "evidenceRequirements",
    "request"
  ]);
  assert.doesNotMatch(JSON.stringify(packet), /hidden rationale|Authorization|credential-value/);
});

test("a complete sealed manifest index avoids duplicate metadata without hiding snapshot artifacts", () => {
  const artifacts = Array.from({length: 500}, (_, i) => ({
    path: `.agent-ops/tasks/evidence/task-packet/node-test-${i.toString(16).padStart(16, "0")}.json`,
    content: "{}", digest: sha256("{}")
  }));
  const index = artifacts.map(({path, digest}) => ({path, digest}));
  const manifest = (content: string) => {
    const digest = sha256(content);
    return {content, digest, path: `.agent-ops/tasks/review-contracts/${digest}.json`};
  };
  const input = {request: "Review.", criteria: [{id: "tests", description: "Tests pass."}], artifactRefs: [],
    evidenceRequirements: [], contractArtifacts: artifacts};
  const contractManifest = manifest(JSON.stringify({artifacts: index}));
  const packet = buildReviewPacket({...input, contractManifest});
  assert.deepEqual(packet.contractArtifacts, artifacts);
  const invocation: ReviewInvocation = {harness: "codex", model: "configured-model", effort: "medium", packet};
  for (const prompt of [buildReviewPrompt(invocation), buildAdversarialPrompt(invocation, reportFor(packet.criteria))]) {
    const data = JSON.parse(prompt.split("BEGIN_TASK_DATA\n")[1]!.split("\n")[0]!);
    assert.equal(data.contractArtifacts, undefined);
    assert.deepEqual(data.contractManifest, {path: contractManifest.path, digest: contractManifest.digest});
    assert.match(prompt, /complete.*artifact.*index/s);
  }
  for (const content of ["not JSON", "{}", JSON.stringify({artifacts: index.slice(1)})]) {
    assert.throws(() => buildReviewPacket({...input, contractManifest: manifest(content)}), /64 KiB/);
  }
  assert.throws(() => buildReviewPacket(input), /64 KiB/);
  assert.throws(() => buildReviewPacket({...input, contractManifest,
    contractArtifacts: [{...artifacts[0]!, digest: "0".repeat(64)}]}), /artifact is invalid/);
  const legacy = buildReviewPacket({...input, contractArtifacts: artifacts.slice(0, 1), contractManifest: manifest("{}")});
  assert.ok(buildReviewPrompt({...invocation, packet: legacy}).includes(artifacts[0]!.path));
});

function result(
  criterionId: string,
  status: "PASS" | "FAIL",
  evidence = "evidence"
): ReviewCriterionResult {
  return { criterionId, status, evidence: [evidence] };
}

test("aggregates exactly one passing result per requested criterion", () => {
  const summary = aggregateReviewResults(
    ["tests", "scope"],
    [result("tests", "PASS"), result("scope", "PASS")]
  );
  assert.equal(summary.status, "PASS");
  assert.deepEqual(summary.results.map((item) => item.criterionId), [
    "tests",
    "scope"
  ]);
});

test("protocol violations are reported as invalid, not as a FAIL verdict", () => {
  for (const results of [
    [result("tests", "PASS")],
    [result("tests", "PASS"), result("tests", "PASS")],
    [result("tests", "PASS"), result("other", "PASS")],
    [{ criterionId: "tests", status: "PASS" as const, evidence: [] }]
  ]) {
    assert.equal(
      aggregateReviewResults(
        results.length === 1 && results[0]?.criterionId === "tests" &&
          results[0]?.evidence.length > 0
          ? ["tests", "scope"]
          : ["tests"],
        results
      ).valid,
      false
    );
  }
  assert.equal(
    aggregateReviewResults(
      ["tests"],
      [result("tests", "PASS", "   ")]
    ).valid,
    false
  );
  const failed = aggregateReviewResults(["tests"], [result("tests", "FAIL")]);
  assert.equal(failed.valid, true);
  assert.equal(failed.status, "FAIL");
});
