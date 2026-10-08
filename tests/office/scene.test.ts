import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import test from "node:test";

import { buildOfficeSnapshot, mergeOfficeSnapshots, type OfficeSnapshot } from "../../runtime/src/office/snapshot.js";
import { sceneModel } from "../../runtime/src/office/scene.js";
import { officePage, PALETTE, SPRITES } from "../../runtime/src/office/page.js";
import { NOW, runFixture } from "./fixture.js";

const files = (n: number) => ({files: n, insertions: n, deletions: 0, paths: Array.from({length: n}, (_, i) => `src/f${i}.ts`), recent: "src/f0.ts"});

function snapshot(): OfficeSnapshot {
  const base = buildOfficeSnapshot({now: NOW, runs: [runFixture()],
    worktrees: [
      {name: "coord", path: "/repo/.worktrees/coord", branch: "b1", sessionId: "owner", runId: "run-office-fixture", diff: files(12)},
      {name: "child", path: "/repo/.worktrees/child", branch: "b2", sessionId: "s2", runId: "run-office-fixture", diff: files(3)},
      {name: "desk-0", path: "/repo/.worktrees/desk-0", branch: "b3", sessionId: "s3", diff: files(1)}],
    reviews: [{slot: 0, since: "2026-10-07T00:50:00.000Z", taskId: "root", root: "/repo/.worktrees/coord"},
      {slot: 1, since: "2026-10-07T00:55:00.000Z", taskId: "x", root: null}]});
  const desks = Array.from({length: 9}, (_, index) => ({...base.lobby[0]!, name: "desk-" + index, sessionId: "s" + (index + 3), branch: "b" + (index + 3)}));
  const richDesk = {...desks[0]!, phase: "verifying" as const, status: "checking", taskId: "desk-task", progress: {verify: "PASS" as const, review: null, passed: 2, total: 4},
    questions: [{questionId: "desk-q", prompt: "Choose a port"}], completedAt: null, host: "codex"};
  desks[0] = richDesk;
  return {...base, lobby: desks};
}

test("every run and ordinary session desk becomes its own room with all actors", () => {
  const model = sceneModel(snapshot());
  assert.equal(model.floors.filter(f => f.kind === "run").length, 1);
  assert.equal(model.floors.filter(f => f.kind === "desk").length, 9);
  assert.equal(model.floors.filter(f => f.kind === "review").length, 1);
  assert.ok(model.floors.every(f => f.kind !== ("lobby" as never)));
  assert.equal(new Set(model.floors.map(f => f.key)).size, model.floors.length);
  const run = model.floors.find(f => f.kind === "run")!;
  assert.deepEqual(run.phaseAreas.map(a => a.phase), ["planning", "implementing", "verifying", "reviewing", "integrating"]);
  assert.equal(run.actors.length, 3, "two agents and the unclaimed run reviewer remain visible");
  assert.equal(run.board.pending, 1);
  assert.equal(run.actors.find(a => a.kind === "coordinator")!.alert, true);
  assert.ok(run.actors.every(a => a.label.length <= 18 && a.status.length > 0));
  const desk = model.floors.find(f => f.kind === "desk")!;
  assert.equal(desk.phase, "verifying");
  assert.equal(desk.board.taskId, "desk-task");
  assert.equal(desk.board.pending, 1);
  assert.equal(desk.actors[0]!.alert, true);
  assert.equal(desk.actors[0]!.taskId, "desk-task");
});

test("every room exposes board and actor metadata for its work list", () => {
  const model = sceneModel(snapshot());
  for (const floor of model.floors) {
    const board = floor.props.find(prop => prop.kind === "whiteboard");
    assert.ok(board && board.phase === "planning", `${floor.key} has a planning whiteboard`);
    assert.ok(typeof floor.board.taskId === "string" && typeof floor.board.status === "string");
    for (const actor of floor.actors) {
      assert.ok(actor.label.length > 0 && actor.status.length > 0 && actor.narration.length > 0);
      assert.ok(actor.phase.length > 0 && actor.taskId.length > 0);
      assert.equal(typeof actor.questionCount, "number");
    }
  }
  const run = model.floors.find(floor => floor.kind === "run")!;
  assert.deepEqual(run.questions.map(question => question.prompt), ["Which port?"]);
  assert.ok(run.actors.some(actor => actor.questionCount === run.questions.length));
  const desk = model.floors.find(floor => floor.kind === "desk")!;
  assert.equal(desk.questions[0]!.prompt, "Choose a port");
  assert.equal(desk.actors[0]!.questionCount, 1);
});

