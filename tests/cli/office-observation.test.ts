import assert from "node:assert/strict";
import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Readable} from "node:stream";
import test from "node:test";

import type {AgentOpsConfig} from "../../runtime/src/contracts.js";
import {runHookProcess} from "../../packages/cli/src/hook-process.js";
import {runLoopProcess} from "../../packages/cli/src/codex-loop-process.js";
import type {OfficeSessionObservation} from "../../packages/cli/src/office-entry.js";

const config: AgentOpsConfig = {
  schemaVersion: 3,
  profiles: ["core"],
  verification: {commands: []},
  features: {office: {enabled: true}, completionGate: {enabled: false}, stopVerification: {enabled: false}},
  pathMappings: [],
  securityExceptions: []
};

test("ordinary hook entry observes SessionStart and activity without changing host output", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-office-observe-"));
  try {
    const seen: OfficeSessionObservation[] = [];
    const stdout: string[] = [];
    const stderr: string[] = [];
    const input = JSON.stringify({hook_event_name: "SessionStart", cwd: root, session_id: "session-a"});
    const exitCode = await runHookProcess(["claude", "SessionStart"], {
      stdin: Readable.from([input]),
      writeStdout: value => stdout.push(value),
      writeStderr: value => stderr.push(value)
    }, "test", {
      root,
      loadConfig: async () => config,
      trust: async () => "TRUSTED",
      office: async observation => {seen.push(observation);}
    });
    assert.equal(exitCode, 0);
    assert.deepEqual(stdout, []);
    assert.deepEqual(stderr, []);
    assert.equal(seen[0]?.event, "SessionStart");
    assert.equal(seen[0]?.sessionId, "session-a");
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("ordinary hook phase hints use normalized file-write events", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-office-phase-"));
  try {
    const seen: OfficeSessionObservation[] = [];
    await runHookProcess(["claude", "PreToolUse"], {
      stdin: Readable.from([JSON.stringify({hook_event_name: "PreToolUse", cwd: root, session_id: "session-phase", tool_name: "Write", tool_input: {file_path: "src/change.ts"}})]),
      writeStdout: () => undefined,
      writeStderr: () => undefined
    }, "test", {
      root,
      loadConfig: async () => config,
      trust: async () => "TRUSTED",
      office: async observation => {seen.push(observation);}
    });
    assert.equal(seen[0]?.phase, "implementing");
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("AGENT_OPS_DISABLE bypasses Office observation in ordinary hooks", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-office-disabled-"));
  const previous = process.env.AGENT_OPS_DISABLE;
  process.env.AGENT_OPS_DISABLE = "1";
  try {
    let observed = false;
    await runHookProcess(["claude", "SessionStart"], {
      stdin: Readable.from([]),
      writeStdout: () => undefined,
      writeStderr: () => undefined
    }, "test", {root, office: async () => {observed = true;}});
    assert.equal(observed, false);
  } finally {
    if (previous === undefined) delete process.env.AGENT_OPS_DISABLE;
    else process.env.AGENT_OPS_DISABLE = previous;
    await rm(root, {recursive: true, force: true});
  }
});

test("project-loop entry observes SessionStart and activity through its process boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-office-loop-observe-"));
  try {
    await mkdir(join(root, ".agent-ops"));
    await writeFile(join(root, ".agent-ops", "config.json"), JSON.stringify(config));
    await mkdir(join(root, ".codex"));
    await writeFile(join(root, ".codex", "loop-goal.md"), "# Goal\n");
    await writeFile(join(root, ".codex", "loop-state.md"), "# State\n");
    await writeFile(join(root, ".codex", "loop-telemetry.jsonl"), "");
    const seen: OfficeSessionObservation[] = [];
    for (const event of ["SessionStart", "PreToolUse"] as const) {
      const input = event === "PreToolUse"
        ? {cwd: root, session_id: "loop-a", hook_event_name: event, tool_name: "Bash", tool_input: {command: "echo safe"}}
        : {cwd: root, session_id: "loop-a", hook_event_name: event};
      const result = await runLoopProcess(["codex", event], {
        stdin: Readable.from([JSON.stringify(input)]),
        writeStdout: () => undefined,
        writeStderr: () => undefined
      }, {root, office: async observation => {seen.push(observation);}});
      assert.equal(result, 0);
    }
    assert.deepEqual(seen.map(item => [item.event, (item.input as {session_id?: string}).session_id]), [["SessionStart", "loop-a"], ["PreToolUse", "loop-a"]]);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("project-loop Office observation uses normalized phase hints and stays fail-open", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-office-loop-phase-"));
  try {
    await mkdir(join(root, ".agent-ops"));
    await writeFile(join(root, ".agent-ops", "config.json"), JSON.stringify(config));
    await mkdir(join(root, ".codex"));
    const seen: OfficeSessionObservation[] = [];
    const result = await runLoopProcess(["codex", "PreToolUse"], {
      stdin: Readable.from([JSON.stringify({cwd: root, session_id: "loop-phase", tool_name: "Bash", tool_input: {command: "agent-ops verify --task task-a"}})]),
      writeStdout: () => undefined,
      writeStderr: () => undefined
    }, {root, office: async observation => {seen.push(observation); throw new Error("display unavailable");}});
    assert.equal(result, 0);
    assert.equal(seen[0]?.phase, "verifying");
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("invalid and unmanaged loop inputs never start Office", async () => {
  const managed = await mkdtemp(join(tmpdir(), "agent-ops-office-loop-invalid-"));
  const unmanaged = await mkdtemp(join(tmpdir(), "agent-ops-office-loop-unmanaged-"));
  try {
    await mkdir(join(managed, ".codex"));
    let observed = 0;
    const deps = {root: managed, office: async () => {observed += 1;}};
    await runLoopProcess(["codex", "SessionStart"], {
      stdin: Readable.from(["null"]), writeStdout: () => undefined, writeStderr: () => undefined
    }, deps);
    await runLoopProcess(["codex", "SessionStart"], {
      stdin: Readable.from([JSON.stringify({cwd: unmanaged, session_id: "unmanaged"})]), writeStdout: () => undefined, writeStderr: () => undefined
    }, {root: unmanaged, office: deps.office});
    assert.equal(observed, 0);
  } finally {
    await rm(managed, {recursive: true, force: true});
    await rm(unmanaged, {recursive: true, force: true});
  }
});

test("disabled Office Preview bypasses both hook and project-loop observers", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-office-opt-in-"));
  try {
    await mkdir(join(root, ".agent-ops"));
    await mkdir(join(root, ".codex"));
    await writeFile(join(root, ".codex/loop-goal.md"), "# Goal\n");
    await writeFile(join(root, ".codex/loop-state.md"), "# State\n");
    let observations = 0;
    for (const office of [undefined, {enabled: false}]) {
      const {office: _previous, ...features} = config.features;
      const disabled = {...config, features: {...features, ...(office === undefined ? {} : {office})}};
      await writeFile(join(root, ".agent-ops/config.json"), JSON.stringify(disabled));
      const input = JSON.stringify({cwd: root, session_id: "off", hook_event_name: "SessionStart"});
      const officeObserver = async () => {observations += 1;};
      await runHookProcess(["claude", "SessionStart"], {stdin: Readable.from([input]), writeStdout: () => {}, writeStderr: () => {}}, "test", {root, loadConfig: async () => disabled, trust: async () => "TRUSTED", office: officeObserver});
      await runLoopProcess(["codex", "SessionStart"], {stdin: Readable.from([input]), writeStdout: () => {}, writeStderr: () => {}}, {root, office: officeObserver});
    }
    assert.equal(observations, 0);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
