import assert from "node:assert/strict";
import {runInNewContext} from "node:vm";
import test from "node:test";

import type {OfficeSnapshot} from "../../runtime/src/office/snapshot.js";
import {officePage} from "../../runtime/src/office/page.js";

type Call = {name: string; args: unknown[]};

class FakeElement {
  readonly id: string;
  readonly tagName: string;
  readonly children: FakeElement[] = [];
  readonly style: Record<string, string> = {};
  readonly events = new Map<string, (event?: unknown) => void>();
  readonly attrs = new Map<string, string>();
  private content = "";
  private context: object | null = null;
  hidden = false;
  className = "";
  disabled = false;
  value = "";
  width = 0;
  height = 0;
  inert = false;
  type = "";
  constructor(readonly calls: Call[], id = "", tagName = "DIV") { this.id = id; this.tagName = tagName.toUpperCase(); }
  get textContent(): string { return this.content; }
  set textContent(value: string) { this.content = value; this.children.length = 0; }
  appendChild(child: FakeElement): FakeElement { this.children.push(child); return child; }
  addEventListener(name: string, handler: (event?: unknown) => void): void { this.events.set(name, handler); }
  setAttribute(name: string, value: string): void { this.attrs.set(name, value); }
  getAttribute(name: string): string | null { return this.attrs.get(name) ?? null; }
  removeAttribute(name: string): void { this.attrs.delete(name); }
  focus(): void { activeElement = this; }
  click(event: unknown = {}): void { this.events.get("click")?.(event); }
  getContext(): object {
    const owner = this;
    this.context ??= new Proxy({}, {get: (target: Record<string | symbol, unknown>, key) => key in target ? target[key] : (...args: unknown[]) => { this.calls.push({name: String(key), args: [owner, ...args]}); }});
    return this.context;
  }
  getBoundingClientRect(): {left: number; top: number; width: number; height: number} { return {left: 0, top: 0, width: this.width, height: this.height}; }
  querySelectorAll(selector: string): FakeElement[] {
    const result: FakeElement[] = [];
    const visit = (node: FakeElement) => { for (const child of node.children) { if (selector.startsWith("button") && child.tagName === "BUTTON" && !child.disabled) result.push(child); visit(child); } };
    visit(this); return result;
  }
}

let activeElement: FakeElement | null = null;

function clientScript(): string { return officePage("nonce").match(/<script[^>]*>([\s\S]*)<\/script>/u)![1]!; }
function treeText(node: FakeElement): string { return node.textContent + node.children.map(treeText).join(""); }
function find(node: FakeElement, test: (n: FakeElement) => boolean): FakeElement[] { return node.children.flatMap(child => [...(test(child) ? [child] : []), ...find(child, test)]); }

type Figure = {actor: {key: string; id: string}; x: number; y: number; feet: {x: number; y: number}};
type Room = {id: string; x: number; y: number; slots: {x: number; y: number; feet: {x: number; y: number}}[]};
interface Vm {
  mode: string; selectedKey: string; frame: number; scale: number; reducedMotion: boolean; detailPage: number;
  viewer: {x: number; y: number; path: unknown[]; dir: string};
  people: Record<string, {x: number; y: number; path: unknown[]; slot: {feet: {x: number; y: number}}}>;
  doorFrames: Record<string, number>; images: Record<string, FakeElement>; lastFigures: Figure[];
  LAYOUT: {rooms: Room[]; board: {x: number; y: number}; spawn: {x: number; y: number}};
  GRID: {cols: number; rows: number; free: number[]};
  model: {floors: {key: string; actors: {key: string; id: string}[]}[]};
  notePosition: (index: number) => {x: number; y: number};
  render: () => void; tick: () => void; poll: () => void; orderedRooms: () => {key: string}[];
}

