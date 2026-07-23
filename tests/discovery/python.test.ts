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

import { discoverPythonProject } from "../../runtime/src/discovery/python.js";
import type {
  DiscoveryResult,
  ProposalDiscoveryResult,
  UserDecisionDiscoveryResult
} from "../../runtime/src/discovery/types.js";

function fixturePath(name: string): string {
  return path.resolve("tests", "fixtures", "discovery", "python", name);
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

test("proposes pytest only from explicit pyproject evidence", async () => {
  const result = await discoverPythonProject(fixturePath("pytest"));

  assertProposalResult(result);
  assert.equal(result.manualConfigAllowed, true);
  assert.equal(result.proposals.length, 1);
  const proposal = result.proposals[0];
  assert.ok(proposal);
  assert.equal(proposal.command, "python");
  assert.deepEqual(proposal.args, ["-m", "pytest"]);
  assert.equal(proposal.confirmed, false);
  assert.equal(proposal.confidence, "high");
  assert.ok(
    proposal.sourceEvidence.some(
      (evidence) => evidence.path === "pyproject.toml"
    )
  );
});

test("pytest dependency text alone requires a user decision", async () => {
  const result = await discoverPythonProject(fixturePath("ambiguous"));

  assertUserDecision(result);
  assert.equal(result.reason, "no-known-commands");
  assert.equal(result.manualConfigAllowed, true);
  assert.equal("proposals" in result, false);
});

test("missing pyproject metadata is an explicit no-match", async () => {
  const result = await discoverPythonProject(fixturePath("missing"));

  assert.equal(result.kind, "no-match");
  assert.equal(result.reason, "not-python-project");
  assert.equal(result.manualConfigAllowed, true);
});

test("malformed pyproject metadata fails closed", async () => {
  const result = await discoverPythonProject(fixturePath("malformed"));

  assertUserDecision(result);
  assert.equal(result.reason, "invalid-manifest");
  assert.equal(result.manualConfigAllowed, true);
});

test("symlinked pyproject metadata is not followed", async (t) => {
  const root = await createTemporaryDirectory(t, "agent-ops-python-link-");
  const project = path.join(root, "project");
  await mkdir(project);

  if (process.platform === "win32") {
    const externalDirectory = path.join(root, "external");
    await mkdir(externalDirectory);
    await writeFile(
      path.join(externalDirectory, "pyproject.toml"),
      "[tool.pytest.ini_options]\n"
    );
    await symlink(
      externalDirectory,
      path.join(project, "pyproject.toml"),
      "junction"
    );
  } else {
    const externalFile = path.join(root, "external.toml");
    await writeFile(externalFile, "[tool.pytest.ini_options]\n");
    await symlink(
      externalFile,
      path.join(project, "pyproject.toml"),
      "file"
    );
  }

  const result = await discoverPythonProject(project);

  assertUserDecision(result);
  assert.equal(result.reason, "invalid-manifest");
  assert.match(result.message, /regular file/);
});

test("oversized pyproject metadata fails closed", async (t) => {
  const project = await createTemporaryDirectory(
    t,
    "agent-ops-python-large-"
  );
  await writeFile(
    path.join(project, "pyproject.toml"),
    Buffer.alloc(1024 * 1024 + 1, 0x61)
  );

  const result = await discoverPythonProject(project);

  assertUserDecision(result);
  assert.equal(result.reason, "invalid-manifest");
  assert.match(result.message, /size limit/);
});