test("phase changes move actors into each of the five in-scene areas", () => {
  const base = snapshot();
  const zones: Record<string, string> = {planning: "planning", implementing: "implementing", verifying: "verifying", reviewing: "reviewing", integrating: "integrating"};
  for (const phase of Object.keys(zones)) {
    const run = base.runs[0]!;
    const moved = {...base, runs: [{...run, agents: [{...run.agents[0]!, phase: phase as "planning"}]}]};
    const floor = sceneModel(moved).floors[0]!;
    const actor = floor.actors[0]!, area = floor.phaseAreas.find(a => a.phase === phase)!;
    assert.equal(actor.phase, phase);
    assert.ok(actor.x >= area.x && actor.x < area.x + area.width && actor.y >= area.y && actor.y < area.y + area.height, `${phase} -> ${area.label}`);
  }
});

test("extra workstations keep exact actor ids and unknown phases stay unassigned", () => {
  const base = snapshot();
  const run = base.runs[0]!;
  const agents = [
    {...run.agents[0]!, id: "shared-worker-name-alpha", phase: "implementing" as const},
    {...run.agents[1]!, id: "shared-worker-name-beta", phase: "implementing" as const}
  ];
  const model = sceneModel({...base, runs: [{...run, agents}], lobby: []});
  const floor = model.floors[0]!;
  assert.ok(floor.props.some(prop => prop.key === "run-office-fixture:desk:shared-worker-name-beta"));
  assert.equal(floor.actors.find(actor => actor.id === "shared-worker-name-beta")!.key, "run-office-fixture:shared-worker-name-beta");
  const legacyDesk = {...base.lobby[0]!};
  delete (legacyDesk as {phase?: unknown}).phase;
  const unknown = sceneModel({...base, lobby: [legacyDesk]}).floors.find(candidate => candidate.kind === "desk")!;
  assert.equal(unknown.phase, "unknown");
  assert.equal(unknown.actors[0]!.phase, "unknown");
});

test("overview bounds include every room and retain completion state", () => {
  const base = snapshot();
  const completedRun = {...base.runs[0]!, completedAt: "2026-10-07T00:59:00.000Z"};
  const model = sceneModel({...base, runs: [completedRun]});
  assert.equal(model.floors[0]!.completedAt, "2026-10-07T00:59:00.000Z");
  assert.ok(model.floors.every(f => f.overview.width > 0 && f.overview.height > 0));
  assert.ok(model.floors.every(f => f.overview.x + f.overview.width <= model.cols && f.overview.y + f.overview.height <= model.rows));
  assert.ok(model.dialogue.some(line => line.includes("waiting for your answer")));
});

test("sibling worktrees keep stable room identities and crowded phases stay inside their areas", () => {
  const base = snapshot();
  const run = base.runs[0]!;
  const agents = Array.from({length: 48}, (_, index) => ({...run.agents[0]!, id: `worker-${index}`, role: "worker" as const, phase: index % 2 ? "planning" as const : "reviewing" as const}));
  const lobby = [
    {...base.lobby[0]!, name: "sibling-a", sessionId: "same-session", branch: "branch-a"},
    {...base.lobby[0]!, name: "sibling-b", sessionId: "same-session", branch: "branch-b"},
    ...Array.from({length: 72}, (_, index) => ({...base.lobby[0]!, name: `desk-${index}`, sessionId: `session-${index}`, branch: `branch-${index}`}))
  ];
  const model = sceneModel({...base, runs: [{...run, agents}], lobby, reviews: []});
  const deskKeys = model.floors.filter(f => f.kind === "desk").map(f => f.key);
  assert.equal(new Set(deskKeys).size, deskKeys.length);
  const crowded = model.floors.find(f => f.kind === "run")!;
  for (const actor of crowded.actors) {
    const area = crowded.phaseAreas.find(candidate => candidate.phase === actor.phase) ?? crowded.phaseAreas.find(candidate => candidate.phase === "implementing")!;
    assert.ok(actor.x >= area.x && actor.x < area.x + area.width && actor.y >= area.y && actor.y < area.y + area.height, actor.id);
  }
  assert.ok(model.floors.every(f => f.overview.x >= 0 && f.overview.y >= 0 && f.overview.x + f.overview.width <= model.cols + 1e-6 && f.overview.y + f.overview.height <= model.rows + 1e-6));
});