const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const desk = (name: string, extra: Record<string, unknown> = {}) => ({name, branch: "main", sessionId: "s-" + name, narration: `editing src/${name}.ts`,
  diff: {files: 1, insertions: 1, deletions: 0, paths: [`src/${name}.ts`], recent: `src/${name}.ts`}, commands: [`agent-ops task status --session s-${name}`], ...extra});

async function boot(initial: OfficeSnapshot, {reduced = false, language = "en-US", stored = {} as Record<string, string>} = {}) {
  const calls: Call[] = [];
  const ids = ["app", "wrap", "office", "status", "crumb", "back", "recent", "repo-filter", "language", "live", "work-list", "work-heading", "work-summary", "overview", "room-view", "hud", "labels", "workspace", "panel-toggle"];
  const elements = new Map(ids.map(id => [id, new FakeElement(calls, id, id === "office" ? "canvas" : "div")]));
  elements.get("status")!.hidden = true;
  elements.get("room-view")!.hidden = true;
  const storage = new Map<string, string>(Object.entries(stored));
  const state = {snapshot: initial, offline: false, copied: ""};
  const document = {cookie: "", get activeElement() { return activeElement; }, getElementById: (id: string) => elements.get(id)!,
    createElement: (tag = "div") => new FakeElement(calls, "", tag), addEventListener: () => {}, documentElement: {lang: ""}};
  const context = {
    document,
    window: {devicePixelRatio: 2, innerWidth: 1440, innerHeight: 900, matchMedia: () => ({matches: reduced}), addEventListener: () => {}},
    navigator: {language, clipboard: {writeText: async (value: string) => {state.copied = value;}}},
    localStorage: {getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value)},
    fetch: async () => {if (state.offline) throw new Error("offline"); return {ok: true, json: async () => state.snapshot};},
    location: {search: ""}, requestAnimationFrame: () => 0, setInterval: () => 0, console, Math, Promise, JSON
  };
  runInNewContext(clientScript(), context);
  await settle();
  const vm = context as unknown as Vm;
  const poll = async (next?: OfficeSnapshot) => { if (next) state.snapshot = next; vm.poll(); await settle(); };
  return {vm, elements, calls, state, document, poll, storage};
}

test("the overview groups rooms by repository, puts rooms that need an answer first, and opens rooms at one whole-number scale", async () => {
  const snapshot: OfficeSnapshot = {generatedAt: "x", runs: [], reviews: [], lobby: [
    desk("quiet-shop", {repo: "shop", status: "idle"}),
    desk("busy-shop", {repo: "shop", status: "active", phase: "implementing"}),
    desk("asking-shop", {repo: "shop", status: "active", questions: [{questionId: "q1", prompt: "Which tax?"}]}),
    desk("api-one", {repo: "api", status: "active"})
  ]};
  const {vm, elements} = await boot(snapshot);
  const overview = elements.get("overview")!;
  const sections = overview.children;
  assert.deepEqual(sections.map(section => section.getAttribute("data-repo")), ["api", "shop"], "one section per repository, in name order");
  assert.deepEqual(sections.map(section => treeText(section.children[0]!)), ["api", "shop! 1"], "each header names its repository and open questions");
  const cards = (section: FakeElement) => find(section, node => node.tagName === "BUTTON");
  assert.deepEqual(cards(sections[1]!).map(card => card.getAttribute("data-key")!.split(":").at(-1)), ["asking-shop", "busy-shop", "quiet-shop"], "questions first, then active, then idle");
  const canvases = find(overview, node => node.tagName === "CANVAS");
  assert.equal(canvases.length, 4);
  assert.equal(new Set(canvases.map(c => `${c.width}x${c.height}@${c.style.width}x${c.style.height}`)).size, 1, "every card shares one scale");
  assert.ok(find(overview, node => node.className === "card-title").every(title => /^\d\. /u.test(title.textContent)), "cards are numbered for the keyboard");

  cards(sections[1]!)[0]!.click();
  assert.equal(vm.mode, "room");
  assert.ok(vm.selectedKey.endsWith("asking-shop"));
  const canvas = elements.get("office")!;
  assert.ok(Math.abs(vm.scale - (1440 - 32) / 576) < 1e-9, "the room fills the available width of a 1440x900 window");
  assert.equal(canvas.style.width, Math.round(576 * vm.scale) + "px");
  assert.ok(Math.abs(canvas.width / canvas.height - 576 / 320) < 0.01, "the room keeps its 9:5 shape");
  elements.get("back")!.click();
  assert.equal(vm.mode, "overview");
  overview.events.get("keydown")!({key: "3", preventDefault: () => {}});
  assert.equal(vm.mode, "room");
  assert.equal(vm.selectedKey, vm.orderedRooms()[2]!.key, "number keys follow the on-screen order");
});

