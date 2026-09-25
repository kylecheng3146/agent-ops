import assert from "node:assert/strict";
import { lstat } from "node:fs/promises";
import test from "node:test";

import {
  probeReviewTarget,
  probeTimeoutMs
} from "../../runtime/src/review/probe.js";
import type {
  ProcessRequest,
  RunningVerificationProcess,
  VerificationProcessRunner
} from "../../runtime/src/verify/spawn.js";

function bytes(value: string): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(value);
    }
  };
}

test("deep Claude probe uses a fresh isolated process context", async () => {
  let request: ProcessRequest | undefined;
  const runner: VerificationProcessRunner = {
    start(value): RunningVerificationProcess {
      request = value;
      return {
        pid: 1,
        stdout: bytes('{"result":"OK"}'),
        stderr: bytes(""),
        completion: Promise.resolve({ exitCode: 0, signal: null }),
        terminateTree: async () => {}
      };
    }
  };

  assert.equal(
    await probeReviewTarget("claude", { cwd: "/project", deep: true, runner }),
    "ok"
  );
  assert.notEqual(request?.cwd, "/project");
  assert.equal(request?.replaceEnv, true);
  // The probe runs outside the project but inside the real home: claude reads
  // its credentials there, and a replaced HOME made this probe report every
  // interactively-authenticated install as unauthenticated. Isolation comes
  // from the flags asserted below instead.
  assert.equal(request?.env?.HOME, process.env.HOME);
  assert.notEqual(request?.env?.HOME, request?.cwd);
  assert.equal(request?.stdin, "Reply with the single word OK and nothing else.");
  for (const flag of ["--safe-mode", "--no-session-persistence", "--disable-slash-commands"]) {
    assert.ok(request?.args.includes(flag), `missing ${flag}`);
  }
  await assert.rejects(lstat(request?.cwd ?? "/project"));
});

test("deep Codex probes preserve login while ignoring user config", async () => {
  let request: ProcessRequest | undefined;
  const runner: VerificationProcessRunner = {
    start(value) {
      request = value;
      return {
        pid: 1,
        stdout: bytes("OK"),
        stderr: bytes(""),
        completion: Promise.resolve({ exitCode: 0, signal: null }),
        terminateTree: async () => {}
      };
    }
  };
  assert.equal(
    await probeReviewTarget("codex", { cwd: "/project", deep: true, runner }),
    "ok"
  );
  assert.notEqual(request?.cwd, "/project");
  assert.equal(request?.env?.HOME, request?.cwd);
  assert.notEqual(request?.env?.CODEX_HOME, undefined);
  for (const flag of ["--ephemeral", "--ignore-user-config", "--ignore-rules"]) {
    assert.ok(request?.args.includes(flag), `missing ${flag}`);
  }
});

test("deep Agy probe binds the prompt and keeps sandboxed plan mode", async () => {
  const requests: ProcessRequest[] = [];
  const runner: VerificationProcessRunner = {
    start(value) {
      requests.push(value);
      return {
        pid: 1,
        stdout: bytes('{"response":"OK"}'),
        stderr: bytes(""),
        completion: Promise.resolve({ exitCode: 0, signal: null }),
        terminateTree: async () => {}
      };
    }
  };
  assert.equal(
    await probeReviewTarget("agy", { cwd: "/project", deep: true, runner }),
    "ok"
  );
  const request = requests.at(-1);
  assert.deepEqual(request?.args.slice(0, 2), [
    "-p",
    "Reply with the single word OK and nothing else."
  ]);
  for (const flag of ["--sandbox", "--mode", "plan"]) {
    assert.ok(request?.args.includes(flag), `missing ${flag}`);
  }
  assert.ok(request?.args.includes("--log-file"));
  assert.equal(request?.stdin, "");
});

test("deep Agy probe clones the repo so the sandbox answers", async () => {
  const requests: ProcessRequest[] = [];
  const runner: VerificationProcessRunner = {
    start(value) {
      requests.push(value);
      return {
        pid: 1,
        stdout: bytes('{"response":"OK"}'),
        stderr: bytes(""),
        completion: Promise.resolve({ exitCode: 0, signal: null }),
        terminateTree: async () => {}
      };
    }
  };
  assert.equal(
    await probeReviewTarget("agy", { cwd: "/project", deep: true, runner }),
    "ok"
  );
  assert.equal(requests.length, 2);
  const [clone, invocation] = requests;
  assert.equal(clone?.command, "git");
  assert.deepEqual(clone?.args.slice(0, 4), ["clone", "--no-hardlinks", "--quiet", "--"]);
  assert.equal(clone?.args.at(-2), "/project");
  assert.equal(clone?.args.at(-1), invocation?.cwd);
  assert.ok(invocation?.cwd.endsWith("/repository"));
  await assert.rejects(lstat(invocation?.cwd ?? "/project"));
});

test("deep Agy probe falls back to plain temp when cloning fails", async () => {
  const requests: ProcessRequest[] = [];
  const runner: VerificationProcessRunner = {
    start(value) {
      requests.push(value);
      const cloneFailed = value.command === "git";
      return {
        pid: 1,
        stdout: bytes(cloneFailed ? "" : '{"response":"OK"}'),
        stderr: bytes(""),
        completion: Promise.resolve({ exitCode: cloneFailed ? 1 : 0, signal: null }),
        terminateTree: async () => {}
      };
    }
  };
  assert.equal(
    await probeReviewTarget("agy", { cwd: "/project", deep: true, runner }),
    "ok"
  );
  assert.equal(requests.length, 2);
  const [clone, invocation] = requests;
  assert.equal(clone?.command, "git");
  assert.equal(invocation?.command, "agy");
  assert.ok(!invocation?.cwd.endsWith("/repository"));
  await assert.rejects(lstat(invocation?.cwd ?? "/project"));
});

test("the probe ceiling survives a caller handing it the whole chain budget", () => {
  // The default, a shortened budget, and a budget far larger than the ceiling.
  assert.equal(probeTimeoutMs(), 120_000);
  assert.equal(probeTimeoutMs(5_000), 5_000);
  assert.equal(
    probeTimeoutMs(1_800_000),
    120_000,
    "a hung probe must still stop at two minutes"
  );
  assert.equal(probeTimeoutMs(0), 1, "a spent budget still leaves a real timeout");
});
