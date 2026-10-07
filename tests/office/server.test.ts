import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { claimOffice, createOfficeServer, ensureOffice, officeRecordPath, readLiveOffice, releaseOffice,
  OFFICE_IDLE_MS } from "../../runtime/src/office/server.js";
import type { OfficeSnapshot } from "../../runtime/src/office/snapshot.js";

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