test("a room renders with whole pixels only, no canvas text, and a whiteboard drawn from its criteria", async () => {
  const criteria = [
    {id: "totals", description: "Totals", status: "PASS", finishedAt: null, failureClass: null, exitCode: null},
    {id: "locale", description: "Locale", status: "FAIL", finishedAt: null, failureClass: "exit-code", exitCode: 1},
    {id: "snapshots", description: "Snapshots", status: null, finishedAt: null, failureClass: null, exitCode: null}
  ];
  const {vm, elements, calls} = await boot({generatedAt: "x", runs: [], reviews: [], lobby: [desk("receipt", {phase: "planning", criteria})]});
  find(elements.get("overview")!, node => node.tagName === "BUTTON")[0]!.click();
  calls.length = 0;
  vm.render();
  const numeric = calls.filter(call => call.name === "fillRect" || call.name === "drawImage");
  assert.ok(numeric.length > 50);
  for (const call of numeric) for (const arg of call.args.slice(1)) if (typeof arg === "number") assert.ok(Number.isInteger(arg), `${call.name} uses whole pixels: ${call.args.slice(1).join(",")}`);
  assert.equal(calls.filter(call => call.name === "fillText" || call.name === "strokeText").length, 0, "the canvas draws no text");
  const canvas = elements.get("office")!;
  assert.deepEqual([canvas.width, canvas.height], [Math.round(576 * vm.scale) * 2, Math.round(320 * vm.scale) * 2], "the backing store follows device pixels");
  assert.equal((canvas.getContext() as {imageSmoothingEnabled?: boolean}).imageSmoothingEnabled, false, "the stretch stays nearest-neighbour");
  const stretch = calls.filter(call => call.name === "drawImage" && call.args[0] === canvas).at(-1)!;
  assert.deepEqual(stretch.args.slice(2), [0, 0, canvas.width, canvas.height], "the pixel-exact layer fills the canvas");
  const board = vm.LAYOUT.board;
  const noteAt = (index: number) => calls.find(call => call.name === "drawImage" && call.args[2] === board.x + vm.notePosition(index).x && call.args[3] === board.y + vm.notePosition(index).y);
  assert.equal(noteAt(0)?.args[1], vm.images.notePass, "PASS is a green note");
  assert.equal(noteAt(1)?.args[1], vm.images.noteFail, "FAIL is a red note");
  assert.equal(noteAt(2)?.args[1], vm.images.notePending, "unverified is a yellow note");
  assert.equal(noteAt(3), undefined, "one note per criterion");
});

