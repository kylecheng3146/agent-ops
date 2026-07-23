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

import { discoverRustProject } from "../../runtime/src/discovery/rust.js";
import type {
  DiscoveryResult,
  ProposalDiscoveryResult,
  UserDecisionDiscoveryResult
} from "../../runtime/src/discovery/types.js";

function fixturePath(name: string): string {
  return path.resolve("tests", "fixtures", "discovery", "rust", name);
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

test("proposes cargo test from package or workspace evidence", async (t) => {
  for (const fixture of ["package", "workspace"]) {
    await t.test(fixture, async () => {
      const result = await discoverRustProject(fixturePath(fixture));

      assertProposalResult(result);
      assert.equal(result.manualConfigAllowed, true);
      assert.equal(result.proposals.length, 1);
      const proposal = result.proposals[0];
      assert.ok(proposal);
      assert.equal(proposal.command, "cargo");
      assert.deepEqual(proposal.args, ["test"]);
      assert.equal(proposal.confirmed, false);
      assert.equal(proposal.confidence, "high");
      assert.ok(
        proposal.sourceEvidence.some(
          (evidence) => evidence.path === "Cargo.toml"
        )
      );
    });
  }
});

test("Cargo metadata without package or workspace requires a decision", async () => {
  const result = await discoverRustProject(fixturePath("ambiguous"));

  assertUserDecision(result);
  assert.equal(result.reason, "no-known-commands");
  assert.equal(result.manualConfigAllowed, true);
});

test("missing Cargo metadata is an explicit no-match", async () => {
  const result = await discoverRustProject(fixturePath("missing"));

  assert.equal(result.kind, "no-match");
  assert.equal(result.reason, "not-rust-project");
  assert.equal(result.manualConfigAllowed, true);
});

test("malformed Cargo metadata fails closed", async () => {
  const result = await discoverRustProject(fixturePath("malformed"));

  assertUserDecision(result);
  assert.equal(result.reason, "invalid-manifest");
  assert.equal(result.manualConfigAllowed, true);
});

test("symlinked Cargo metadata is not followed", async (t) => {
  const root = await createTemporaryDirectory(t, "agent-ops-rust-link-");
  const project = path.join(root, "project");
  await mkdir(project);

  if (process.platform === "win32") {
    const externalDirectory = path.join(root, "external");
    await mkdir(externalDirectory);
    await writeFile(
      path.join(externalDirectory, "Cargo.toml"),
      "[package]\nname = \"external\"\nversion = \"0.0.0\"\n"
    );
    await symlink(
      externalDirectory,
      path.join(project, "Cargo.toml"),
      "junction"
    );
  } else {
    const externalFile = path.join(root, "external.toml");
    await writeFile(
      externalFile,
      "[package]\nname = \"external\"\nversion = \"0.0.0\"\n"
    );
    await symlink(
      externalFile,
      path.join(project, "Cargo.toml"),
      "file"
    );
  }

  const result = await discoverRustProject(project);

  assertUserDecision(result);
  assert.equal(result.reason, "invalid-manifest");
  assert.match(result.message, /regular file/);
});

test("oversized Cargo metadata fails closed", async (t) => {
  const project = await createTemporaryDirectory(t, "agent-ops-rust-large-");
  await writeFile(
    path.join(project, "Cargo.toml"),
    Buffer.alloc(1024 * 1024 + 1, 0x61)
  );

  const result = await discoverRustProject(project);

  assertUserDecision(result);
  assert.equal(result.reason, "invalid-manifest");
  assert.match(result.message, /size limit/);
});
