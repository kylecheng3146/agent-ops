import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import {
  calculateTrustBinding,
  FileTrustStore,
  normalizeRemoteIdentity,
  type TrustBinding
} from "../../runtime/src/security/trust.js";
import { calculateConfigHash } from "../../runtime/src/config/hash.js";
import type { AgentOpsConfig } from "../../runtime/src/contracts.js";
import { localStatePaths } from "../../runtime/src/security/permissions.js";
import { sha256 } from "../../runtime/src/fs/hash.js";
import { previewConfigMigration } from "../../runtime/src/config/migrate.js";

const CONFIG_HASH = "a".repeat(64);
const RUNTIME_HASH = "b".repeat(64);

test("trust config bindings use canonical property-order-independent hashes", () => {
  const first: AgentOpsConfig = {
    schemaVersion: 2,
    profiles: ["core"],
    verification: { commands: [] },
    features: { stopVerification: { enabled: false } },
    pathMappings: [],
    securityExceptions: []
  };
  const reordered: AgentOpsConfig = {
    securityExceptions: [],
    pathMappings: [],
    features: { stopVerification: { enabled: false } },
    verification: { commands: [] },
    profiles: ["core"],
    schemaVersion: 2
  };
  assert.equal(calculateConfigHash(first), calculateConfigHash(reordered));
});