test("the HUD and labels are HTML over the canvas, and the bottom tabs, dialogue and flow strips are gone", async () => {
  const {vm, elements} = await boot({generatedAt: "x", runs: [], reviews: [], lobby: [desk("receipt", {phase: "verifying", progress: {passed: 1, total: 2, verify: "FAIL", review: null},
    questions: [{questionId: "q1", prompt: "Show tax separately?"}],
    criteria: [{id: "a", description: "A", status: "PASS", finishedAt: null, failureClass: null, exitCode: null}, {id: "b", description: "B", status: "FAIL", finishedAt: null, failureClass: "exit-code", exitCode: 1}]})]});
  find(elements.get("overview")!, node => node.tagName === "BUTTON")[0]!.click();
  const hud = treeText(elements.get("hud")!);
  for (const part of ["receipt", "1/2", "Verify FAIL", "Review pending", "! 1 Awaiting answer"]) assert.ok(hud.includes(part), `HUD shows ${part}: ${hud}`);
  const labels = elements.get("labels")!.children;
  const zone = labels.find(node => node.className === "zone-label" && node.textContent === "Planning")!;
  const planning = vm.LAYOUT.rooms[0]!;
  assert.equal(zone.style.left, (planning.x + 4) * vm.scale + "px");
  assert.equal(zone.style.top, (planning.y + 2) * vm.scale + "px");
  const figure = vm.lastFigures[0]!;
  const plate = labels.find(node => node.className.startsWith("nameplate") && node.textContent === "receipt")!;
  assert.equal(plate.style.left, (figure.x + 17) * vm.scale + "px", "nameplates sit on whole art pixels");
  assert.equal(plate.className, "nameplate alert", "a person with a question is marked");
  const page = officePage("n");
  assert.doesNotMatch(page, /id="(room-nav|dialogue|flow)"/u);
  assert.doesNotMatch(clientScript(), /getElementById\("(room-nav|dialogue|flow)"\)/u);
});

test("people walk through the doors in order only when their phase changes, and doors open while they pass", async () => {
  const {vm, poll} = await boot({generatedAt: "x", runs: [], reviews: [], lobby: [desk("mover", {phase: "planning"})]});
  const key = vm.model.floors[0]!.actors[0]!.key;
  const start = {...vm.people[key]!};
  for (let i = 0; i < 20; i++) vm.tick();
  await poll();
  for (let i = 0; i < 20; i++) vm.tick();
  assert.deepEqual([vm.people[key]!.x, vm.people[key]!.y], [start.x, start.y], "no phase change, no movement");

  await poll({generatedAt: "y", runs: [], reviews: [], lobby: [desk("mover", {phase: "verifying"})]});
  assert.ok(vm.people[key]!.path.length > 10, "a path is planned");
  const floor = vm.model.floors[0]!.key, first = floor + "|planning-implementing", second = floor + "|implementing-verifying";
  const opened: Record<string, number[]> = {[first]: [], [second]: []};
  for (let i = 0; i < 2000 && vm.people[key]!.path.length; i++) { vm.tick(); for (const door of [first, second]) opened[door]!.push(vm.doorFrames[door]!); }
  assert.equal(vm.people[key]!.path.length, 0, "the walk ends");
  assert.deepEqual([vm.people[key]!.x, vm.people[key]!.y], [vm.people[key]!.slot.feet.x, vm.people[key]!.slot.feet.y], "at a verifying place");
  for (const door of [first, second]) {
    assert.ok(opened[door]!.includes(1) && opened[door]!.includes(2), `${door} goes through ajar and open`);
    assert.equal(opened[door]!.at(-1), 0, `${door} closes again`);
  }
  assert.ok(opened[first]!.indexOf(2) < opened[second]!.indexOf(2), "planning-implementing opens before implementing-verifying");
});

