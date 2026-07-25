import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { cleanTargets } from "../scripts/clean.mjs";
import { collectTestFiles, runTestEntry } from "../scripts/run-tests-lib.mjs";

function createFileSystem(entries, directories = new Map()) {
  const normalizedEntries = new Map(
    [...entries].map(([entryPath, type]) => [path.normalize(entryPath), type]),
  );
  const normalizedDirectories = new Map(
    [...directories].map(([directoryPath, children]) => [
      path.normalize(directoryPath),
      [...children],
    ]),
  );

  return {
    async realpath(entryPath) {
      return path.normalize(entryPath);
    },
    async stat(entryPath) {
      const type = normalizedEntries.get(path.normalize(entryPath));
      if (type === undefined) {
        const error = new Error(`ENOENT: ${entryPath}`);
        error.code = "ENOENT";
        throw error;
      }

      return {
        isDirectory: () => type === "directory",
        isFile: () => type === "file",
      };
    },
    async readdir(directoryPath) {
      return normalizedDirectories.get(path.normalize(directoryPath)) ?? [];
    },
  };
}

async function createTemporaryDirectory(t, prefix) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(directory, { force: true, recursive: true }));
  return directory;
}

function createChildResult(code, signal = null) {
  const child = new EventEmitter();
  queueMicrotask(() => child.emit("close", code, signal));
  return child;
}

test("collectTestFiles accepts explicit files and recursively scans directories", async () => {
  const root = path.resolve("fixtures", "tests");
  const nested = path.join(root, "nested");
  const alpha = path.join(root, "alpha.test.js");
  const nestedAlpha = path.join(nested, "alpha.test.js");
  const zeta = path.join(nested, "zeta.test.js");
  const ignored = path.join(root, "notes.js");
  const fileSystem = createFileSystem(
    new Map([
      [root, "directory"],
      [nested, "directory"],
      [alpha, "file"],
      [nestedAlpha, "file"],
      [zeta, "file"],
      [ignored, "file"],
    ]),
    new Map([
      [root, ["notes.js", "nested", "alpha.test.js"]],
      [nested, ["zeta.test.js", "alpha.test.js"]],
    ]),
  );

  const files = await collectTestFiles([zeta, root], fileSystem);

  assert.deepEqual(files, [alpha, nestedAlpha, zeta]);
});

test("collectTestFiles de-duplicates and sorts paths deterministically", async () => {
  const root = path.resolve("fixtures", "dedupe");
  const alpha = path.join(root, "alpha.test.js");
  const zeta = path.join(root, "zeta.test.js");
  const fileSystem = createFileSystem(
    new Map([
      [root, "directory"],
      [alpha, "file"],
      [zeta, "file"],
    ]),
    new Map([[root, ["zeta.test.js", "alpha.test.js"]]]),
  );

  const files = await collectTestFiles([zeta, root, alpha, root], fileSystem);

  assert.deepEqual(files, [alpha, zeta]);
});

test("collectTestFiles de-duplicates relative and absolute aliases", async (t) => {
  const root = await createTemporaryDirectory(t, "agent-ops-alias-");
  const testFile = path.join(root, "alias.test.js");
  await writeFile(testFile, "");
  const relativeTestFile = path.relative(process.cwd(), testFile);

  const files = await collectTestFiles([relativeTestFile, testFile]);

  assert.deepEqual(files, [await realpath(testFile)]);
});

test("collectTestFiles terminates directory symlink cycles", async (t) => {
  const root = await createTemporaryDirectory(t, "agent-ops-cycle-");
  const testFile = path.join(root, "cycle.test.js");
  await writeFile(testFile, "");
  await symlink(
    ".",
    path.join(root, "loop"),
    process.platform === "win32" ? "junction" : "dir",
  );

  const files = await collectTestFiles([root]);

  assert.deepEqual(files, [await realpath(testFile)]);
});

test("collectTestFiles rejects unsupported filesystem inputs", async () => {
  const socketPath = path.resolve("fixtures", "test.sock");
  const fileSystem = createFileSystem(new Map([[socketPath, "unsupported"]]));

  await assert.rejects(
    collectTestFiles([socketPath], fileSystem),
    /Unsupported test input/,
  );
});

test("collectTestFiles fails when no JavaScript tests are found", async () => {
  const root = path.resolve("fixtures", "empty");
  const ignored = path.join(root, "notes.js");
  const fileSystem = createFileSystem(
    new Map([
      [root, "directory"],
      [ignored, "file"],
    ]),
    new Map([[root, ["notes.js"]]]),
  );

  await assert.rejects(
    collectTestFiles([root], fileSystem),
    /No \*\.test\.js files found/,
  );
});

test("runTestEntry launches the current Node executable with explicit sorted arguments", async () => {
  const root = path.resolve("fixtures", "entry");
  const alpha = path.join(root, "alpha.test.js");
  const zeta = path.join(root, "zeta.test.js");
  const fileSystem = createFileSystem(
    new Map([
      [alpha, "file"],
      [zeta, "file"],
    ]),
  );
  const calls = [];
  const spawn = (...args) => {
    calls.push(args);
    return createChildResult(0);
  };

  await runTestEntry([zeta, alpha], { fileSystem, spawn });

  assert.deepEqual(calls, [
    [
      process.execPath,
      ["--test", alpha, zeta],
      { shell: false, stdio: "inherit" },
    ],
  ]);
});

