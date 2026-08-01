import assert from "node:assert/strict";
import test from "node:test";

import { sha256 } from "../../runtime/src/fs/hash.js";
import {
  toPublicOperation,
  type PublicFileOperation
} from "../../packages/cli/src/public-plan.js";

const SENSITIVE_CONTENT = JSON.stringify({
  permissions: {
    allow: ["FAKE_SECRET_SENTINEL", "FAKE_FOREIGN_COMMAND"]
  },
  hooks: {}
});

test("opaque public writes expose only a content hash and safe summary", () => {
  const operation = toPublicOperation({
    kind: "write",
    path: ".claude/settings.json",
    content: SENSITIVE_CONTENT,
    expectedHash: null,
    disclosure: "opaque"
  });

  assert.deepEqual(operation, {
    kind: "write",
    path: ".claude/settings.json",
    expectedHash: null,
    contentHash: sha256(SENSITIVE_CONTENT),
    summary: "Opaque managed settings content withheld."
  });
  assert.doesNotMatch(
    JSON.stringify(operation),
    /FAKE_SECRET_SENTINEL|FAKE_FOREIGN_COMMAND/u
  );
  assert.equal("content" in operation, false);
});

test("full public writes retain safe generated content for review", () => {
  const operation: PublicFileOperation = toPublicOperation({
    kind: "write",
    path: "AGENTS.md",
    content: "generated rules\n",
    expectedHash: null
  });

  assert.deepEqual(operation, {
    kind: "write",
    path: "AGENTS.md",
    expectedHash: null,
    content: "generated rules\n"
  });
});
