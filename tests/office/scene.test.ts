import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import test from "node:test";

import { buildOfficeSnapshot, type OfficeSnapshot } from "../../runtime/src/office/snapshot.js";
import { sceneModel } from "../../runtime/src/office/scene.js";
import { officePage, PALETTE, SPRITES } from "../../runtime/src/office/page.js";
import { NOW, runFixture } from "./fixture.js";
const files = (n: number) => ({files: n, insertions: n, deletions: 0, paths: Array.from({length: n}, (_, i) => `src/f${i}.ts`), recent: "src/f0.ts"});

function snapshot(): OfficeSnapshot {
  return buildOfficeSnapshot({now: NOW, runs: [runFixture()],
    worktrees: [
      {name: "coord", path: "/repo/.worktrees/coord", branch: "b1", sessionId: "owner", runId: "run-office-fixture", diff: files(12)},
      {name: "child", path: "/repo/.worktrees/child", branch: "b2", sessionId: "s2", runId: "run-office-fixture", diff: files(3)},
      {name: "desk-1", path: "/repo/.worktrees/desk-1", branch: "b3", sessionId: "s3", diff: files(1)}],
    reviews: [{slot: 0, since: "2026-10-07T00:50:00.000Z", taskId: "root", root: "/repo/.worktrees/coord"},
      {slot: 1, since: "2026-10-07T00:55:00.000Z", taskId: "x", root: null}]});
}

test("a snapshot maps to a scene: phase zones, paper stacks, lit books, clock and the question mark", () => {
  const model = sceneModel(snapshot());
  assert.equal(model.floors.length, 2);
  const [floor, lobby] = model.floors;
  assert.equal(floor!.kind, "run");
  assert.equal(lobby!.kind, "lobby");
  assert.equal(lobby!.top, 9);
  const coordinator = floor!.actors.find(a => a.kind === "coordinator")!;
  const bench = floor!.props.find(p => p.kind === "bench")!;
  assert.deepEqual([coordinator.x, coordinator.y], [15, 4], "verifying coordinator stands at the lab bench");
  assert.ok(Math.abs(coordinator.x - bench.x) <= 2 && coordinator.y === bench.y + 2);
  assert.equal(coordinator.alert, true, "an unanswered question puts ! over the coordinator");
  const worker = floor!.actors.find(a => a.kind === "worker")!;
  const workerDesk = floor!.props.find(p => p.key === "run-office-fixture:desk:w1")!;
  assert.deepEqual([worker.x, worker.y], [workerDesk.x, workerDesk.y + 1], "unknown phase sits at its own desk");
  assert.equal(worker.alert, false);
  assert.equal(floor!.papers["run-office-fixture:desk:coordinator-run-office-fixture"], 8, "paper stack is capped");
  assert.equal(floor!.papers["run-office-fixture:desk:w1"], 3);
  assert.deepEqual(floor!.books, {lit: 2, total: 6});
  assert.ok(Math.abs(floor!.clock - 40 / 60) < 1e-9);
  assert.deepEqual(floor!.actors.filter(a => a.kind === "reviewer").map(a => a.label), ["reviewer 0"]);
  assert.deepEqual(lobby!.actors.map(a => a.label), ["desk-1", "reviewer 1"]);
  assert.equal(lobby!.papers["lobby:desk:desk-1"], 1);
  assert.ok(model.dialogue.some(line => line.includes("waiting for your answer — Which port?")));
  assert.ok(model.dialogue.some(line => line.includes("editing src/f0.ts")));
});

test("each phase sends a character to its zone", () => {
  const base = snapshot();
  const zones: Record<string, string> = {planning: "whiteboard", verifying: "bench", reviewing: "table", integrating: "door"};
  for (const [phase, prop] of Object.entries(zones)) {
    const run = base.runs[0]!;
    const moved = {...base, runs: [{...run, agents: [{...run.agents[0]!, phase: phase as "planning"}]}]};
    const floor = sceneModel(moved).floors[0]!;
    const actor = floor.actors[0]!, zone = floor.props.find(p => p.kind === prop)!;
    assert.ok(Math.abs(actor.x - zone.x) <= 2 && actor.y > zone.y && actor.y - zone.y <= 3, `${phase} -> ${prop}`);
  }
});

test("an empty building is a quiet lobby", () => {
  const model = sceneModel({generatedAt: "x", runs: [], lobby: [], reviews: []});
  assert.equal(model.floors.length, 1);
  assert.deepEqual(model.dialogue, ["The office is quiet. No agent is at work."]);
});

test("the page embeds the tested scene function and draws only in-code sprites", async () => {
  const page = officePage("n0nce");
  assert.ok(page.includes(sceneModel.toString()));
  assert.doesNotMatch(page, /<img|url\(|src=|href=|\.png|\.gif|@import/u);
  assert.equal((page.match(/<script/gu) ?? []).length, 1);
  assert.equal(PALETTE.length, 16);
  for (const [name, rows] of Object.entries(SPRITES)) {
    for (const row of rows) assert.match(row, /^[0-9a-fS.]+$/u, name);
    assert.equal(new Set(rows.map(r => r.length)).size, 1, `${name} rows share one width`);
  }
  const embedded = new Function(`return (${sceneModel.toString()})`)() as typeof sceneModel;
  assert.deepEqual(embedded(snapshot()), sceneModel(snapshot()));
  const assets = (await readdir("runtime/src/office")).filter(f => !f.endsWith(".ts"));
  assert.deepEqual(assets, []);
});
