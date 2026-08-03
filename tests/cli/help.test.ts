import assert from "node:assert/strict";
import test from "node:test";

import { AgentOpsError } from "../../runtime/src/fs/paths.js";
import type { ParsedArgs } from "../../packages/cli/src/args.js";
import { runCli, type CliIo, type CliServices } from "../../packages/cli/src/cli.js";
import {
  okEnvelope,
  type CliEnvelope
} from "../../packages/cli/src/output.js";

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
  assert.match(
    stdout.join(""),
    /--profile <core\|advisory\|guardrails\|loop>/u
  );
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

test("CLI preserves stable AgentOpsError codes and messages", async () => {
  const { io, stdout, stderr } = createIo(false);
  const services = createServices(async () => {
    throw new AgentOpsError(
      "INSTALL_ALREADY_CONFIGURED",
      "Use update to change the scope or harness of an existing installation."
    );
  });

  assert.equal(await runCli(["doctor", "--json"], io, services), 1);
  assert.equal(stderr.length, 0);
  assert.deepEqual(parseEnvelope(stdout), {
    code: "INSTALL_ALREADY_CONFIGURED",
    status: "error",
    data: null,
    errors: [
      {
        code: "INSTALL_ALREADY_CONFIGURED",
        message: "Use update to change the scope or harness of an existing installation."
      }
    ]
  });
});

test("TTY with no arguments launches the branded interactive init wizard", async () => {
  const { io, stdout, stderr } = createIo(true);
  const answers = ["project", "both", "core"];
  const questions: string[] = [];
  let received: ParsedArgs | undefined;
  io.prompt = async (question) => {
    questions.push(question);
    return answers.shift() ?? "";
  };
  const services = createServices(async (args) => {
    received = args;
    return okEnvelope("WIZARD_READY", { message: "ready" });
  });

  assert.equal(await runCli([], io, services), 0);
  assert.equal(stderr.length, 0);
  assert.match(stdout.join(""), /__ _  __ _  ___ _ __/u);
  assert.deepEqual(
    {
      command: received?.command,
      scope: received?.scope,
      harness: received?.harness,
      profiles: received?.profiles
    },
    {
      command: "init",
      scope: "project",
      harness: ["codex", "claude"],
      profiles: ["core"]
    }
  );
  assert.equal(questions.length, 3);
});

test("non-TTY with no arguments remains an explicit command error", async () => {
  const { io, stdout, stderr } = createIo(false);

  assert.equal(await runCli([], io, createServices()), 2);
  assert.equal(stdout.length, 0);
  assert.equal(stderr.length, 1);
  assert.match(stderr[0] ?? "", /command, --help, or --version is required/u);
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

test("JSON mode never writes interactive prompts, including on a TTY", async () => {
  const { io, stdout, stderr } = createIo(true);
  let promptCalls = 0;
  let executeCalls = 0;
  io.prompt = async () => {
    promptCalls += 1;
    return "";
  };
  const services = createServices(async () => {
    executeCalls += 1;
    return okEnvelope("UNEXPECTED", null);
  });

  assert.equal(await runCli(["init", "--json"], io, services), 2);
  assert.equal(promptCalls, 0);
  assert.equal(executeCalls, 0);
  assert.equal(stderr.length, 0);
  assert.equal(stdout.length, 1);
  assert.equal(parseEnvelope(stdout).code, "CLI_INTERACTIVE_REQUIRED");
});

test("JSON output preserves data when a service returns undefined", async () => {
  const { io, stdout, stderr } = createIo();
  const services = createServices(async () =>
    okEnvelope("EMPTY_RESULT", undefined)
  );

  assert.equal(await runCli(["doctor", "--json"], io, services), 0);
  assert.equal(stderr.length, 0);
  const envelope = parseEnvelope(stdout);
  assert.deepEqual(Object.keys(envelope).sort(), [
    "code",
    "data",
    "errors",
    "status"
  ]);
  assert.equal(envelope.data, null);
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
    harness: ["codex", "claude"],
    profiles: ["core"]
  });
});
