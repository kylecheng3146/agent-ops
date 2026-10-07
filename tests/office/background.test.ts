import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ensureBackgroundOffice } from "../../packages/cli/src/office-entry.js";
import { LaunchdController } from "../../runtime/src/run/macOS.js";
import { claimOffice, createOfficeServer } from "../../runtime/src/office/server.js";

test("background office creates its private launchd directory before writing the descriptor", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "office-bg-")));
  try {
    execFileSync("git", ["init", "-q", "-b", "main", root]);
    const calls: string[] = [];
    const launchd = new LaunchdController({platform: "darwin", uid: 501, execFile: async (_file, args) => {
      calls.push(args[0]!);
      if (args[0] === "bootstrap") throw new Error("launchctl unavailable in test");
      return {stdout: "", stderr: ""};
    }});
    await assert.rejects(ensureBackgroundOffice(root, launchd), /launchctl unavailable in test/u);
    const office = await stat(join(root, ".git", "agent-ops", "office"));
    assert.ok(office.isDirectory());
    assert.equal(office.mode & 0o777, 0o700);
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
    const launchd = new LaunchdController({platform: "darwin", uid: 501, execFile: async (_file, args) => {
      if (args[0] === "bootstrap") {
        bootstraps += 1;
        const server = createOfficeServer({snapshot: async () => ({generatedAt: new Date().toISOString(), runs: [], lobby: [], reviews: []}), onIdle: () => {}});
        closeServer = server.close;
        assert.ok(await claimOffice(join(root, ".git"), server) !== null);
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
