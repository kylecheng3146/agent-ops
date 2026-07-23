import assert from "node:assert/strict";
import test from "node:test";

import { runCli, type CliIo, type CliServices } from "../../packages/cli/src/cli.js";
import type { CliEnvelope } from "../../packages/cli/src/output.js";

function createIo(isTTY = false): {
  io: CliIo;
  stdout: string[];
  stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      isTTY,
      writeStdout: (value) => stdout.push(value),
      writeStderr: (value) => stderr.push(value)
    },
    stdout,
    stderr
  };
}

function createServices(
  execute: CliServices["execute"] = async () => {
    throw new Error("command service must not run");
  }
): CliServices {
  return {
    version: "1.2.3-test",
    execute
  };
}

function parseEnvelope(output: string[]): CliEnvelope<unknown> {
  assert.equal(output.length, 1);
  return JSON.parse(output[0] ?? "") as CliEnvelope<unknown>;
}

test("help returns without invoking command services", async () => {
  const { io, stdout, stderr } = createIo();
  let calls = 0;
  const services = createServices(async () => {
    calls += 1;
    throw new Error("must not execute");
  });

  assert.equal(await runCli(["--help"], io, services), 0);
  assert.equal(calls, 0);
  assert.equal(stderr.length, 0);
  assert.match(stdout.join(""), /Usage: agent-ops/);
  assert.match(stdout.join(""), /init/);
  assert.match(stdout.join(""), /review/);
});

test("version returns without invoking command services", async () => {
  const { io, stdout, stderr } = createIo();
  let calls = 0;
  const services = createServices(async () => {
    calls += 1;
    throw new Error("must not execute");
  });

  assert.equal(await runCli(["--version"], io, services), 0);
  assert.equal(calls, 0);
  assert.equal(stderr.length, 0);
  assert.deepEqual(stdout, ["1.2.3-test\n"]);
});

test("JSON help uses the stable output envelope", async () => {
  const { io, stdout, stderr } = createIo();

  assert.equal(
    await runCli(["--json", "--help"], io, createServices()),
    0
  );
  assert.equal(stderr.length, 0);
  const envelope = parseEnvelope(stdout);
  assert.deepEqual(Object.keys(envelope).sort(), [
    "code",
    "data",
    "errors",
    "status"
  ]);
  assert.equal(envelope.code, "CLI_HELP");
  assert.equal(envelope.status, "ok");
  assert.deepEqual(envelope.errors, []);
});

test("JSON parser failures use stable codes and fields", async () => {
  const { io, stdout, stderr } = createIo();

  assert.equal(
    await runCli(["init", "--json", "--unknown"], io, createServices()),
    2
  );
  assert.equal(stderr.length, 0);
  const envelope = parseEnvelope(stdout);
  assert.equal(envelope.code, "CLI_UNKNOWN_OPTION");
  assert.equal(envelope.status, "error");
  assert.equal(envelope.data, null);
  assert.equal(envelope.errors[0]?.code, "CLI_UNKNOWN_OPTION");
});

test("non-TTY init reports missing explicit choices even with --yes", async () => {
  const { io, stdout, stderr } = createIo();
  let calls = 0;
  const services = createServices(async () => {
    calls += 1;
    throw new Error("must not execute");
  });

  assert.equal(
    await runCli(["init", "--yes", "--json"], io, services),
    2
  );
  assert.equal(calls, 0);
  assert.equal(stderr.length, 0);
  assert.equal(parseEnvelope(stdout).code, "CLI_INTERACTIVE_REQUIRED");
});

test("complete non-interactive args reach the injected command service", async () => {
  const { io, stdout, stderr } = createIo();
  const services = createServices(async (args) => ({
    code: "INIT_PLAN_READY",
    status: "ok",
    data: {
      command: args.command,
      scope: args.scope,
      harness: args.harness,
      profiles: args.profiles
    },
    errors: []
  }));

  assert.equal(
    await runCli(
      [
        "init",
        "--scope",
        "project",
        "--harness",
        "both",
        "--profile",
        "core",
        "--dry-run",
        "--json"
      ],
      io,
      services
    ),
    0
  );
  assert.equal(stderr.length, 0);
  const envelope = parseEnvelope(stdout);
  assert.equal(envelope.code, "INIT_PLAN_READY");
  assert.deepEqual(envelope.data, {
    command: "init",
    scope: "project",
    harness: "both",
    profiles: ["core"]
  });
});
