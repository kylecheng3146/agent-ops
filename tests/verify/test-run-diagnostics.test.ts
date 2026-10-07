import assert from "node:assert/strict";
import {mkdtemp, realpath, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {executeConfiguredCommand} from "../../runtime/src/verify/command-executor.js";
import {createFailureFingerprint} from "../../runtime/src/verify/fingerprint.js";
import {NodeVerificationProcessRunner, type ProcessRequest} from "../../runtime/src/verify/spawn.js";

test("test entry retains an early failure after the TAP output is truncated", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agent-ops-test-diagnostic-")));
  try {
    const environment = {...process.env};
    delete environment.NODE_TEST_CONTEXT;
    const native = new NodeVerificationProcessRunner();
    const runner = {start: (request: ProcessRequest) => native.start({...request, replaceEnv: true,
      env: Object.fromEntries(Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined))})};
    const failing = join(root, "a.test.js"), passing = join(root, "z.test.js");
    await writeFile(failing, "const {test}=require('node:test');const assert=require('node:assert/strict');test('early-retained-failure',()=>assert.equal(1,2,'retained-assertion-cause'));\n");
    await writeFile(passing, "const {test}=require('node:test');test('later-pass',()=>process.stdout.write('noise\\n'.repeat(24000)));\n");
    const command = {id: "node-test", command: process.execPath,
      args: [join(process.cwd(), "scripts/run-tests.mjs"), failing, passing], cwd: ".", required: true,
      timeoutMs: 30000, evidence: {kind: "test-count" as const, minimum: 1}};
    const failed = await executeConfiguredCommand(command, {cwd: root, trusted: true, runner});
    assert.equal(failed.status, "FAIL");
    assert.equal(failed.exitCode, 1);
    assert.equal(failed.testCount, 1);
    assert.equal(failed.stdoutTruncated, true);
    assert.doesNotMatch(failed.stdout, /early-retained-failure/);
    assert.ok(failed.diagnostic.includes("early-retained-failure"), "Failure identity must survive truncation");
    assert.ok(failed.diagnostic.includes("retained-assertion-cause"));
    assert.ok(failed.diagnostic.replaceAll("\\", "/").includes(failing.replaceAll("\\", "/")));
    const fingerprint = createFailureFingerprint({commandId: command.id,
      failureClass: failed.failureClass, exitCategory: "nonzero-exit", diagnostics: failed.diagnostic});
    assert.match(fingerprint.diagnostics, /early-retained-failure/);
    assert.match(fingerprint.diagnostics, /retained-assertion-cause/);

    const passed = await executeConfiguredCommand({...command,
      args: [command.args[0]!, passing]}, {cwd: root, trusted: true, runner});
    assert.equal(passed.status, "PASS");
    assert.equal(passed.testCount, 1);
    assert.equal(passed.stderr, "");
  } finally {await rm(root, {recursive: true, force: true});}
});