test("the viewer starts at the entrance, walks with arrows and WASD, and stops at walls and furniture", async () => {
  const {vm, elements} = await boot({generatedAt: "x", runs: [], reviews: [], lobby: [desk("solo")]});
  find(elements.get("overview")!, node => node.tagName === "BUTTON")[0]!.click();
  const canvas = elements.get("office")!, key = (k: string) => canvas.events.get("keydown")!({key: k, preventDefault: () => {}});
  assert.deepEqual([vm.viewer.x, vm.viewer.y], [Math.round(vm.LAYOUT.spawn.x / 2) * 2, Math.round(vm.LAYOUT.spawn.y / 2) * 2]);
  const free = () => vm.GRID.free[Math.round(vm.viewer.y / 2) * vm.GRID.cols + Math.round(vm.viewer.x / 2)] === 1;
  key("w"); assert.equal(vm.viewer.dir, "up"); const afterW = vm.viewer.y; key("s"); assert.equal(vm.viewer.dir, "down");
  assert.ok(afterW < vm.LAYOUT.spawn.y, "W walks up");
  for (let i = 0; i < 80; i++) { key("ArrowUp"); assert.ok(free()); }
  assert.ok(vm.viewer.y >= 222, `the kitchen counter stops the walk north (${vm.viewer.y})`);
  for (let i = 0; i < 80; i++) { key("ArrowLeft"); assert.ok(free()); }
  assert.ok(vm.viewer.x >= 11, "the outer wall stops the walk west");
  for (let i = 0; i < 80; i++) { key("ArrowRight"); assert.ok(free()); }
  assert.ok(vm.viewer.x < 188, `the lobby wall stops the walk east away from its door (${vm.viewer.x})`);
});

test("standing near a person shows their narration in a bubble, and Enter opens their details", async () => {
  const {vm, elements} = await boot({generatedAt: "x", runs: [], reviews: [], lobby: [desk("talker", {phase: "integrating"})]});
  find(elements.get("overview")!, node => node.tagName === "BUTTON")[0]!.click();
  vm.render();
  const figure = vm.lastFigures[0]!;
  vm.viewer.x = figure.feet.x + 6; vm.viewer.y = figure.feet.y + 4;
  vm.render();
  const bubble = elements.get("labels")!.children.find(node => node.className === "speech" && !node.hidden)!;
  assert.equal(bubble.textContent, "talker: editing src/talker.ts");
  elements.get("office")!.events.get("keydown")!({key: "Enter", preventDefault: () => {}});
  const status = elements.get("status")!;
  assert.equal(status.hidden, false);
  assert.equal(status.children[0]!.textContent, "talker");
  vm.viewer.x = vm.LAYOUT.spawn.x; vm.viewer.y = vm.LAYOUT.spawn.y;
  vm.render();
  assert.ok(elements.get("labels")!.children.filter(node => node.className === "speech").every(node => node.hidden), "walking away hides the bubble");
});

test("under reduced motion people and doors jump to their final state and nothing animates", async () => {
  const {vm, calls, elements, poll} = await boot({generatedAt: "x", runs: [], reviews: [], lobby: [desk("still", {phase: "planning"})]}, {reduced: true});
  assert.equal(vm.reducedMotion, true);
  const key = vm.model.floors[0]!.actors[0]!.key;
  await poll({generatedAt: "y", runs: [], reviews: [], lobby: [desk("still", {phase: "implementing"})]});
  assert.equal(vm.people[key]!.path.length, 0, "no walk is planned");
  assert.deepEqual([vm.people[key]!.x, vm.people[key]!.y], [vm.people[key]!.slot.feet.x, vm.people[key]!.slot.feet.y], "they are already there");
  find(elements.get("overview")!, node => node.tagName === "BUTTON")[0]!.click();
  const frames = [0, 1].map(() => { calls.length = 0; for (let i = 0; i < 40; i++) vm.tick(); return JSON.stringify(calls.filter(call => call.name === "drawImage").map(call => call.args.slice(2))); });
  assert.equal(frames[0], frames[1], "the room looks the same on every frame");
  assert.ok(Object.values(vm.doorFrames).every(frame => frame === 0), "doors rest closed");
  elements.get("office")!.events.get("click")!({clientX: 0, clientY: 0});
});

