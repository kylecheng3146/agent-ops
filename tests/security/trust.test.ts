import assert from "node:assert/strict";
import {
  lstat,
  mkdtemp,
  mkdir,
  rm
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  calculateTrustBinding,
  FileTrustStore,
  normalizeRemoteIdentity
} from "../../runtime/src/security/trust.js";
import { localStatePaths } from "../../runtime/src/security/permissions.js";

const CONFIG_HASH = "a".repeat(64);
const RUNTIME_HASH = "b".repeat(64);

test("default local state stays under the injected user home", () => {
  const paths = localStatePaths(join("/user-home"));
  assert.equal(paths.trustStore, join(paths.root, "trust.json"));
  assert.equal(paths.logDirectory, join(paths.root, "logs"));
  assert.equal(paths.failureDirectory, join(paths.root, "failures"));
});

test("does not conflate case-sensitive remotes or Windows local paths", () => {
  assert.notEqual(
    normalizeRemoteIdentity("ssh://git@example.com/Owner/Repository.git"),
    normalizeRemoteIdentity("ssh://git@example.com/owner/repository.git")
  );
  assert.match(
    normalizeRemoteIdentity("C:\\Repositories\\Agent-Ops.git"),
    /^local:/
  );
});

test("normalizes remote identity and invalidates every bound field", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-trust-"));
  try {
    const firstRepo = join(root, "first");
    const movedRepo = join(root, "moved");
    await mkdir(firstRepo);
    await mkdir(movedRepo);
    const first = await calculateTrustBinding({
      repositoryPath: firstRepo,
      remoteUrl: "git@GitHub.com:KyleCheng3146/Agent-Ops.git",
      configHash: CONFIG_HASH,
      runtimeHash: RUNTIME_HASH
    });
    const equivalent = await calculateTrustBinding({
      repositoryPath: firstRepo,
      remoteUrl: "https://github.com/kylecheng3146/agent-ops.git",
      configHash: CONFIG_HASH,
      runtimeHash: RUNTIME_HASH
    });
    assert.equal(first.remoteIdentity, equivalent.remoteIdentity);

    const storePath = join(root, "state", "trust.json");
    const store = new FileTrustStore(storePath);
    await store.grant(first, "2026-07-23T00:00:00Z");
    assert.equal((await store.status(first)).status, "TRUSTED");

    const moved = await calculateTrustBinding({
      repositoryPath: movedRepo,
      remoteUrl: "https://github.com/kylecheng3146/agent-ops",
      configHash: CONFIG_HASH,
      runtimeHash: RUNTIME_HASH
    });
    assert.deepEqual((await store.status(moved)).mismatchedFields, [
      "canonicalPath"
    ]);

    const changedConfig = { ...first, configHash: "c".repeat(64) };
    assert.deepEqual(
      (await store.status(changedConfig)).mismatchedFields,
      ["configHash"]
    );
    const changedRuntime = { ...first, runtimeHash: "d".repeat(64) };
    assert.deepEqual(
      (await store.status(changedRuntime)).mismatchedFields,
      ["runtimeHash"]
    );
    const changedRemote = {
      ...first,
      remoteIdentity: "example.com/owner/repository"
    };
    assert.deepEqual(
      (await store.status(changedRemote)).mismatchedFields,
      ["remoteIdentity"]
    );

    const unrelated = await calculateTrustBinding({
      repositoryPath: movedRepo,
      remoteUrl: "https://example.com/unrelated/repository",
      configHash: CONFIG_HASH,
      runtimeHash: RUNTIME_HASH
    });
    assert.equal((await store.status(unrelated)).status, "UNTRUSTED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("revoke is exact, idempotent, and local state is owner-only", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-trust-"));
  try {
    const repositoryPath = join(root, "repository");
    await mkdir(repositoryPath);
    const binding = await calculateTrustBinding({
      repositoryPath,
      remoteUrl: "ssh://git@example.com/owner/repository.git",
      configHash: CONFIG_HASH,
      runtimeHash: RUNTIME_HASH
    });
    const stateDirectory = join(root, "private-state");
    const storePath = join(stateDirectory, "trust.json");
    const store = new FileTrustStore(storePath);
    await store.grant(binding, "2026-07-23T00:00:00Z");

    if (process.platform !== "win32") {
      assert.equal((await lstat(stateDirectory)).mode & 0o777, 0o700);
      assert.equal((await lstat(storePath)).mode & 0o777, 0o600);
    }
    assert.equal(await store.revoke(binding), true);
    assert.equal(await store.revoke(binding), false);
    assert.equal((await store.status(binding)).status, "UNTRUSTED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
