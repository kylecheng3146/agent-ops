#!/usr/bin/env node
import assert from "node:assert/strict";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {setTimeout as delay} from "node:timers/promises";
import {createLaunchdDescriptor, LaunchdController, readBootIdentity, readGuiLoginIdentity} from "../dist/runtime/src/run/macOS.js";

if (process.platform !== "darwin") throw new Error("This opt-in probe requires a macOS GUI login.");
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--out") throw new Error("Usage: node scripts/probe-background-run.mjs --out <report.json>");
const root = await mkdtemp(join(tmpdir(), "agent-ops-background-probe-"));
const controller = new LaunchdController();
const child = join(root, "heartbeat.mjs");
const events = join(root, "events.jsonl");
await writeFile(child, `import {appendFileSync} from "node:fs";
const path = process.argv[2];
appendFileSync(path, JSON.stringify({event:"started",pid:process.pid,at:Date.now()})+"\\n",{mode:0o600});
setInterval(()=>appendFileSync(path,JSON.stringify({event:"heartbeat",pid:process.pid,at:Date.now()})+"\\n"),200);
`, {mode: 0o600});
const descriptor = createLaunchdDescriptor({runId: "probe-" + Date.now(), workerId: "supervisor", privateDirectory: root,
  command: process.execPath, args: [child, events], cwd: root, pathEnvironment: process.env.PATH});
async function records() {
  try {return (await readFile(events, "utf8")).trim().split("\n").map(line => JSON.parse(line));}
  catch (cause) {if (cause.code === "ENOENT") return []; throw cause;}
}
async function until(predicate) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {const rows = await records(); if (predicate(rows)) return rows; await delay(200);}
  throw new Error("Background observation timed out.");
}
let loaded = false;
try {
  await controller.writeDescriptor(descriptor);
  await controller.bootstrap(descriptor); loaded = true;
  const first = await until(rows => rows.filter(row => row.event === "heartbeat").length >= 3);
  const firstPid = first.find(row => row.event === "started").pid;
  assert.notEqual(firstPid, process.pid);
  process.kill(firstPid, "SIGKILL");
  const restarted = await until(rows => rows.filter(row => row.event === "started").length >= 2);
  const secondPid = restarted.filter(row => row.event === "started").at(-1).pid;
  assert.notEqual(secondPid, firstPid);
  await controller.disableRestart(descriptor, "probe stopped");
  // launchctl disable affects future loading; bootout also removes the loaded
  // KeepAlive job. An explicit Stop needs both effects for a dead supervisor.
  await controller.bootout(descriptor); loaded = false;
  const count = (await records()).filter(row => row.event === "started").length;
  await delay(1500);
  assert.equal((await records()).filter(row => row.event === "started").length, count);
  const report = {platform: process.platform, architecture: process.arch, node: process.version,
    bootIdentity: await readBootIdentity(), loginIdentity: await readGuiLoginIdentity(),
    backgroundHeartbeat: true, crashRestart: true, disabledAndBootedOut: true, noFurtherRestart: true,
    nativeModelUsed: false, completionCountsAsProof: false};
  await writeFile(resolve(args[1]), JSON.stringify(report, null, 2) + "\n", {mode: 0o600});
  process.stdout.write("macOS background heartbeat, crash restart and controlled stop passed.\n");
} finally {
  if (loaded) {await controller.disableRestart(descriptor, "probe cleanup").catch(() => {}); await controller.bootout(descriptor).catch(() => {});}
  await controller.enableRestart(descriptor).catch(() => {});
  await rm(root, {recursive: true, force: true});
}