test("the room panel lists criteria, the language is remembered, dialogs page and copy, and a vanished room returns to the overview", async () => {
  const longCommand = "agent-ops task status --session " + "x".repeat(140);
  const room = desk("receipt", {phase: "verifying", title: "Receipt totals", progress: {passed: 1, total: 3, verify: "FAIL", review: null},
    criteria: [
      {id: "totals", description: "Receipt lists totals", status: "PASS", finishedAt: "2026-10-09T01:00:00.000Z", failureClass: null, exitCode: null},
      {id: "locale", description: "<img src=x onerror=alert(1)> formats tax", status: "FAIL", finishedAt: "2026-10-09T02:00:00.000Z", failureClass: "exit-code", exitCode: 1},
      {id: "snapshots", description: "Snapshots still pass", status: null, finishedAt: null, failureClass: null, exitCode: null}],
    questions: [{questionId: "q1", prompt: "Show tax separately?"}], commands: [longCommand]});
  const {vm, elements, state, document, poll} = await boot({generatedAt: "x", runs: [], reviews: [], lobby: [room, desk("other", {repo: undefined})]});
  const list = elements.get("work-list")!, heading = elements.get("work-heading")!;
  assert.match(heading.textContent, /^Work list · 2$/u, "the overview shows the global work list");
  find(elements.get("overview")!, node => node.tagName === "BUTTON").find(card => card.getAttribute("data-key")!.includes("receipt"))!.click();
  assert.equal(heading.textContent, "Acceptance checks · 1/3");
  const cards = list.children.filter(child => child.getAttribute("data-criterion") !== null);
  assert.deepEqual(cards.map(card => card.children[0]!.textContent), ["totals · PASS", "locale · FAIL", "snapshots · Not verified yet"]);
  assert.equal(cards[1]!.children[1]!.textContent, "<img src=x onerror=alert(1)> formats tax", "task text stays literal");
  assert.doesNotMatch(/function renderRoomPanel\(floor\)\{[\s\S]*?\n\}/u.exec(clientScript())![0], /innerHTML/u);

  // L, Q and the phase keys open their lists from the room.
  const canvas = elements.get("office")!, key = (k: string) => canvas.events.get("keydown")!({key: k, preventDefault: () => {}});
  const status = elements.get("status")!;
  key("q"); assert.match(status.children[0]!.textContent, /Questions/u); assert.ok(treeText(status).includes("Show tax separately?"));
  key("Escape"); assert.equal(status.hidden, true);
  key("l"); assert.match(status.children[0]!.textContent, /Work list/u); key("Escape");
  key("3"); assert.match(status.children[0]!.textContent, /Verifying/u); assert.ok(treeText(status).includes("receipt")); key("Escape");

  // A click on the person opens their details, which page and copy long commands whole.
  vm.render();
  const figure = vm.lastFigures[0]!;
  canvas.click({clientX: (figure.x + 17) * canvas.width / 576, clientY: (figure.y + 25) * canvas.height / 320});
  assert.equal(status.children[0]!.textContent, "receipt");
  const texts: string[] = [];
  for (let page = 0; page < 6; page++) {
    texts.push(...find(status, node => node.tagName === "CODE").map(node => node.textContent));
    const copy = find(status, node => node.tagName === "BUTTON" && node.textContent === "Copy")[0];
    if (copy) { copy.click(); await settle(); assert.equal(state.copied, longCommand); }
    const next = find(status, node => node.tagName === "BUTTON" && node.textContent === "Next" && !node.disabled)[0];
    if (!next) break;
    next.click();
  }
  assert.equal(texts.join(""), longCommand, "long commands are split across lines but copied whole");
  key("Escape");

  // The language toggle is remembered.
  elements.get("language")!.click();
  assert.match(document.cookie, /agent-office-language=zh/u);
  assert.equal(elements.get("work-heading")!.textContent, "驗收條件 · 1/3");

  // Going offline keeps the last state; a room that disappears sends the viewer back.
  state.offline = true; await poll();
  assert.equal(elements.get("live")!.textContent, "○ 重新連線中");
  state.offline = false; await poll({generatedAt: "z", runs: [], reviews: [], lobby: [desk("other")]});
  assert.equal(vm.mode, "overview", "a vanished room returns to the overview");
  assert.equal(elements.get("room-view")!.hidden, true);
  assert.equal(elements.get("overview")!.hidden, false);
});

