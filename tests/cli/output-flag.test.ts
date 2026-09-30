import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CliArgumentError, parseArgs } from "../../packages/cli/src/args.js";
import { runCli, type CliIo, type CliServices } from "../../packages/cli/src/cli.js";
import { errorEnvelope, okEnvelope } from "../../packages/cli/src/output.js";

function createIo(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: { isTTY: false, writeStdout: (value) => stdout.push(value), writeStderr: (value) => stderr.push(value) },
    stdout,
    stderr
  };
}

const services = (execute: CliServices["execute"]): CliServices => ({ version: "0.0.0-test", execute });

test("--output writes the whole envelope to a private file and prints one line", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-ops-output-"));
  try {
    const file = join(directory, "review.json");
    const { io, stdout, stderr } = createIo();
    const code = await runCli(["review", "--task", "task-1", "--yes", "--output", file], io,
      services(async () => okEnvelope("REVIEW_RESULT", { status: "PASS", detail: "x".repeat(2_000) })));

    assert.equal(code, 0);
    assert.deepEqual(stderr, []);
    assert.equal(stdout.length, 1);
    assert.equal(stdout[0], `agent-ops: REVIEW_RESULT (ok); envelope written to ${file}\n`);
    const written = JSON.parse(await readFile(file, "utf8")) as { code: string; data: { status: string } };
    assert.equal(written.code, "REVIEW_RESULT");
    assert.equal(written.data.status, "PASS");
    if (process.platform !== "win32") {
      assert.equal((await stat(file)).mode & 0o777, 0o600);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("--output keeps a failed result's exit code and still writes it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-ops-output-"));
  try {
    const file = join(directory, "doctor.json");
    const { io, stdout } = createIo();
    const code = await runCli(["doctor", "--output", file], io,
      services(async () => errorEnvelope("REVIEW_NOT_RUN", "Independent review was not run.")));

    assert.equal(code, 2);
    assert.match(stdout.join(""), /^agent-ops: REVIEW_NOT_RUN \(error\); envelope written to /u);
    assert.equal((JSON.parse(await readFile(file, "utf8")) as { status: string }).status, "error");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an unwritable --output path is reported, not swallowed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-ops-output-"));
  try {
    const { io, stdout, stderr } = createIo();
    const code = await runCli(["doctor", "--json", "--output", join(directory, "missing", "out.json")], io,
      services(async () => okEnvelope("DOCTOR_OK", {})));

    assert.equal(code, 1);
    assert.deepEqual(stdout.map((line) => (JSON.parse(line) as { errors: { code: string }[] }).errors[0]?.code), ["CLI_OUTPUT_WRITE_FAILED"]);
    assert.deepEqual(stderr, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("--output belongs to review and doctor only, once, and needs a real path", () => {
  assert.equal(parseArgs(["review", "--task", "t", "--yes", "--output", "out.json"]).output, "out.json");
  assert.equal(parseArgs(["doctor", "--output", "out.json"]).output, "out.json");
  for (const argv of [
    ["task", "status", "--output", "out.json"],
    ["worktree", "list", "--output", "out.json"],
    ["--help", "--output", "out.json"],
    ["doctor", "--output", "a", "--output", "b"],
    ["doctor", "--output", "  "],
    ["doctor", "--output"]
  ]) {
    assert.throws(() => parseArgs(argv), CliArgumentError, argv.join(" "));
  }
});
