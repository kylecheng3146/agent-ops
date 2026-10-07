import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { claimOffice, createOfficeServer, ensureOffice, officeRecordPath, readLiveOffice, releaseOffice,
  OFFICE_IDLE_MS } from "../../runtime/src/office/server.js";
import {buildOfficeSnapshot, type OfficeSessionView, type OfficeSnapshot} from "../../runtime/src/office/snapshot.js";

const empty: OfficeSnapshot = {generatedAt: "2026-10-07T00:00:00.000Z", runs: [], lobby: [], reviews: []};
const withRun = (status: string): OfficeSnapshot => ({...empty, runs: [{runId: "run-a", title: "A", status, phase: "implementing",
  budget: {limitMs: 1, usedMs: 0, remainingMs: 1}, questions: [], agents: [], reviewers: [], commands: []}]});

function call(port: number, path: string, options: {method?: string; host?: string} = {}):
  Promise<{status: number; body: string; headers: Record<string, string | string[] | undefined>}> {
  return new Promise((resolve, reject) => {
    const req = request({host: "127.0.0.1", port, path, method: options.method ?? "GET",
      headers: {host: options.host ?? `127.0.0.1:${port}`}}, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({status: res.statusCode ?? 0, body, headers: res.headers}));
    });
    req.on("error", reject);
    req.end();
  });
}

test("the server answers only GET, with the token, on the loopback Host", async () => {
  const office = createOfficeServer({snapshot: async () => withRun("active"), token: "secret-token", onIdle: () => {}});
  const port = await office.listen();
  try {
    const page = await call(port, "/?token=secret-token");
    assert.equal(page.status, 200);
    assert.match(String(page.headers["content-type"]), /text\/html/u);
    const nonce = /script-src 'nonce-([^']+)'/u.exec(String(page.headers["content-security-policy"]))?.[1];
    assert.ok(nonce !== undefined);
    assert.ok(page.body.includes(`<script nonce="${nonce}">`));
    assert.equal(page.headers["referrer-policy"], "no-referrer");
    const snapshot = await call(port, "/snapshot.json?token=secret-token");
    assert.equal(snapshot.status, 200);
    assert.equal(JSON.parse(snapshot.body).runs[0].runId, "run-a");
    assert.equal((await call(port, "/snapshot.json")).status, 403);
    assert.equal((await call(port, "/snapshot.json?token=secret-tokem")).status, 403);
    assert.equal((await call(port, "/?token=secret-token", {host: `evil.example:${port}`})).status, 421);
    assert.equal((await call(port, "/?token=secret-token", {host: `localhost:${port}`})).status, 421);
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const refused = await call(port, "/snapshot.json?token=secret-token", {method});
      assert.equal(refused.status, 405, method);
      assert.equal(refused.headers.allow, "GET");
    }
    assert.equal(office.server.address() !== null && typeof office.server.address() === "object" &&
      (office.server.address() as {address: string}).address, "127.0.0.1");
  } finally {
    await office.close();
  }
});

test("the server exits after ten minutes with no active run, using an injected clock", async () => {
  let now = 0, idle = 0, current = withRun("active");
  const office = createOfficeServer({snapshot: async () => current, now: () => now, onIdle: () => { idle += 1; }});
  now = OFFICE_IDLE_MS * 2;
  await office.tick();
  assert.equal(idle, 0, "an active run keeps the office open");
  current = withRun("complete");
  now += OFFICE_IDLE_MS - 1;
  await office.tick();
  assert.equal(idle, 0);
  now += 1;
  await office.tick();
  assert.equal(idle, 1);
  await office.tick();
  assert.equal(idle, 1, "idle fires once");
  const fresh = createOfficeServer({snapshot: async () => empty, now: () => now, onIdle: () => { idle += 1; }});
  now += OFFICE_IDLE_MS;
  await fresh.tick();
  assert.equal(idle, 2, "an office started without any run also closes after the idle window");
});

test("an ordinary session keeps the server alive while its lobby desk is present", async () => {
  let now = 0, idle = 0;
  const office = createOfficeServer({
    snapshot: async () => ({...empty, lobby: [{name: "s", branch: "main", sessionId: "s", diff: {files: 0, insertions: 0, deletions: 0, paths: [], recent: null}, narration: "implementing", commands: [], status: "active"}]}),
    now: () => now,
    idleMs: OFFICE_IDLE_MS,
    onIdle: () => { idle += 1; }
  });
  now = OFFICE_IDLE_MS * 2;
  await office.tick();
  assert.equal(idle, 0);
  await office.close();
});