test("config migration makes an old trust binding stale until re-granted", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-trust-migration-"));
  try {
    const legacy = {
      schemaVersion: 1,
      profiles: ["core"],
      verification: { commands: [] },
      pathMappings: [],
      securityExceptions: []
    };
    const migrated = previewConfigMigration(legacy).migrated;
    const oldBinding = await calculateTrustBinding({
      repositoryPath: root,
      remoteUrl: `local:${root}`,
      configHash: sha256(JSON.stringify(legacy)),
      runtimeHash: RUNTIME_HASH
    });
    const state = localStatePaths(root);
    const store = new FileTrustStore(state.trustStore, state.anchorDirectory);
    await store.grant(oldBinding, "2026-07-23T00:00:00Z");

    const migratedBinding = await calculateTrustBinding({
      repositoryPath: root,
      remoteUrl: `local:${root}`,
      configHash: calculateConfigHash(migrated),
      runtimeHash: RUNTIME_HASH
    });
    assert.equal((await store.status(migratedBinding)).status, "STALE");
    await store.grant(migratedBinding, "2026-07-23T00:00:01Z");
    assert.equal((await store.status(migratedBinding)).status, "TRUSTED");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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

test("status repairs loose private-state permissions", { skip: process.platform === "win32" }, async () => {
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
    await chmod(stateDirectory, 0o755);
    await chmod(storePath, 0o644);

    assert.equal((await store.status(binding)).status, "TRUSTED");
    assert.equal((await lstat(stateDirectory)).mode & 0o777, 0o700);
    assert.equal((await lstat(storePath)).mode & 0o777, 0o600);
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

test("serializes a large burst of trust mutations without loss", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-trust-"));
  try {
    const store = new FileTrustStore(
      join(root, "state", "trust.json"),
      root
    );
    const bindings: TrustBinding[] = Array.from(
      { length: 100 },
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
      join(
        stateDirectory,
        `.trust.json.agent-ops-lock-${exitedProcessId}-abandoned-lock-token`
      ),
      `${JSON.stringify({
        choosing: false,
        heartbeatFile:
          `.agent-ops-process-${exitedProcessId}-00000000-0000-4000-8000-000000000000`,
        processId: exitedProcessId,
        processIdentity: "linux:1",
        createdAt: "2000-01-01T00:00:00Z",
        ticket: 1,
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
    await assert.rejects(
      lstat(
        join(
          stateDirectory,
          `.trust.json.agent-ops-lock-${exitedProcessId}-abandoned-lock-token`
        )
      )
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("distinguishes a reused PID from the current process instance", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-trust-"));
  try {
    const stateDirectory = join(root, "state");
    const storePath = join(stateDirectory, "trust.json");
    const previousIdentity =
      "runtime:00000000-0000-4000-8000-000000000000";
    const stalePath = join(
      stateDirectory,
      `.trust.json.agent-ops-lock-${process.pid}-previous-instance`
    );
    await mkdir(stateDirectory);
    await writeFile(
      stalePath,
      `${JSON.stringify({
        choosing: false,
        createdAt: "2000-01-01T00:00:00Z",
        heartbeatFile:
          `.agent-ops-process-${process.pid}-${previousIdentity.slice(8)}`,
        processId: process.pid,
        processIdentity: previousIdentity,
        ticket: 1,
        token: "previous-instance"
      })}\n`
    );
    const store = new FileTrustStore(storePath, root);
    const binding: TrustBinding = {
      canonicalPath: join(root, "repository"),
      remoteIdentity: "example.com/owner/reused-pid",
      configHash: CONFIG_HASH,
      runtimeHash: RUNTIME_HASH
    };

    await store.grant(binding);

    assert.equal((await store.status(binding)).status, "TRUSTED");
    await assert.rejects(lstat(stalePath));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not trust a live foreign PID without its heartbeat", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-trust-"));
  const unrelatedProcess = spawn(
    process.execPath,
    ["-e", "setInterval(() => undefined, 1000)"],
    { stdio: "ignore" }
  );
  try {
    const unrelatedProcessId = unrelatedProcess.pid;
    if (unrelatedProcessId === undefined) {
      throw new Error("Expected the child process to have a PID.");
    }
    const stateDirectory = join(root, "state");
    const storePath = join(stateDirectory, "trust.json");
    const foreignIdentity =
      "runtime:00000000-0000-4000-8000-000000000000";
    const stalePath = join(
      stateDirectory,
      `.trust.json.agent-ops-lock-${unrelatedProcessId}-foreign-instance`
    );
    await mkdir(stateDirectory);
    await writeFile(
      stalePath,
      `${JSON.stringify({
        choosing: false,
        createdAt: new Date().toISOString(),
        heartbeatFile:
          `.agent-ops-process-${unrelatedProcessId}-${foreignIdentity.slice(8)}`,
        processId: unrelatedProcessId,
        processIdentity: foreignIdentity,
        ticket: 1,
        token: "foreign-instance"
      })}\n`
    );
    const store = new FileTrustStore(storePath, root);
    const binding: TrustBinding = {
      canonicalPath: join(root, "repository"),
      remoteIdentity: "example.com/owner/foreign-pid",
      configHash: CONFIG_HASH,
      runtimeHash: RUNTIME_HASH
    };

    await store.grant(binding);

    assert.equal((await store.status(binding)).status, "TRUSTED");
    await assert.rejects(lstat(stalePath));
  } finally {
    unrelatedProcess.kill();
    await new Promise<void>((resolve) => {
      unrelatedProcess.once("exit", () => resolve());
    });
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "does not follow a swapped heartbeat symlink",
  { skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-ops-trust-"));
    const externalRoot = await mkdtemp(
      join(tmpdir(), "agent-ops-external-")
    );
    try {
      const stateDirectory = join(root, "state");
      const store = new FileTrustStore(
        join(stateDirectory, "trust.json"),
        root
      );
      const firstBinding: TrustBinding = {
        canonicalPath: join(root, "repository-first"),
        remoteIdentity: "example.com/owner/heartbeat-first",
        configHash: CONFIG_HASH,
        runtimeHash: RUNTIME_HASH
      };
      await store.grant(firstBinding);
      const heartbeatFile = (await readdir(stateDirectory)).find(
        (name) => name.startsWith(
          `.agent-ops-process-${process.pid}-`
        )
      );
      assert.notEqual(heartbeatFile, undefined);
      if (heartbeatFile === undefined) {
        return;
      }

      const externalPath = join(externalRoot, "external.txt");
      const oldTimestamp = new Date("2000-01-01T00:00:00Z");
      await writeFile(externalPath, "external\n");
      await utimes(externalPath, oldTimestamp, oldTimestamp);
      await rm(join(stateDirectory, heartbeatFile));
      await symlink(
        externalPath,
        join(stateDirectory, heartbeatFile),
        "file"
      );
      await delay(750);

      assert.equal(
        (await lstat(externalPath)).mtimeMs,
        oldTimestamp.getTime()
      );
      await assert.rejects(
        store.grant({
          ...firstBinding,
          canonicalPath: join(root, "repository-second"),
          remoteIdentity: "example.com/owner/heartbeat-second"
        }),
        (error: unknown) =>
          error instanceof Error &&
          "code" in error &&
          error.code === "PRIVATE_STATE_LOCK_IDENTITY_UNAVAILABLE"
      );
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(externalRoot, { recursive: true, force: true });
    }
  }
);

test("recovers a future-dated malformed orphan ticket", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-trust-"));
  try {
    const stateDirectory = join(root, "state");
    const storePath = join(stateDirectory, "trust.json");
    const malformedPath = join(
      stateDirectory,
      ".trust.json.agent-ops-lock-999999-malformed"
    );
    await mkdir(stateDirectory);
    await writeFile(malformedPath, "not-json");
    await utimes(
      malformedPath,
      new Date("2100-01-01T00:00:00Z"),
      new Date("2100-01-01T00:00:00Z")
    );
    const store = new FileTrustStore(storePath, root);
    const binding: TrustBinding = {
      canonicalPath: join(root, "repository"),
      remoteIdentity: "example.com/owner/malformed-lock",
      configHash: CONFIG_HASH,
      runtimeHash: RUNTIME_HASH
    };

    await store.grant(binding);

    assert.equal((await store.status(binding)).status, "TRUSTED");
    await assert.rejects(lstat(malformedPath));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
