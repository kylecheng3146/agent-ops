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

import { discoverGoProject } from "../../runtime/src/discovery/go.js";
import type {
  DiscoveryResult,
  ProposalDiscoveryResult,
  UserDecisionDiscoveryResult
} from "../../runtime/src/discovery/types.js";

function fixturePath(name: string): string {
  return path.resolve("tests", "fixtures", "discovery", "go", name);
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

test("proposes the standard Go test command from a regular go.mod", async () => {
  const result = await discoverGoProject(fixturePath("module"));

  assertProposalResult(result);
  assert.equal(result.manualConfigAllowed, true);
  assert.equal(result.proposals.length, 1);
  const proposal = result.proposals[0];
  assert.ok(proposal);
  assert.equal(proposal.command, "go");
  assert.deepEqual(proposal.args, ["test", "./..."]);
  assert.equal(proposal.confirmed, false);
  assert.equal(proposal.confidence, "high");
  assert.ok(
    proposal.sourceEvidence.some(
      (evidence) => evidence.path === "go.mod"
    )
  );
});

test("missing go.mod metadata is an explicit no-match", async () => {
  const result = await discoverGoProject(fixturePath("missing"));

  assert.equal(result.kind, "no-match");
  assert.equal(result.reason, "not-go-project");
  assert.equal(result.manualConfigAllowed, true);
});

test("malformed go.mod metadata fails closed", async () => {
  const result = await discoverGoProject(fixturePath("malformed"));

  assertUserDecision(result);
  assert.equal(result.reason, "invalid-manifest");
  assert.equal(result.manualConfigAllowed, true);
});

test("symlinked go.mod metadata is not followed", async (t) => {
  const root = await createTemporaryDirectory(t, "agent-ops-go-link-");
  const project = path.join(root, "project");
  await mkdir(project);

  if (process.platform === "win32") {
    const externalDirectory = path.join(root, "external");
    await mkdir(externalDirectory);
    await writeFile(
      path.join(externalDirectory, "go.mod"),
      "module example.com/external\n"
    );
    await symlink(
      externalDirectory,
      path.join(project, "go.mod"),
      "junction"
    );
  } else {
    const externalFile = path.join(root, "external.mod");
    await writeFile(externalFile, "module example.com/external\n");
    await symlink(externalFile, path.join(project, "go.mod"), "file");
  }

  const result = await discoverGoProject(project);

  assertUserDecision(result);
  assert.equal(result.reason, "invalid-manifest");
  assert.match(result.message, /regular file/);
});

test("oversized go.mod metadata fails closed", async (t) => {
  const project = await createTemporaryDirectory(t, "agent-ops-go-large-");
  await writeFile(
    path.join(project, "go.mod"),
    Buffer.alloc(1024 * 1024 + 1, 0x61)
  );

  const result = await discoverGoProject(project);

  assertUserDecision(result);
  assert.equal(result.reason, "invalid-manifest");
  assert.match(result.message, /size limit/);
});
