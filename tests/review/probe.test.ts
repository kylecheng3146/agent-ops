import assert from "node:assert/strict";
import { lstat } from "node:fs/promises";
import test from "node:test";

import { probeReviewTarget } from "../../runtime/src/review/probe.js";
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
  assert.equal(request?.env?.HOME, request?.cwd);
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
