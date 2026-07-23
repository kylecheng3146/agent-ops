import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { InstallManifest } from "../../runtime/src/contracts.js";
import { sha256 } from "../../runtime/src/fs/hash.js";
import {
  formatInstallManifest,
  parseInstallManifest
} from "../../runtime/src/fs/manifest.js";
import { resolveContainedPath } from "../../runtime/src/fs/paths.js";
import {
  AgentOpsError,
  FileTransaction,
  type TransactionPlan
} from "../../runtime/src/fs/transaction.js";

async function withTempRoot(
  run: (root: string) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-fs-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("creates, updates, removes, and reapplies file plans", async () => {
  await withTempRoot(async (root) => {
    const transaction = new FileTransaction(root);
    const created = "created\n";

    await transaction.apply({
      operations: [
        {
          kind: "write",
          path: "nested/config.txt",
          content: created,
          expectedHash: null
        }
      ]
    });
    assert.equal(await readFile(join(root, "nested/config.txt"), "utf8"), created);

    const updatePlan: TransactionPlan = {
      operations: [
        {
          kind: "write",
          path: "nested/config.txt",
          content: "updated\n",
          expectedHash: sha256(created)
        }
      ]
    };
    await transaction.apply(updatePlan);
    assert.equal(
      await readFile(join(root, "nested/config.txt"), "utf8"),
      "updated\n"
    );

    await transaction.apply({
      operations: [
        {
          kind: "write",
          path: "nested/config.txt",
          content: "updated\n",
          expectedHash: sha256("updated\n")
        }
      ]
    });
    await transaction.apply({
      operations: [
        {
          kind: "remove",
          path: "nested/config.txt",
          expectedHash: sha256("updated\n")
        }
      ]
    });
    await assert.rejects(readFile(join(root, "nested/config.txt")));
  });
});

test("rejects traversal and symlink escapes", async (context) => {
  await withTempRoot(async (root) => {
    for (const unsafePath of [
      "../outside",
      "C:/outside",
      "nested\\outside",
      "src/NUL.txt",
      "src/file."
    ]) {
      await assert.rejects(
        resolveContainedPath(root, unsafePath),
        (error: unknown) =>
          error instanceof AgentOpsError && error.code === "PATH_OUTSIDE_ROOT",
        unsafePath
      );
    }

    const outside = await mkdtemp(join(tmpdir(), "agent-ops-outside-"));
    try {
      const link = join(root, "escape");
      try {
        await symlink(
          outside,
          link,
          process.platform === "win32" ? "junction" : "dir"
        );
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "EPERM"
        ) {
          context.skip("symlinks require elevated privileges");
          return;
        }
        throw error;
      }
      await assert.rejects(
        resolveContainedPath(root, "escape/file.txt"),
        (error: unknown) =>
          error instanceof AgentOpsError && error.code === "PATH_OUTSIDE_ROOT"
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("precondition mismatch preserves an external edit", async () => {
  await withTempRoot(async (root) => {
    const target = join(root, "config.txt");
    await writeFile(target, "original\n");
    const plan: TransactionPlan = {
      operations: [
        {
          kind: "write",
          path: "config.txt",
          content: "managed\n",
          expectedHash: sha256("original\n")
        }
      ]
    };
    await writeFile(target, "externally edited\n");

    await assert.rejects(
      new FileTransaction(root).apply(plan),
      (error: unknown) =>
        error instanceof AgentOpsError &&
        error.code === "PRECONDITION_CHANGED"
    );
    assert.equal(await readFile(target, "utf8"), "externally edited\n");
  });
});

test("failure after one replacement rolls every file back", async () => {
  await withTempRoot(async (root) => {
    await writeFile(join(root, "a.txt"), "a-original\n");
    await writeFile(join(root, "b.txt"), "b-original\n");
    const transaction = new FileTransaction(root, {
      beforeReplace: ({ index }) => {
        if (index === 1) {
          throw new Error("simulated write failure");
        }
      }
    });

    await assert.rejects(
      transaction.apply({
        operations: [
          {
            kind: "write",
            path: "a.txt",
            content: "a-new\n",
            expectedHash: sha256("a-original\n")
          },
          {
            kind: "write",
            path: "b.txt",
            content: "b-new\n",
            expectedHash: sha256("b-original\n")
          }
        ]
      }),
      (error: unknown) =>
        error instanceof AgentOpsError && error.code === "TRANSACTION_FAILED"
    );
    assert.equal(await readFile(join(root, "a.txt"), "utf8"), "a-original\n");
    assert.equal(await readFile(join(root, "b.txt"), "utf8"), "b-original\n");
  });
});

test("post-apply validation failure rolls changes back", async () => {
  await withTempRoot(async (root) => {
    await writeFile(join(root, "config.txt"), "original\n");
    await assert.rejects(
      new FileTransaction(root).apply(
        {
          operations: [
            {
              kind: "write",
              path: "config.txt",
              content: "new\n",
              expectedHash: sha256("original\n")
            }
          ]
        },
        async () => {
          throw new Error("doctor failed");
        }
      ),
      (error: unknown) =>
        error instanceof AgentOpsError && error.code === "TRANSACTION_FAILED"
    );
    assert.equal(await readFile(join(root, "config.txt"), "utf8"), "original\n");
  });
});

test("rechecks preconditions after the last injected boundary", async () => {
  await withTempRoot(async (root) => {
    const target = join(root, "config.txt");
    await writeFile(target, "original\n");
    const transaction = new FileTransaction(root, {
      beforeReplace: async () => {
        await writeFile(target, "external\n");
      }
    });

    await assert.rejects(
      transaction.apply({
        operations: [
          {
            kind: "write",
            path: "config.txt",
            content: "managed\n",
            expectedHash: sha256("original\n")
          }
        ]
      }),
      (error: unknown) =>
        error instanceof AgentOpsError &&
        error.code === "PRECONDITION_CHANGED"
    );
    assert.equal(await readFile(target, "utf8"), "external\n");
  });
});

test("rechecks containment after a parent directory symlink swap", async (context) => {
  await withTempRoot(async (root) => {
    const managed = join(root, "managed");
    const parked = join(root, "managed-parked");
    const outside = await mkdtemp(join(tmpdir(), "agent-ops-race-"));
    await mkdir(managed);
    await writeFile(join(managed, "config.txt"), "original\n");
    await writeFile(join(outside, "config.txt"), "outside\n");
    try {
      const probe = join(root, "symlink-probe");
      try {
        await symlink(
          outside,
          probe,
          process.platform === "win32" ? "junction" : "dir"
        );
        await rm(probe);
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "EPERM"
        ) {
          context.skip("symlinks require elevated privileges");
          return;
        }
        throw error;
      }
      const transaction = new FileTransaction(root, {
        beforeReplace: async () => {
          await rename(managed, parked);
          await symlink(
            outside,
            managed,
            process.platform === "win32" ? "junction" : "dir"
          );
        }
      });

      await assert.rejects(
        transaction.apply({
          operations: [
            {
              kind: "write",
              path: "managed/config.txt",
              content: "managed\n",
              expectedHash: sha256("original\n")
            }
          ]
        }),
        (error: unknown) =>
          error instanceof AgentOpsError &&
          error.code === "PRECONDITION_CHANGED"
      );
      assert.equal(
        await readFile(join(outside, "config.txt"), "utf8"),
        "outside\n"
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("rejects malformed operation discriminants before filesystem access", async () => {
  await withTempRoot(async (root) => {
    const invalidPlans: unknown[] = [
      {
        operations: [
          {
            kind: "bogus",
            path: "config.txt",
            expectedHash: null
          }
        ]
      },
      {
        operations: [
          {
            kind: "remove",
            path: "config.txt",
            content: "not allowed",
            expectedHash: null
          }
        ]
      },
      {
        operations: [
          {
            kind: "write",
            path: "config.txt",
            content: "content",
            expectedHash: "not-a-hash"
          }
        ]
      },
      { operations: [], unexpected: true }
    ];

    for (const invalidPlan of invalidPlans) {
      await assert.rejects(
        new FileTransaction(join(root, "missing-root")).apply(
          invalidPlan as TransactionPlan
        ),
        (error: unknown) =>
          error instanceof AgentOpsError &&
          error.code === "INVALID_TRANSACTION_PLAN"
      );
    }
  });
});

test("rollback failure preserves owner-only recovery backups", async () => {
  if (process.platform === "win32") {
    return;
  }
  await withTempRoot(async (root) => {
    const target = join(root, "config.txt");
    await writeFile(target, "original\n");
    let recoveryPaths: readonly string[] = [];

    await assert.rejects(
      new FileTransaction(root).apply(
        {
          operations: [
            {
              kind: "write",
              path: "config.txt",
              content: "managed\n",
              expectedHash: sha256("original\n")
            }
          ]
        },
        async () => {
          await rm(target);
          await mkdir(target);
          throw new Error("validation failed after hostile replacement");
        }
      ),
      (error: unknown) => {
        if (
          error instanceof AgentOpsError &&
          error.code === "ROLLBACK_FAILED"
        ) {
          recoveryPaths = error.recoveryPaths ?? [];
          return true;
        }
        return false;
      }
    );

    assert.equal(recoveryPaths.length, 1);
    assert.equal(await readFile(recoveryPaths[0]!, "utf8"), "original\n");
    assert.equal((await lstat(recoveryPaths[0]!)).mode & 0o777, 0o600);
    assert.equal(
      (await readdir(root)).some((name) => name.includes("agent-ops-backup")),
      true
    );
  });
});

test("rollback removes parent directories created for new files", async () => {
  await withTempRoot(async (root) => {
    await assert.rejects(
      new FileTransaction(root).apply(
        {
          operations: [
            {
              kind: "write",
              path: "new/nested/config.txt",
              content: "managed\n",
              expectedHash: null
            }
          ]
        },
        async () => {
          throw new Error("validation failed");
        }
      ),
      (error: unknown) =>
        error instanceof AgentOpsError && error.code === "TRANSACTION_FAILED"
    );
    await assert.rejects(lstat(join(root, "new")));
  });
});

test("new files and live backups use owner-only permissions on POSIX", async () => {
  if (process.platform === "win32") {
    return;
  }
  await withTempRoot(async (root) => {
    await writeFile(join(root, "existing.txt"), "original\n");
    await chmod(join(root, "existing.txt"), 0o644);
    let backupMode: number | undefined;
    const transaction = new FileTransaction(root, {
      beforeReplace: async ({ backupPath, index }) => {
        if (index === 0 && backupPath !== null) {
          backupMode = (await lstat(backupPath)).mode & 0o777;
        }
      }
    });

    await transaction.apply({
      operations: [
        {
          kind: "write",
          path: "existing.txt",
          content: "updated\n",
          expectedHash: sha256("original\n")
        },
        {
          kind: "write",
          path: "new.txt",
          content: "new\n",
          expectedHash: null
        }
      ]
    });

    assert.equal(backupMode, 0o600);
    assert.equal((await lstat(join(root, "new.txt"))).mode & 0o777, 0o600);
  });
});

test("formats and parses validated installation manifests", () => {
  const manifest: InstallManifest = {
    schemaVersion: 1,
    scope: "project",
    harness: "both",
    artifacts: [
      {
        id: "config",
        path: ".agent-ops/config.json",
        hash: "a".repeat(64),
        owner: "agent-ops"
      }
    ],
    markers: []
  };

  const formatted = formatInstallManifest(manifest);
  assert.equal(parseInstallManifest(formatted).artifacts[0]?.id, "config");
  assert.throws(
    () => parseInstallManifest('{"schemaVersion":1}'),
    (error: unknown) =>
      error instanceof AgentOpsError && error.code === "MANIFEST_INVALID"
  );
});
