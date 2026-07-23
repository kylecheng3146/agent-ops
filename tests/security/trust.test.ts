import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  lstat,
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  symlink
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  calculateTrustBinding,
  FileTrustStore,
  normalizeRemoteIdentity,
  type TrustBinding
} from "../../runtime/src/security/trust.js";
import { localStatePaths } from "../../runtime/src/security/permissions.js";

const CONFIG_HASH = "a".repeat(64);
const RUNTIME_HASH = "b".repeat(64);

test("default local state stays under the injected user home", () => {
  const paths = localStatePaths(join("/user-home"));
  assert.equal(paths.anchorDirectory, join("/user-home"));
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
    const store = new FileTrustStore(storePath, root);
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
    const store = new FileTrustStore(storePath, root);
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

test(
  "rejects a symlinked local-state ancestor",
  { skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-ops-trust-"));
    try {
      const home = join(root, "home");
      const redirected = join(root, "redirected");
      const repositoryPath = join(root, "repository");
      await mkdir(home);
      await mkdir(redirected);
      await mkdir(repositoryPath);
      await symlink(redirected, join(home, ".agent-ops"), "dir");
      const paths = localStatePaths(home);
      const store = new FileTrustStore(
        paths.trustStore,
        paths.anchorDirectory
      );
      const binding = await calculateTrustBinding({
        repositoryPath,
        remoteUrl: "ssh://git@example.com/owner/repository.git",
        configHash: CONFIG_HASH,
        runtimeHash: RUNTIME_HASH
      });

      await assert.rejects(
        store.grant(binding),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "PRIVATE_STATE_PATH_INVALID"
      );
      await assert.rejects(lstat(join(redirected, "state", "trust.json")));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
);

test("serializes concurrent trust mutations without losing grants", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-trust-"));
  try {
    const store = new FileTrustStore(
      join(root, "state", "trust.json"),
      root
    );
    const bindings: TrustBinding[] = Array.from(
      { length: 12 },
      (_, index) => ({
        canonicalPath: join(root, `repository-${index}`),
        remoteIdentity: `example.com/owner/repository-${index}`,
        configHash: CONFIG_HASH,
        runtimeHash: RUNTIME_HASH
      })
    );

    await Promise.all(bindings.map((binding) => store.grant(binding)));

    for (const binding of bindings) {
      assert.equal((await store.status(binding)).status, "TRUSTED");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recovers an abandoned trust-store lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-trust-"));
  try {
    const exitedProcess = spawn(process.execPath, ["-e", ""], {
      stdio: "ignore"
    });
    const exitedProcessId = exitedProcess.pid;
    if (exitedProcessId === undefined) {
      throw new Error("Expected the child process to have a PID.");
    }
    await new Promise<void>((resolve, reject) => {
      exitedProcess.once("error", reject);
      exitedProcess.once("exit", () => resolve());
    });
    const stateDirectory = join(root, "state");
    const storePath = join(stateDirectory, "trust.json");
    await mkdir(stateDirectory);
    await writeFile(
      `${storePath}.lock`,
      `${JSON.stringify({
        processId: exitedProcessId,
        createdAt: "2000-01-01T00:00:00Z",
        token: "abandoned-lock-token"
      })}\n`
    );
    const store = new FileTrustStore(storePath, root);
    const binding: TrustBinding = {
      canonicalPath: join(root, "repository"),
      remoteIdentity: "example.com/owner/repository",
      configHash: CONFIG_HASH,
      runtimeHash: RUNTIME_HASH
    };

    await store.grant(binding);

    assert.equal((await store.status(binding)).status, "TRUSTED");
    await assert.rejects(lstat(`${storePath}.lock`));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