test("the repository filter narrows the overview and leaves a room from another repository", async () => {
  const {vm, elements} = await boot({generatedAt: "x", runs: [], reviews: [], lobby: [desk("a", {repo: "shop"}), desk("b", {repo: "api"})]});
  const filter = elements.get("repo-filter")!;
  assert.equal(filter.hidden, false);
  assert.deepEqual(filter.children.map(option => option.value), ["", "api", "shop"]);
  find(elements.get("overview")!, node => node.tagName === "BUTTON").find(card => card.getAttribute("data-key")!.includes("api"))!.click();
  assert.equal(vm.mode, "room");
  filter.value = "shop"; filter.events.get("change")!();
  assert.equal(vm.mode, "overview");
  assert.deepEqual(elements.get("overview")!.children.map(section => section.getAttribute("data-repo")), ["shop"]);
});

test("the work list folds away so the office takes the whole width, and the choice is remembered", async () => {
  const snapshot: OfficeSnapshot = {generatedAt: "x", runs: [], reviews: [], lobby: [desk("one")]};
  const {elements, storage, vm} = await boot(snapshot);
  const toggle = elements.get("panel-toggle")!, workspace = elements.get("workspace")!;
  assert.equal(workspace.className, "");
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal(toggle.textContent, "Hide list");
  toggle.click();
  assert.equal(workspace.className, "collapsed", "the list column is gone");
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(toggle.textContent, "Show list");
  assert.equal(storage.get("agent-office-list"), "collapsed");
  find(elements.get("overview")!, node => node.tagName === "BUTTON")[0]!.click();
  assert.equal(vm.mode, "room");
  assert.equal(workspace.className, "collapsed", "the choice holds inside a room");
  toggle.click();
  assert.equal(workspace.className, "");
  assert.equal(storage.get("agent-office-list"), "open");
  const again = await boot(snapshot, {stored: {"agent-office-list": "collapsed"}});
  assert.equal(again.elements.get("workspace")!.className, "collapsed", "the next visit starts folded");
  assert.equal(again.elements.get("panel-toggle")!.getAttribute("aria-expanded"), "false");
});

test("overview cards share one scale of at least 1x that fills the width, and grow when the space grows", async () => {
  const lobby = ["a", "b", "c"].map(name => desk(name));
  const {elements, vm} = await boot({generatedAt: "x", runs: [], reviews: [], lobby});
  const cardWidth = () => {
    const canvases = find(elements.get("overview")!, node => node.tagName === "CANVAS");
    assert.equal(new Set(canvases.map(c => c.style.width)).size, 1, "one scale for every card");
    return Number.parseInt(canvases[0]!.style.width!, 10);
  };
  const available = 1440 - 32, gap = 14;
  const width = cardWidth(), columns = Math.floor((available + gap) / (576 + gap));
  assert.equal(columns, 2);
  assert.ok(width >= 576, "never below 1x");
  assert.ok(columns * width + (columns - 1) * gap <= available, "the row fits");
  assert.ok(columns * width + (columns - 1) * gap >= available - gap, `the row reaches the right edge (${width}px cards)`);
  const win = (vm as unknown as {window: {innerWidth: number}}).window;
  win.innerWidth = 1700; vm.render();
  const wider = cardWidth();
  assert.ok(wider > width, `more space gives larger cards (${width} -> ${wider})`);
  win.innerWidth = 2000; vm.render();
  const third = cardWidth();
  assert.ok(third >= 576 && 3 * third + 2 * gap <= 2000 - 32 && 3 * third + 2 * gap >= 2000 - 32 - gap, `a 2000px window takes a third column (${third}px cards)`);
});
