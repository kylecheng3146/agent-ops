import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { discoverMakeProject } from "../../runtime/src/discovery/make.js";
import type {
  DiscoveryResult,
  ProposalDiscoveryResult,
  UserDecisionDiscoveryResult
} from "../../runtime/src/discovery/types.js";

function fixturePath(name: string): string {
  return path.resolve("tests", "fixtures", "discovery", "make", name);
}

function assertProposalResult(
  result: DiscoveryResult
): asserts result is ProposalDiscoveryResult {
  assert.equal(result.kind, "proposals");
}

function assertUserDecision(
  result: DiscoveryResult
): asserts result is UserDecisionDiscoveryResult {
  assert.equal(result.kind, "user-decision");
}

async function createTemporaryDirectory(
  t: test.TestContext,
  prefix: string
): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(directory, { force: true, recursive: true }));
  return directory;
}

test("prefers a literal test target over check", async () => {
  const result = await discoverMakeProject(fixturePath("test"));

  assertProposalResult(result);
  assert.equal(result.manualConfigAllowed, true);
  assert.equal(result.proposals.length, 1);
  const proposal = result.proposals[0];
  assert.ok(proposal);
  assert.equal(proposal.command, "make");
  assert.deepEqual(proposal.args, ["test"]);
  assert.equal(proposal.confirmed, false);
  assert.equal(proposal.confidence, "high");
  assert.ok(
    proposal.sourceEvidence.some(
      (evidence) => evidence.path === "Makefile#target:test"
    )
  );
});

test("uses a literal check target only when test is absent", async () => {
  const result = await discoverMakeProject(fixturePath("check"));

  assertProposalResult(result);
  const proposal = result.proposals[0];
  assert.ok(proposal);
  assert.equal(proposal.command, "make");
  assert.deepEqual(proposal.args, ["check"]);
  assert.deepEqual(proposal.evidence, { kind: "exit-code" });
  assert.equal(proposal.confidence, "medium");
  assert.equal(proposal.confirmed, false);
});

test("Makefiles without explicit verification targets require a decision", async () => {
  const result = await discoverMakeProject(fixturePath("no-target"));

  assertUserDecision(result);
  assert.equal(result.reason, "no-known-commands");
  assert.equal(result.manualConfigAllowed, true);
});

test("missing Makefile metadata is an explicit no-match", async () => {
  const result = await discoverMakeProject(fixturePath("missing"));

  assert.equal(result.kind, "no-match");
  assert.equal(result.reason, "not-make-project");
  assert.equal(result.manualConfigAllowed, true);
});

test("malformed Makefile metadata fails closed", async (t) => {
  const project = await createTemporaryDirectory(
    t,
    "agent-ops-make-malformed-"
  );
  await writeFile(
    path.join(project, "Makefile"),
    Buffer.from("test:\0\n")
  );

  const result = await discoverMakeProject(project);

  assertUserDecision(result);
  assert.equal(result.reason, "invalid-manifest");
  assert.equal(result.manualConfigAllowed, true);
});

test("symlinked Makefile metadata is not followed", async (t) => {
  const root = await createTemporaryDirectory(t, "agent-ops-make-link-");
  const project = path.join(root, "project");
  await mkdir(project);

  if (process.platform === "win32") {
    const externalDirectory = path.join(root, "external");
    await mkdir(externalDirectory);
    await writeFile(path.join(externalDirectory, "Makefile"), "test:\n");
    await symlink(
      externalDirectory,
      path.join(project, "Makefile"),
      "junction"
    );
  } else {
    const externalFile = path.join(root, "ExternalMakefile");
    await writeFile(externalFile, "test:\n");
    await symlink(
      externalFile,
      path.join(project, "Makefile"),
      "file"
    );
  }

  const result = await discoverMakeProject(project);

  assertUserDecision(result);
  assert.equal(result.reason, "invalid-manifest");
  assert.match(result.message, /regular file/);
});

test("oversized Makefile metadata fails closed", async (t) => {
  const project = await createTemporaryDirectory(t, "agent-ops-make-large-");
  await writeFile(
    path.join(project, "Makefile"),
    Buffer.alloc(1024 * 1024 + 1, 0x61)
  );

  const result = await discoverMakeProject(project);

  assertUserDecision(result);
  assert.equal(result.reason, "invalid-manifest");
  assert.match(result.message, /size limit/);
});