test("unfinished task state does not keep a stopped or expired session alive", async () => {
  let now = 0, idle = 0, presence: "active" | "idle" | null = "active";
  const session: OfficeSessionView = {schemaVersion: 1, sessionId: "s", harness: "codex", root: "/repo",
    firstSeenAt: "2026-10-07T00:00:00.000Z", lastSeenAt: "2026-10-07T00:00:00.000Z", status: "active", taskStatus: "active"};
  const snapshot = (): OfficeSnapshot => buildOfficeSnapshot({runs: [], reviews: [], now,
    worktrees: [{name: "s", path: "/repo/.worktrees/s", branch: "work", sessionId: "s", status: "active",
      diff: {files: 0, insertions: 0, deletions: 0, paths: [], recent: null}}],
    sessions: presence === null ? [] : [{...session, status: presence}]});
  const office = createOfficeServer({snapshot: async () => snapshot(), now: () => now, onIdle: () => {idle++;}});
  now = OFFICE_IDLE_MS * 2;
  await office.tick();
  assert.equal(idle, 0, "hook presence keeps the unfinished task visible and live");
  presence = "idle";
  assert.equal(snapshot().lobby[0]!.status, "active", "task status remains independently visible");
  now += OFFICE_IDLE_MS;
  await office.tick();
  assert.equal(idle, 1, "Stop allows shutdown even when the attached task is unfinished");
  await office.close();
  presence = null;
  const expired = createOfficeServer({snapshot: async () => snapshot(), now: () => now, onIdle: () => {idle++;}});
  now += OFFICE_IDLE_MS;
  await expired.tick();
  assert.equal(idle, 2, "an expired registry record cannot be revived by stored task status");
  await expired.close();
});

test("one server per repository: the record is reused, never duplicated, and released", async () => {
  const commonDir = await mkdtemp(join(tmpdir(), "agent-ops-office-"));
  const first = createOfficeServer({snapshot: async () => empty, onIdle: () => {}});
  const second = createOfficeServer({snapshot: async () => empty, onIdle: () => {}});
  try {
    assert.equal(await readLiveOffice(commonDir), null);
    const record = await claimOffice(commonDir, first);
    assert.ok(record !== null);
    assert.deepEqual(JSON.parse(await readFile(officeRecordPath(commonDir), "utf8")), record);
    assert.equal((await readLiveOffice(commonDir))?.token, first.token);
    assert.equal(await claimOffice(commonDir, second), null);
    assert.equal(second.server.listening, false);
    let started = 0;
    const url = await ensureOffice(commonDir, async () => { started += 1; });
    assert.equal(started, 0);
    assert.equal(url, `http://127.0.0.1:${record.port}/?token=${first.token}`);
    await releaseOffice(commonDir, record);
    assert.equal(await readLiveOffice(commonDir), null);
  } finally {
    await first.close();
    await rm(commonDir, {recursive: true, force: true});
  }
});

test("concurrent startup claims one server before any caller opens a page", async () => {
  const commonDir = await mkdtemp(join(tmpdir(), "agent-ops-office-start-"));
  const first = createOfficeServer({snapshot: async () => empty, onIdle: () => {}});
  const second = createOfficeServer({snapshot: async () => empty, onIdle: () => {}});
  let starts = 0;
  try {
    const [left, right] = await Promise.all([
      ensureOffice(commonDir, async () => { starts += 1; assert.ok(await claimOffice(commonDir, first) !== null); }, {pollMs: 5}),
      ensureOffice(commonDir, async () => { starts += 1; assert.ok(await claimOffice(commonDir, second) !== null); }, {pollMs: 5})
    ]);
    assert.equal(starts, 1);
    assert.equal(left, right);
  } finally {
    await first.close();
    await second.close();
    await rm(commonDir, {recursive: true, force: true});
  }
});

test("a stale record is not reused and a fresh server is started", async () => {
  const commonDir = await mkdtemp(join(tmpdir(), "agent-ops-office-"));
  const office = createOfficeServer({snapshot: async () => empty, onIdle: () => {}});
  try {
    const record = await claimOffice(commonDir, office);
    await office.close();
    assert.equal(await readLiveOffice(commonDir), null, "a closed server does not answer");
    const next = createOfficeServer({snapshot: async () => empty, onIdle: () => {}});
    try {
      const url = await ensureOffice(commonDir, async () => { await claimOffice(commonDir, next); }, {pollMs: 10});
      assert.notEqual(url, `http://127.0.0.1:${record!.port}/?token=${office.token}`);
      assert.ok(url.endsWith(next.token));
    } finally {
      await next.close();
    }
  } finally {
    await rm(commonDir, {recursive: true, force: true});
  }
});
