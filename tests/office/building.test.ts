import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ensureBackgroundOffice, officeHome, observeOfficeSession } from "../../packages/cli/src/office-entry.js";
import { DEFAULT_CONFIG } from "../../packages/cli/src/context.js";
import { LaunchdController } from "../../runtime/src/run/macOS.js";
import { collectOfficeBuilding } from "../../runtime/src/office/collect.js";
import { readOfficeRepos, registerOfficeRepo } from "../../runtime/src/office/repos.js";
import { claimOffice, createOfficeServer, legacyOfficeHome, officeRecordPath } from "../../runtime/src/office/server.js";
import { recordOfficeSession } from "../../runtime/src/office/sessions.js";

let home = "";
test.before(async () => { home = await realpath(await mkdtemp(join(tmpdir(), "office-building-home-"))); process.env.AGENT_OPS_HOME = home; });
test.after(async () => { delete process.env.AGENT_OPS_HOME; await rm(home, {recursive: true, force: true}); });

async function repository(name: string, office = true): Promise<{root: string; commonDir: string}> {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "office-building-")));
  const root = join(parent, name);
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  await mkdir(join(root, ".agent-ops"));
  await writeFile(join(root, ".agent-ops/config.json"), JSON.stringify(office
    ? {...DEFAULT_CONFIG, features: {...DEFAULT_CONFIG.features, office: {enabled: true}}} : DEFAULT_CONFIG));
  return {root, commonDir: join(root, ".git")};
}

const enabledByConfig = async (root: string): Promise<boolean> =>
  JSON.parse(await readFile(join(root, ".agent-ops/config.json"), "utf8")).features?.office?.enabled === true;

test("a hook in an Office-enabled repository registers it; a disabled one does not", async () => {
  const on = await repository("on"), off = await repository("off", false);
  try {
    for (const repo of [on, off]) {
      await observeOfficeSession({root: repo.root, harness: "claude", event: "Stop", input: {session_id: "s-" + repo.root.length}, validated: true});
    }
    assert.deepEqual((await readOfficeRepos(officeHome())).map(repo => repo.commonDir), [on.commonDir]);
  } finally {
    await rm(join(on.root, ".."), {recursive: true, force: true});
    await rm(join(off.root, ".."), {recursive: true, force: true});
  }
});

test("one building shows every live repository and forgets gone, disabled or long-quiet ones", async () => {
  const buildingHome = {anchor: home, dir: join(home, "building")};
  const left = await repository("shop"), right = await repository("api"), gone = await repository("gone");
  const disabled = await repository("disabled"), quiet = await repository("quiet"), fresh = await repository("fresh");
  const now = Date.now();
  try {
    for (const repo of [left, right]) {
      await recordOfficeSession({sessionId: "same-session", harness: "claude", projectRoot: repo.root, commonDir: repo.commonDir, event: "start", now});
    }
    for (const repo of [left, right, gone, disabled, fresh]) await registerOfficeRepo(buildingHome, {mainRoot: repo.root, commonDir: repo.commonDir}, now);
    await registerOfficeRepo(buildingHome, {mainRoot: quiet.root, commonDir: quiet.commonDir}, now - 3 * 60 * 60 * 1000);
    await rm(join(gone.root, ".."), {recursive: true, force: true});
    await writeFile(join(disabled.root, ".agent-ops/config.json"), JSON.stringify(DEFAULT_CONFIG));

    const building = await collectOfficeBuilding(buildingHome, enabledByConfig, undefined, now);

    assert.equal(building.repos, 3);
    assert.deepEqual(building.snapshot.lobby.map(desk => [desk.repo, desk.sessionId]), [["shop", "same-session"], ["api", "same-session"]]);
    assert.deepEqual((await readOfficeRepos(buildingHome)).map(repo => repo.commonDir).sort(),
      [left.commonDir, right.commonDir, fresh.commonDir].sort());
  } finally {
    for (const repo of [left, right, disabled, quiet, fresh]) await rm(join(repo.root, ".."), {recursive: true, force: true});
  }
});

function fakeLaunchd(calls: string[], onBootstrap: () => Promise<void> = async () => {}): LaunchdController {
  return new LaunchdController({platform: "darwin", uid: 501, execFile: async (_file, args) => {
    calls.push(args.join(" "));
    if (args[0] === "bootstrap") await onBootstrap();
    return {stdout: "", stderr: ""};
  }});
}

test("two repositories share one user-global server and one page", async () => {
  const left = await repository("left"), right = await repository("right");
  let closeServer: (() => Promise<void>) | undefined;
  const pages: string[] = [];
  const calls: string[] = [];
  try {
    const launchd = fakeLaunchd(calls, async () => {
      const server = createOfficeServer({snapshot: async () => ({generatedAt: new Date().toISOString(), runs: [], lobby: [], reviews: []}), onIdle: () => {}});
      closeServer = server.close;
      assert.ok(await claimOffice(officeHome(), server) !== null);
    });
    const open = async (url: string): Promise<void> => { pages.push(url); };
    const first = await ensureBackgroundOffice(left.root, launchd, open);
    const second = await ensureBackgroundOffice(right.root, launchd, open);
    assert.equal(first, second);
    assert.equal(calls.filter(call => call.startsWith("bootstrap")).length, 1);
    assert.equal(pages.length, 1);
    await assert.rejects(stat(officeRecordPath(legacyOfficeHome(left.commonDir))), {code: "ENOENT"});
    assert.ok((await stat(officeRecordPath(officeHome()))).isFile());
  } finally {
    await closeServer?.();
    await rm(join(left.root, ".."), {recursive: true, force: true});
    await rm(join(right.root, ".."), {recursive: true, force: true});
  }
});

test("a repository's 0.7 Office server is booted out and its record removed, once", async () => {
  const repo = await repository("legacy");
  let closeServer: (() => Promise<void>) | undefined;
  const calls: string[] = [];
  try {
    const legacy = legacyOfficeHome(repo.commonDir);
    await mkdir(join(legacy.dir, "office"), {recursive: true, mode: 0o700});
    await writeFile(officeRecordPath(legacy), JSON.stringify({pid: 2 ** 22 + 7, port: 1, token: "old", startedAt: new Date().toISOString()}), {mode: 0o600});
    const launchd = fakeLaunchd(calls, async () => {
      const server = createOfficeServer({snapshot: async () => ({generatedAt: new Date().toISOString(), runs: [], lobby: [], reviews: []}), onIdle: () => {}});
      closeServer = server.close;
      assert.ok(await claimOffice(officeHome(), server) !== null);
    });
    await ensureBackgroundOffice(repo.root, launchd);
    const label = "office-" + createHash("sha256").update(repo.commonDir).digest("hex").slice(0, 12);
    const bootouts = calls.filter(call => call.startsWith("bootout") && call.includes(label));
    await assert.rejects(stat(officeRecordPath(legacy)), {code: "ENOENT"});
    await assert.rejects(stat(join(legacy.dir, "office")), {code: "ENOENT"});
    await ensureBackgroundOffice(repo.root, launchd);
    assert.equal(bootouts.length, 1);
    assert.equal(calls.filter(call => call.startsWith("bootout") && call.includes(label)).length, 1);
  } finally {
    await closeServer?.();
    await rm(join(repo.root, ".."), {recursive: true, force: true});
  }
});
