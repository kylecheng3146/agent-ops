import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs } from "../../packages/cli/src/args.js";
import { COMMAND_HELP_TEXT } from "../../packages/cli/src/cli.js";
import { runOfficeCommand } from "../../packages/cli/src/commands/office.js";
import { runRunCommand, type RunCommandService, type RunParsedArgs } from "../../packages/cli/src/commands/run.js";
import { AgentOpsError } from "../../runtime/src/fs/paths.js";
import { createRunState } from "../../runtime/src/run/service.js";

const URL = "http://127.0.0.1:4321/?token=abc";

test("agent-ops office prints a live or background-started URL", async () => {
  assert.equal(parseArgs(["office"]).command, "office");
  assert.match(COMMAND_HELP_TEXT.office, /10 minutes/u);
  const result = await runOfficeCommand({ensure: async () => URL, foreground: async () => { throw new Error("no foreground"); },
    writeStdout: () => { throw new Error("no stream"); }});
  assert.equal(result.status, "ok");
  assert.equal(result.code, "OFFICE_READY");
  assert.equal(result.data?.url, URL);
  assert.equal(result.data?.text, `Office: ${URL}`);
});

test("without background start the office serves in the foreground and prints its URL first", async () => {
  const out: string[] = [];
  const result = await runOfficeCommand({ensure: async () => null,
    foreground: async (onUrl) => { onUrl(URL); out.push("served"); }, writeStdout: (text) => { out.push(text); }});
  assert.match(out[0]!, /^Office: http:\/\/127\.0\.0\.1:4321\/\?token=abc\n/u);
  assert.equal(out[1], "served");
  assert.equal(result.code, "OFFICE_CLOSED");
  const failed = await runOfficeCommand({ensure: async () => { throw new AgentOpsError("OFFICE_START_FAILED", "late"); },
    foreground: async () => {}, writeStdout: () => {}});
  assert.equal(failed.code, "OFFICE_START_FAILED");
});

test("run start and run status print the office URL, and an office failure never fails the run", async () => {
  const state = createRunState({root: "/repo", commonDir: "/repo/.git", targetBranch: "main", goal: "Ship it.",
    host: "claude", ownerSessionId: "s", runId: "run-office-cli", now: "2026-10-07T00:00:00.000Z"});
  const service: RunCommandService = {
    start: async () => ({state, message: "started"}), status: async () => state, logs: async () => state.events,
    resume: async () => ({state, message: "resumed"}), stop: async () => ({state, message: "stopped"}),
    respond: async () => ({state, message: "answered"})};
  const args = (extra: Partial<RunParsedArgs>): RunParsedArgs =>
    ({command: "run", profiles: [], dryRun: false, json: true, yes: false, rerun: false, ...extra}) as RunParsedArgs;
  const base = {service, root: "/repo", commonDir: "/repo/.git", targetBranch: "main", ownerSessionId: "s"};
  for (const extra of [{goal: "Ship it."}, {runAction: "status" as const, runId: "run-office-cli"}]) {
    const result = await runRunCommand({...base, args: args(extra), office: async () => URL});
    assert.equal(result.status, "ok");
    assert.equal(result.data?.officeUrl, URL);
    assert.match(result.data!.text, /\nOffice: http:\/\/127\.0\.0\.1:4321\/\?token=abc$/u);
    const failing = await runRunCommand({...base, args: args(extra), office: async () => { throw new Error("launchd down"); }});
    assert.equal(failing.status, "ok");
    assert.equal(failing.data?.officeUrl, undefined);
    assert.doesNotMatch(failing.data!.text, /Office:/u);
  }
  const stopped = await runRunCommand({...base, args: args({runAction: "stop", runId: "run-office-cli"}), office: async () => URL});
  assert.equal(stopped.data?.officeUrl, undefined, "only start and status print the office");
});
