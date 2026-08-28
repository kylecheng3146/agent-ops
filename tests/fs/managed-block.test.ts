import assert from "node:assert/strict";
import test from "node:test";

import {
  applyManagedBlock,
  managedBlockMarkers,
  removeManagedBlock
} from "../../runtime/src/fs/managed-block.js";
import { AgentOpsError } from "../../runtime/src/fs/paths.js";

test("creates, updates, and removes a managed block idempotently", () => {
  const options = {
    id: "core-routing",
    version: 1,
    content: "Read .agent-ops/rules.md."
  } as const;
  const created = applyManagedBlock("# Existing\n", options);

  assert.equal(
    created,
    [
      "# Existing",
      "",
      "<!-- agent-ops:start core-routing v1 -->",
      "Read .agent-ops/rules.md.",
      "<!-- agent-ops:end core-routing -->",
      ""
    ].join("\n")
  );
  assert.equal(applyManagedBlock(created, options), created);

  const updated = applyManagedBlock(created, {
    ...options,
    content: "Read .agent-ops/loop.md."
  });
  assert.match(updated, /Read \.agent-ops\/loop\.md\./);
  assert.doesNotMatch(updated, /rules\.md/);

  assert.equal(removeManagedBlock(updated, options.id), "# Existing\n");
  assert.equal(
    removeManagedBlock("# Existing\n", options.id),
    "# Existing\n"
  );
});

test("renders a hash-comment block for gitignore-compatible ownership", () => {
  const options = {
    id: "loop-state",
    version: 1,
    content: ".codex/loop-state.md\n.codex/loop-telemetry.jsonl",
    markerStyle: "hash"
  } as never;
  const created = applyManagedBlock("# Existing\n", options);

  assert.equal(
    created,
    [
      "# Existing",
      "",
      "# agent-ops:start loop-state v1",
      ".codex/loop-state.md",
      ".codex/loop-telemetry.jsonl",
      "# agent-ops:end loop-state",
      ""
    ].join("\n")
  );
});

test("rejects missing, duplicate, reversed, and wrong-version markers", () => {
  const { start, end } = managedBlockMarkers("core-routing", 1);
  const malformed = [
    `${start}\nbody\n`,
    `${start}\n${start}\nbody\n${end}\n`,
    `${end}\nbody\n${start}\n`,
    "<!-- agent-ops:start core-routing v2 -->\nbody\n<!-- agent-ops:end core-routing -->\n",
    "<!--  agent-ops:start core-routing v1 -->\nbody\n<!--  agent-ops:end core-routing -->\n",
    "<!-- agent-ops:start core-routing vx -->\nbody\n<!-- agent-ops:end core-routing -->\n"
  ];

  for (const source of malformed) {
    assert.throws(
      () =>
        applyManagedBlock(source, {
          id: "core-routing",
          version: 1,
          content: "replacement"
        }),
      (error: unknown) =>
        error instanceof AgentOpsError &&
        error.code === "MALFORMED_MANAGED_BLOCK",
      source
    );
  }
});

test("preserves CRLF line endings across create, update, and removal", () => {
  const options = {
    id: "core-routing",
    version: 1,
    content: "Read .agent-ops/rules.md."
  } as const;
  const crlfBase = "# Existing\r\n";
  const created = applyManagedBlock(crlfBase, options);

  assert.equal(
    created,
    [
      "# Existing",
      "",
      "<!-- agent-ops:start core-routing v1 -->",
      "Read .agent-ops/rules.md.",
      "<!-- agent-ops:end core-routing -->",
      ""
    ].join("\r\n")
  );
  assert.doesNotMatch(created, /[^\r]\n/);
  assert.equal(applyManagedBlock(created, options), created);

  const updated = applyManagedBlock(created, {
    ...options,
    content: "Read .agent-ops/loop.md."
  });
  assert.match(updated, /Read \.agent-ops\/loop\.md\.\r\n/);
  assert.doesNotMatch(updated, /[^\r]\n/);

  assert.equal(removeManagedBlock(updated, options.id), crlfBase);
});

test("leaves unrelated LF lines untouched in a mixed-ending file", () => {
  const options = {
    id: "core-routing",
    version: 1,
    content: "Read .agent-ops/rules.md."
  } as const;
  const mixedBase = "line one\r\nline two\nline three\r\n";
  const created = applyManagedBlock(mixedBase, options);

  assert.match(created, /^line one\r\nline two\nline three\r\n/);
  assert.equal(removeManagedBlock(created, options.id), mixedBase);
});

test("removes an LF-delimited block cleanly even when CRLF appears elsewhere", () => {
  const { start, end } = managedBlockMarkers("core-routing", 1);
  const blockOnly = `${start}\nbody\r\ninside\n${end}\n`;

  assert.equal(removeManagedBlock(blockOnly, "core-routing"), "");

  const surrounded = `before\r\n\n${start}\nbody\r\ninside\n${end}\n\nafter\r\n`;
  assert.equal(
    removeManagedBlock(surrounded, "core-routing"),
    "before\r\n\nafter\r\n"
  );
});

test("rejects managed content that could create ambiguous markers", () => {
  assert.throws(
    () =>
      applyManagedBlock("", {
        id: "core-routing",
        version: 1,
        content: "<!-- agent-ops:end core-routing -->"
      }),
    (error: unknown) =>
      error instanceof AgentOpsError &&
      error.code === "AMBIGUOUS_MANAGED_CONTENT"
  );
});
