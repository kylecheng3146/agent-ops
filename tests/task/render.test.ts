import assert from "node:assert/strict";
import test from "node:test";

import type { AcceptanceCriterion } from "../../runtime/src/contracts.js";
import { renderTaskMarkdown } from "../../runtime/src/task/render.js";
import type { StoredTaskRecord } from "../../runtime/src/task/store.js";

const sha = "a".repeat(40);
const reviewOnly: AcceptanceCriterion = {id: "judgment", description: "Meets the goal", verifierIds: [], acceptance: {
  mode: "review-only", baselineCommit: sha, bindings: [], reviewOnlyReason: "Needs independent judgment."}};
const named: AcceptanceCriterion = {...reviewOnly, id: "named", verifierIds: ["unit"]};
const gate: AcceptanceCriterion = {id: "gates", description: "Lint and types pass", verifierIds: ["lint", "types"]};
const plain: AcceptanceCriterion = {id: "plain", description: "Behaves", verifierIds: ["unit"]};

function render(criteria: AcceptanceCriterion[]): string {
  const record = {task: {schemaVersion: 2, id: "task-render", title: "Render", criteria}, status: "active",
    createdAt: "2026-11-02T00:00:00.000Z", updatedAt: "2026-11-02T00:00:00.000Z", completedAt: null, archivedAt: null,
    evidence: {}} as unknown as StoredTaskRecord;
  return renderTaskMarkdown(record);
}

test("typed acceptance shows every required verifier; untyped criteria list exactly what they name", () => {
  const text = render([reviewOnly, named, gate]);
  assert.match(text, /\(`judgment`\)\n {2}- Verifiers: every required verifier \(typed acceptance\)\n/);
  assert.match(text, /\(`named`\)\n {2}- Verifiers: every required verifier \(typed acceptance\); named: `unit`\n/);
  assert.match(text, /\(`gates`\)\n {2}- Verifiers: `lint`, `types`\n/);
  assert.doesNotMatch(text, /Verifiers: *\n/);
});

test("only a mixed task flags its untyped criteria as adding no verifier evidence", () => {
  const mixed = render([reviewOnly, gate]);
  assert.match(mixed, /\(`gates`\)\n.*\n {2}- Notice: adds no verifier evidence; every required verifier already applies/);
  assert.equal(mixed.match(/Notice:/g)?.length, 1);
  assert.doesNotMatch(render([plain, gate]), /Notice:/);
  assert.doesNotMatch(render([reviewOnly, named]), /Notice:/);
});
