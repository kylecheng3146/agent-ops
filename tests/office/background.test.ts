import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ensureBackgroundOffice, officeEnabled, officeHome, observeOfficeSession, serveOffice } from "../../packages/cli/src/office-entry.js";
import { DEFAULT_CONFIG } from "../../packages/cli/src/context.js";
import { AgentOpsError } from "../../runtime/src/fs/paths.js";
import { LaunchdController } from "../../runtime/src/run/macOS.js";
import { claimOffice, createOfficeServer } from "../../runtime/src/office/server.js";

// The user's one Office lives under AGENT_OPS_HOME; keep it out of the real home.
let home = "";
test.before(async () => { home = await realpath(await mkdtemp(join(tmpdir(), "office-bg-home-"))); process.env.AGENT_OPS_HOME = home; });
test.after(async () => { delete process.env.AGENT_OPS_HOME; await rm(home, {recursive: true, force: true}); });

test("disabled Office Preview records no presence and never starts a server or browser", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "office-bg-disabled-")));
  try {
    execFileSync("git", ["init", "-q", "-b", "main", root]);
    await mkdir(join(root, ".agent-ops"));
    for (const office of [undefined, {enabled: false}]) {
      const {office: _previous, ...features} = DEFAULT_CONFIG.features;
      await writeFile(join(root, ".agent-ops/config.json"), JSON.stringify({...DEFAULT_CONFIG, features: {...features, ...(office === undefined ? {} : {office})}}));
      assert.equal(await officeEnabled(root), false);
      await observeOfficeSession({root, harness: "codex", event: "SessionStart", input: {session_id: "disabled"}, validated: true});
      await assert.rejects(ensureBackgroundOffice(root, new LaunchdController({platform: "darwin", uid: 501, execFile: async () => {throw new Error("must not launch");}}), async () => {throw new Error("must not open");}), (error: unknown) => error instanceof AgentOpsError && error.code === "OFFICE_PREVIEW_DISABLED");
      await assert.rejects(serveOffice(root), /Office \(Preview\) is disabled/);
      await assert.rejects(stat(join(root, ".git/agent-ops")), {code: "ENOENT"});
      await assert.rejects(stat(officeHome().dir), {code: "ENOENT"});
    }
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("a running Office closes when the Preview choice is disabled", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "office-bg-toggle-")));
  t.mock.timers.enable({apis: ["setInterval"]});
  let running: Promise<void> | undefined;
  try {
    execFileSync("git", ["init", "-q", "-b", "main", root]);
    await mkdir(join(root, ".agent-ops"));
    const path = join(root, ".agent-ops/config.json");
    await writeFile(path, JSON.stringify({...DEFAULT_CONFIG, features: {...DEFAULT_CONFIG.features, office: {enabled: true}}}));
    let announce!: () => void;
    const ready = new Promise<void>(resolve => {announce = resolve;});
    running = serveOffice(root, () => announce());
    await ready;
    await writeFile(path, JSON.stringify(DEFAULT_CONFIG));
    t.mock.timers.tick(15_000);
    await running;
    assert.equal(await officeEnabled(root), false);
  } finally {
    t.mock.timers.reset();
    await rm(root, {recursive: true, force: true});
  }
});

test("background office creates its private launchd directory before writing the descriptor", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "office-bg-")));
  try {
    execFileSync("git", ["init", "-q", "-b", "main", root]);
    await mkdir(join(root, ".agent-ops"));
    await writeFile(join(root, ".agent-ops/config.json"), JSON.stringify({...DEFAULT_CONFIG, features: {...DEFAULT_CONFIG.features, office: {enabled: true}}}));
    const calls: string[] = [];
    const launchd = new LaunchdController({platform: "darwin", uid: 501, execFile: async (_file, args) => {
      calls.push(args[0]!);
      if (args[0] === "bootstrap") throw new Error("launchctl unavailable in test");
      return {stdout: "", stderr: ""};
    }});
    await assert.rejects(ensureBackgroundOffice(root, launchd), /launchctl unavailable in test/u);
    const office = await stat(join(officeHome().dir, "launchd"));
    assert.ok(office.isDirectory());
    // Windows reports no POSIX permission bits.
    if (process.platform !== "win32") assert.equal(office.mode & 0o777, 0o700);
    assert.deepEqual(calls, ["bootout", "bootstrap"]);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test("background startup opens one injected browser page for one shared server", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "office-bg-once-")));
  let closeServer: (() => Promise<void>) | undefined;
  let bootstraps = 0;
  const pages: string[] = [];
  try {
    execFileSync("git", ["init", "-q", "-b", "main", root]);
    await mkdir(join(root, ".agent-ops"));
    await writeFile(join(root, ".agent-ops/config.json"), JSON.stringify({...DEFAULT_CONFIG, features: {...DEFAULT_CONFIG.features, office: {enabled: true}}}));
    const launchd = new LaunchdController({platform: "darwin", uid: 501, execFile: async (_file, args) => {
      if (args[0] === "bootstrap") {
        bootstraps += 1;
        const server = createOfficeServer({snapshot: async () => ({generatedAt: new Date().toISOString(), runs: [], lobby: [], reviews: []}), onIdle: () => {}});
        closeServer = server.close;
        assert.ok(await claimOffice(officeHome(), server) !== null);
      }
      return {stdout: "", stderr: ""};
    }});
    const open = async (url: string): Promise<void> => { pages.push(url); };
    const [left, right] = await Promise.all([
      ensureBackgroundOffice(root, launchd, open),
      ensureBackgroundOffice(root, launchd, open)
    ]);
    assert.equal(left, right);
    assert.equal(bootstraps, 1);
    assert.equal(pages.length, 1);
    assert.equal(pages[0], left);
  } finally {
    await closeServer?.();
    await rm(root, {recursive: true, force: true});
  }
});