test("equal room names in two repositories stay two rooms, grouped and labelled by repository", () => {
  const one = snapshot();
  const merged = mergeOfficeSnapshots([{repo: "shop", snapshot: one}, {repo: "api", snapshot: one}], NOW);
  const model = sceneModel(merged);
  assert.equal(model.floors.length, sceneModel(one).floors.length * 2);
  assert.equal(new Set(model.floors.map(floor => floor.key)).size, model.floors.length);
  assert.deepEqual([...new Set(model.floors.map(floor => floor.repo))], ["api", "shop"]);
  assert.ok(model.floors.every(floor => floor.title.startsWith(floor.repo + " · ")));
  assert.ok(sceneModel(one).floors.every(floor => floor.repo === null));
  const embedded = new Function(`return (${sceneModel.toString()})`)() as typeof sceneModel;
  assert.deepEqual(embedded(merged), model);
});

test("an empty building has no fake lobby room", () => {
  const model = sceneModel({generatedAt: "x", runs: [], lobby: [], reviews: []});
  assert.equal(model.floors.length, 0);
  assert.deepEqual(model.dialogue, ["The office is quiet. No agent is at work."]);
});

test("room identities and run sources survive truncation and repository scoping", () => {
  const base = snapshot(), title = "same-prefix-long-session-name-but-a-distinct-full-title";
  const model = sceneModel({...base, runs: [{...base.runs[0]!, title, repo: "shop"}], lobby: []});
  const run = model.floors.find(floor => floor.kind === "run")!;
  assert.equal(run.title, "shop · " + title);
  assert.equal(run.sourceIndex, 0);
});

test("a team cannot claim PASS while another member's proof is missing", () => {
  const base = snapshot(), run = base.runs[0]!;
  const progress = {passed: 2, total: 2, verify: "PASS" as const, review: "PASS" as const};
  const agents = run.agents.map((actor, index) => ({...actor, progress: index === 0 ? progress : null}));
  const board = (actors: typeof agents) => sceneModel({...base, runs: [{...run, agents: actors}], lobby: []}).floors[0]!.board;
  assert.equal(board(agents).verify, "pending");
  assert.equal(board(agents).review, "pending");
  const allPassed = agents.map(actor => ({...actor, progress}));
  assert.equal(board(allPassed).verify, "PASS");
  assert.equal(board(allPassed).review, "PASS");
  const failed = {...agents[0]!, progress: {...progress, verify: "FAIL" as const, review: "FAIL" as const}};
  assert.equal(sceneModel({...base, runs: [{...run, agents: [failed, ...agents.slice(1)]}]}).floors[0]!.board.verify, "FAIL");
  assert.equal(sceneModel({...base, runs: [{...run, agents: []}]}).floors[0]!.board.review, "pending");
});

test("the inline page embeds the tested scene, fixed viewport controls and safe paging", async () => {
  const page = officePage("n0nce");
  assert.ok(page.includes(sceneModel.toString()));
  assert.match(page, /id="office" tabindex="0"/u);
  assert.match(page, /id="back"/u);
  assert.match(page, /id="recent"/u);
  assert.match(page, /<select id="repo-filter" hidden><\/select>/u);
  assert.match(page, /id="language"/u);
  assert.match(page, /prefers-reduced-motion/u);
  assert.match(page, /localStorage/u);
  assert.match(page, /devicePixelRatio/u);
  assert.match(page, /imageSmoothingEnabled/u);
  assert.match(page, /Supervisor/u);
  assert.match(page, /ArrowLeft/u);
  assert.match(page, /pageItems/u);
  assert.match(page, /textContent/u);
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