test("runTestEntry propagates every non-zero child exit code", async (t) => {
  const testFile = path.resolve("fixtures", "failure.test.js");
  const fileSystem = createFileSystem(new Map([[testFile, "file"]]));

  for (const exitCode of [1, 2, 64, 255]) {
    await t.test(`exit code ${exitCode}`, async () => {
      const processLike = {
        execPath: process.execPath,
        exitCode: undefined,
        kill: () => {
          throw new Error("kill should not be called for an exit code");
        },
        pid: 123,
      };

      await runTestEntry([testFile], {
        fileSystem,
        process: processLike,
        spawn: () => createChildResult(exitCode),
      });

      assert.equal(processLike.exitCode, exitCode);
    });
  }
});

test("runTestEntry propagates child termination signals", async () => {
  const testFile = path.resolve("fixtures", "signal.test.js");
  const fileSystem = createFileSystem(new Map([[testFile, "file"]]));
  const signals = [];
  const processLike = {
    execPath: process.execPath,
    exitCode: undefined,
    kill: (...args) => signals.push(args),
    pid: 456,
  };

  await runTestEntry([testFile], {
    fileSystem,
    process: processLike,
    spawn: () => createChildResult(null, "SIGTERM"),
  });

  assert.deepEqual(signals, [[456, "SIGTERM"]]);
  assert.equal(processLike.exitCode, undefined);
});

test("cleanTargets rejects absolute paths and targets outside dist or .tmp", async () => {
  const removed = [];
  const remove = async (...args) => removed.push(args);

  for (const target of [
    path.resolve("dist"),
    "C:\\temp\\dist",
    "C:/temp/dist",
    "\\\\server\\share\\dist",
    "../dist",
    "other/../dist",
    "docs",
    "dist/../../README.md",
    ".tmp/nested/..",
    "dist\\..\\README.md",
    ".tmpish",
  ]) {
    await assert.rejects(cleanTargets([target], { remove }), /Refusing to clean/);
  }

  assert.deepEqual(removed, []);
});

test("cleanTargets rejects allowlisted roots that are symbolic links", async (t) => {
  const root = await createTemporaryDirectory(t, "agent-ops-clean-");
  const project = path.join(root, "project");
  const outsideDirectory = path.join(root, "outside");
  const victim = path.join(outsideDirectory, "victim.txt");
  await mkdir(project);
  await mkdir(outsideDirectory);
  await writeFile(victim, "preserve me");
  await symlink(
    outsideDirectory,
    path.join(project, ".tmp"),
    process.platform === "win32" ? "junction" : "dir",
  );

  await assert.rejects(
    cleanTargets([".tmp"], { cwd: project }),
    /symbolic link/,
  );
  assert.equal(await readFile(victim, "utf8"), "preserve me");
});

test("cleanTargets rejects nested targets before filesystem access", async () => {
  const calls = [];

  await assert.rejects(
    cleanTargets(["dist/nested"], {
      canonicalize: async (...args) => {
        calls.push(["canonicalize", ...args]);
        return args[0];
      },
      inspect: async (...args) => {
        calls.push(["inspect", ...args]);
        return { isSymbolicLink: () => false };
      },
      remove: async (...args) => calls.push(["remove", ...args]),
    }),
    /top-level/,
  );

  assert.deepEqual(calls, []);
});

test("cleanTargets removes roots from the requested cwd instead of process cwd", async (t) => {
  const root = await createTemporaryDirectory(t, "agent-ops-cwd-");
  const processDirectory = path.join(root, "process");
  const requestedDirectory = path.join(root, "requested");
  const processMarker = path.join(processDirectory, "dist", "marker.txt");
  const requestedMarker = path.join(requestedDirectory, "dist", "marker.txt");
  await mkdir(path.dirname(processMarker), { recursive: true });
  await mkdir(path.dirname(requestedMarker), { recursive: true });
  await writeFile(processMarker, "keep process cwd");
  await writeFile(requestedMarker, "remove requested cwd");
  const originalCwd = process.cwd();

  process.chdir(processDirectory);
  try {
    await cleanTargets(["dist"], { cwd: requestedDirectory });
  } finally {
    process.chdir(originalCwd);
  }

  assert.equal(await readFile(processMarker, "utf8"), "keep process cwd");
  await assert.rejects(readFile(requestedMarker), { code: "ENOENT" });
});

test("cleanTargets removes only canonical allowlisted roots", async () => {
  const removed = [];
  const remove = async (...args) => removed.push(args);
  const canonicalCwd = await realpath(process.cwd());

  await cleanTargets(["dist", ".tmp"], { remove });

  assert.deepEqual(removed, [
    [path.join(canonicalCwd, "dist"), { force: true, recursive: true }],
    [path.join(canonicalCwd, ".tmp"), { force: true, recursive: true }],
  ]);
});
