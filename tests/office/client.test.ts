import assert from "node:assert/strict";
import {runInNewContext} from "node:vm";
import test from "node:test";

import {buildOfficeSnapshot, type OfficeSnapshot} from "../../runtime/src/office/snapshot.js";
import type {OfficeActivity} from "../../runtime/src/office/activity.js";
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

function clientScript(): string { return officePage("nonce").match(/<script[^>]*>([\s\S]*)<\/script>/iu)![1]!; }
function treeText(node: FakeElement): string { return node.textContent + node.children.map(treeText).join(""); }
function find(node: FakeElement, test: (n: FakeElement) => boolean): FakeElement[] { return node.children.flatMap(child => [...(test(child) ? [child] : []), ...find(child, test)]); }

type Figure = {actor: {key: string; id: string}; x: number; y: number; feet: {x: number; y: number}};
type Room = {id: string; x: number; y: number; slots: {x: number; y: number; feet: {x: number; y: number}}[]};
interface Vm {
  mode: string; selectedKey: string; frame: number; scale: number; scaleY: number; reducedMotion: boolean; detailPage: number;
  viewer: {x: number; y: number; path: unknown[]; dir: string};
  people: Record<string, {x: number; y: number; path: unknown[]; slot: {feet: {x: number; y: number}}}>;
  doorFrames: Record<string, number>; images: Record<string, FakeElement>; lastFigures: Figure[];
  LAYOUT: {rooms: Room[]; board: {x: number; y: number}; spawn: {x: number; y: number};
    staff: {stations: Record<"qa" | "desk" | "armchair" | "integrator", {feet: {x: number; y: number}}>; rest: {feet: {x: number; y: number}}[]}};
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
  assert.ok(Math.abs(vm.scaleY - (900 - 44 - 40) / 320) < 1e-9, "and its height, so no margin stays below");
  assert.equal(canvas.style.width, Math.round(576 * vm.scale) + "px");
  assert.equal(canvas.style.height, Math.round(320 * vm.scaleY) + "px");
  const stretch = vm.scale / vm.scaleY;
  assert.ok(stretch <= 1.18 + 1e-9 && stretch >= 1 / 1.18 - 1e-9, `the stretch stays within 18% (${stretch.toFixed(3)})`);
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
  assert.deepEqual([canvas.width, canvas.height], [Math.round(576 * vm.scale) * 2, Math.round(320 * vm.scaleY) * 2], "the backing store follows device pixels");
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
  assert.equal(zone.style.top, (planning.y + 2) * vm.scaleY + "px", "vertical positions use the vertical scale");
  const figure = vm.lastFigures[0]!;
  const plate = labels.find(node => node.className.startsWith("nameplate") && node.textContent === "receipt")!;
  assert.equal(plate.style.left, (figure.x + 17) * vm.scale + "px", "nameplates sit on whole art pixels");
  assert.equal(plate.className, "nameplate alert", "a person with a question is marked");
  const page = officePage("n");
  assert.doesNotMatch(page, /id="(room-nav|dialogue|flow)"/u);
  assert.doesNotMatch(clientScript(), /getElementById\("(room-nav|dialogue|flow)"\)/u);
});

test("people walk through the doors in order only when their phase changes, and doors open while they pass", async () => {
  const {vm, poll} = await boot({generatedAt: "x", runs: [], reviews: [], lobby: [desk("mover")]});
  const key = vm.model.floors[0]!.actors[0]!.key;
  const start = {...vm.people[key]!};
  for (let i = 0; i < 20; i++) vm.tick();
  await poll();
  for (let i = 0; i < 20; i++) vm.tick();
  assert.deepEqual([vm.people[key]!.x, vm.people[key]!.y], [start.x, start.y], "no phase change, no movement");

  await poll({generatedAt: "y", runs: [], reviews: [], lobby: [desk("mover", {phase: "planning"})]});
  assert.ok(vm.people[key]!.path.length > 10, "a path is planned");
  const floor = vm.model.floors[0]!.key, first = floor + "|integrating-lobby", second = floor + "|reviewing-integrating";
  const opened: Record<string, number[]> = {[first]: [], [second]: []};
  for (let i = 0; i < 2000 && vm.people[key]!.path.length; i++) { vm.tick(); for (const door of [first, second]) opened[door]!.push(vm.doorFrames[door]!); }
  assert.equal(vm.people[key]!.path.length, 0, "the walk ends");
  assert.deepEqual([vm.people[key]!.x, vm.people[key]!.y], [vm.people[key]!.slot.feet.x, vm.people[key]!.slot.feet.y], "at a planning place");
  for (const door of [first, second]) {
    assert.ok(opened[door]!.includes(1) && opened[door]!.includes(2), `${door} goes through ajar and open`);
    assert.equal(opened[door]!.at(-1), 0, `${door} closes again`);
  }
  assert.ok(opened[first]!.indexOf(2) < opened[second]!.indexOf(2), "integrating-lobby opens before reviewing-integrating");
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
  assert.equal(toggle.textContent, "Hide list »");
  const page = officePage("n");
  assert.match(page, /<aside id="work-panel"[^>]*><div id="panel-head"><h2 id="work-heading">[^<]*<\/h2><button id="panel-toggle"/u, "the toggle lives in the work list heading");
  assert.doesNotMatch(/<header id="header">[\s\S]*?<\/header>/u.exec(page)![0], /panel-toggle/u, "the page header no longer carries it");
  toggle.click();
  assert.equal(workspace.className, "collapsed", "the list column is gone");
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(toggle.textContent, "« Work list", "folded, the rail offers the list back");
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
  assert.ok(columns * width + (columns - 1) * gap + columns * 8 >= available - gap, `the row, borders included, reaches the right edge (${width}px cards)`);
  const win = (vm as unknown as {window: {innerWidth: number}}).window;
  win.innerWidth = 1700; vm.render();
  const wider = cardWidth();
  assert.ok(wider > width, `more space gives larger cards (${width} -> ${wider})`);
  win.innerWidth = 2000; vm.render();
  const third = cardWidth();
  assert.ok(third >= 576 && 3 * third + 2 * gap + 24 <= 2000 - 32 && 3 * third + 2 * gap + 24 >= 2000 - 32 - gap, `a 2000px window takes a third column (${third}px cards)`);
});

test("with the list folded, the overview snaps page by page, four rooms a page, filling each page", async () => {
  const lobby = ["r1", "r2", "r3", "r4", "r5", "r6"].map(name => desk(name));
  const {elements, vm} = await boot({generatedAt: "x", runs: [], reviews: [], lobby}, {stored: {"agent-office-list": "collapsed"}});
  const overview = elements.get("overview")!;
  assert.equal(overview.className, "paged");
  const page = officePage("n");
  assert.match(page, /#overview\.paged\{[^}]*scroll-snap-type:y mandatory/u, "the folded overview scrolls with mandatory snapping");
  assert.match(page, /\.page\{[^}]*scroll-snap-align:start/u, "each page is a snap point");
  const sheets = overview.children.filter(node => node.className === "page");
  assert.equal(sheets.length, 2, "six rooms make two pages");
  assert.deepEqual(sheets.map(sheet => sheet.style.height), ["830px", "830px"], "each page is one viewport tall");
  assert.deepEqual(sheets.map(sheet => find(sheet, node => node.className === "card").length), [4, 2]);
  assert.equal(find(overview, node => node.tagName === "BUTTON" && (node.textContent === "Next" || node.textContent === "Previous")).length, 0, "no pager buttons");
  const grid = (sheet: FakeElement) => find(sheet, node => node.className === "cards page-grid")[0]!;
  assert.equal(grid(sheets[0]!).style.gridTemplateColumns, "repeat(2, max-content)", "four rooms make a 2x2 grid");
  assert.match(grid(sheets[1]!).style.gridTemplateColumns, /^repeat\([12], max-content\)$/u, "two rooms split the page in halves, whichever way gives them more room");
  const size = (sheet: FakeElement) => { const c = find(sheet, node => node.tagName === "CANVAS")[0]!; return {w: Number.parseInt(c.style.width!, 10), h: Number.parseInt(c.style.height!, 10)}; };
  const {w, h} = size(sheets[0]!);
  const width = 1440 - 32, height = 830 - 16;
  assert.ok(2 * w + 2 * 8 + 14 <= width && 2 * w + 2 * 8 + 14 >= width - 2, `the 2x2 page fills the width with no side margins (${w}px cards)`);
  assert.ok(2 * h + 2 * 8 + 14 <= height && 2 * h + 2 * 8 + 14 >= height - 2, `and the height (${h}px cards)`);
  const stretch = (w / 576) / (h / 320);
  assert.ok(stretch <= 1.18 + 0.01 && stretch >= 1 / 1.18 - 0.01, `the stretch stays within 18% of 9:5 (${stretch.toFixed(3)})`);
  const half = size(sheets[1]!);
  assert.ok(half.w * half.h > w * h && half.w + 8 <= width && half.h + 8 <= height, `halves are larger than quarters (${w}x${h} -> ${half.w}x${half.h})`);
  const halfStretch = (half.w / 576) / (half.h / 320);
  assert.ok(halfStretch <= 1.18 + 0.01 && halfStretch >= 1 / 1.18 - 0.01, `halves keep the stretch limit rather than squashing people (${halfStretch.toFixed(3)})`);
  assert.equal(find(overview, node => node.className === "card-caption").length, 6, "captions float over the cards");
  assert.deepEqual(find(sheets[1]!, node => node.className === "card-title").map(n => n.textContent.slice(0, 2)), ["1.", "2."], "numbering restarts on each page");
  // Number keys follow the page scrolled into view.
  (overview as unknown as {scrollTop: number}).scrollTop = 830;
  overview.events.get("keydown")!({key: "2", preventDefault: () => {}});
  assert.equal(vm.mode, "room");
  assert.equal(vm.selectedKey, vm.orderedRooms()[5]!.key, "key 2 on page 2 opens the sixth room");
});

test("a single room on a folded page fills it", async () => {
  const {elements} = await boot({generatedAt: "x", runs: [], reviews: [], lobby: [desk("only")]}, {stored: {"agent-office-list": "collapsed"}});
  const overview = elements.get("overview")!;
  assert.equal(find(overview, node => node.className === "cards page-grid")[0]!.style.gridTemplateColumns, "repeat(1, max-content)");
  const w = Number.parseInt(find(overview, node => node.tagName === "CANVAS")[0]!.style.width!, 10);
  assert.ok(w > 1000 && w <= 1440 - 32, `one room takes the page (${w}px)`);
  assert.equal(overview.children.filter(node => node.className === "page").length, 1, "one page");
});

test("the five props open their panels from the snapshot, showing every string literally", async () => {
  const hostile = "<img src=x onerror=alert(1)>";
  const room = desk("receipt", {phase: "verifying", title: "Receipt totals", status: "active", taskId: "task-r",
    progress: {passed: 1, total: 3, verify: "FAIL", review: "FAIL"}, base: "a1b2c3d4e5f6", ahead: 3,
    diff: {files: 2, insertions: 40, deletions: 4, paths: ["src/tax.ts", "src/format.ts"], recent: "src/format.ts"},
    criteria: [
      {id: "totals", description: "Receipt lists totals", status: "PASS", finishedAt: "2026-10-09T01:00:00.000Z", failureClass: null, exitCode: null, output: null},
      {id: "locale", description: "Tax follows the locale", status: "FAIL", finishedAt: "2026-10-09T02:00:00.000Z", failureClass: "test-failure", exitCode: 1, output: "expected 1.234,56\n" + hostile},
      {id: "snap", description: "Snapshots", status: null, finishedAt: null, failureClass: null, exitCode: null, output: null}],
    review: {status: "FAIL", createdAt: "2026-10-09T03:00:00.000Z", reason: null, refuted: false, rounds: [
      {target: "codex", summary: "Looks fine.", findings: []},
      {target: "claude", summary: "Formatting is wrong.", findings: [{severity: "important", blocking: true, title: "Locale " + hostile, details: "de-DE drops separators", recommendation: "Use Intl.NumberFormat"}]}]},
    questions: [{questionId: "q1", prompt: "Show tax separately?"}], commands: ["agent-ops worktree list"]});
  const {vm, elements} = await boot({generatedAt: "x", runs: [], reviews: [], lobby: [room]});
  find(elements.get("overview")!, node => node.tagName === "BUTTON")[0]!.click();
  vm.render();
  const canvas = elements.get("office")!, status = elements.get("status")!;
  const hotspots = (vm.LAYOUT as unknown as {hotspots: {kind: string; rects: {x: number; y: number; w: number; h: number}[]}[]}).hotspots;
  const open = (kind: string) => {
    const r = hotspots.find(spot => spot.kind === kind)!.rects[0]!;
    canvas.click({clientX: (r.x + r.w / 2) * canvas.width / 576, clientY: (r.y + r.h / 2) * canvas.height / 320});
    assert.equal(status.hidden, false, kind);
    const text = treeText(status);
    canvas.events.get("keydown")!({key: "Escape", preventDefault: () => {}});
    return {text, className: status.className};
  };
  const task = open("task");
  for (const part of ["Whiteboard · receipt", "Not verified yet · 1", "FAIL · 1", "PASS · 1", "Receipt lists totals", "! Show tax separately?", "agent-ops worktree list"]) assert.ok(task.text.includes(part), `whiteboard shows ${part}`);
  const diff = open("diff");
  for (const part of ["main · 2 files · +40 −4", "src/tax.ts", "▶ src/format.ts"]) assert.ok(diff.text.includes(part), `screen shows ${part}`);
  const verify = open("verify");
  for (const part of ["locale · FAIL", "test-failure · exit 1 · 2026-10-09 02:00", "expected 1.234,56\n" + hostile, "agent-ops verify --task task-r"]) assert.ok(verify.text.includes(part), `QA board shows ${part}`);
  const review = open("review");
  for (const part of ["FAIL", "Round 1 · codex", "Re-check · claude", "[important · blocking] Locale " + hostile, "→ Use Intl.NumberFormat", "The re-check upheld round 1.", "agent-ops review --task task-r --yes"]) assert.ok(review.text.includes(part), `review desk shows ${part}`);
  const integration = open("integration");
  for (const part of ["a1b2c3d4e5f6", "3", "✓ Commit", "✗ Verify", "✗ Review", "○ worktree finish (merge)", "agent-ops worktree finish receipt"]) assert.ok(integration.text.includes(part), `sorting table shows ${part}`);
  assert.equal(integration.className, "panel panel-integration");
  // Enter next to a prop opens it too.
  const desk2 = hotspots.find(spot => spot.kind === "review")!.rects[0]!;
  vm.viewer.x = desk2.x + 20; vm.viewer.y = desk2.y + desk2.h + 6;
  vm.lastFigures = [];
  canvas.events.get("keydown")!({key: "Enter", preventDefault: () => {}});
  assert.match(status.children[0]!.textContent, /^Review desk/u, "Enter beside the reviewer's desk opens its panel");
  assert.doesNotMatch(/function panelTask[\s\S]*?\nvar PANELS/u.exec(clientScript())![0], /innerHTML/u, "panels never parse snapshot text as HTML");
});

test("panels say plainly when there is no review or no change yet", async () => {
  const {vm, elements} = await boot({generatedAt: "x", runs: [], reviews: [], lobby: [desk("fresh", {diff: {files: 0, insertions: 0, deletions: 0, paths: [], recent: null}})]});
  find(elements.get("overview")!, node => node.tagName === "BUTTON")[0]!.click();
  vm.render();
  const canvas = elements.get("office")!, status = elements.get("status")!;
  const hotspots = (vm.LAYOUT as unknown as {hotspots: {kind: string; rects: {x: number; y: number; w: number; h: number}[]}[]}).hotspots;
  for (const [kind, expected] of [["review", "Not reviewed yet."], ["diff", "No changed files yet."]] as const) {
    const r = hotspots.find(spot => spot.kind === kind)!.rects[0]!;
    canvas.click({clientX: (r.x + 2) * canvas.width / 576, clientY: (r.y + 2) * canvas.height / 320});
    assert.ok(treeText(status).includes(expected), `${kind}: ${expected}`);
    canvas.events.get("keydown")!({key: "Escape", preventDefault: () => {}});
  }
});

test("an empty office still shows one quiet room, open or folded, that does not open", async () => {
  for (const folded of [false, true]) {
    const {vm, elements} = await boot({generatedAt: "x", runs: [], reviews: [], lobby: []}, folded ? {stored: {"agent-office-list": "collapsed"}} : {});
    const overview = elements.get("overview")!;
    const canvases = find(overview, node => node.tagName === "CANVAS");
    assert.equal(canvases.length, 1, "exactly one room");
    assert.equal(find(overview, node => node.className === "card-title")[0]!.textContent, "The office is quiet. No agent is at work.");
    const w = Number.parseInt(canvases[0]!.style.width!, 10), h = Number.parseInt(canvases[0]!.style.height!, 10);
    assert.ok(w + 8 >= 1440 - 32 - 2 || h + 8 >= 830 - 16 - 2, `the room fills the page (${w}x${h})`);
    const card = find(overview, node => node.className === "card empty-room")[0]!;
    assert.notEqual(card.tagName, "BUTTON", "nothing to open");
    card.click();
    assert.equal(vm.mode, "overview");
    vm.render();
    assert.equal(vm.lastFigures.length, 0);
  }
});

type Staff = "qa" | "reviewerA" | "reviewerB" | "integrator";
const at = (vm: Vm, key: string) => [vm.people[key]!.x, vm.people[key]!.y];
const feet = (spot: {feet: {x: number; y: number}}) => [spot.feet.x, spot.feet.y];
const walk = (vm: Vm, key: string) => { for (let i = 0; i < 3000 && vm.people[key]!.path.length; i++) vm.tick(); assert.equal(vm.people[key]!.path.length, 0, `${key} arrives`); };
const staffKey = (vm: Vm, role: Staff) => vm.model.floors[0]!.key + "|staff:" + role;
/** The head bubbles drawn over a room on one frame, as sprite names. */
function bubbles(vm: Vm, calls: Call[]): string[] {
  const names = new Map(Object.entries(vm.images).map(([name, image]) => [image, name]));
  calls.length = 0; vm.frame = (vm.frame | 63) + 1; vm.render(); // a frame where busy bubbles show
  return calls.filter(call => call.name === "drawImage").map(call => names.get(call.args[1] as FakeElement) ?? "").filter(name => name.startsWith("bubble"));
}
const activity = (kind: string, extra: Record<string, unknown> = {}) => ({kind, startedAt: "2026-10-09T00:00:00.000Z", ...extra});

test("every room keeps a resident QA, two reviewers and an integrator in the lobby, and the engineer stays at the cubicle after building", async () => {
  const {vm} = await boot({generatedAt: "x", runs: [], reviews: [], lobby: [desk("resident", {phase: "reviewing"})]});
  (["qa", "reviewerA", "reviewerB", "integrator"] as const).forEach((role, index) =>
    assert.deepEqual(at(vm, staffKey(vm, role)), feet(vm.LAYOUT.staff.rest[index]!), `${role} rests in the lobby`));
  const engineer = vm.model.floors[0]!.actors[0]!.key, cubicle = vm.LAYOUT.rooms.find(room => room.id === "implementing")!;
  assert.deepEqual(at(vm, engineer), feet(cubicle.slots[0]!), "the engineer sits at the cubicle while the room is reviewing");
  assert.equal(vm.model.floors[0]!.actors.length, 1, "staff are not counted as the room's agents");
});

test("QA and the integrator walk to their station while their process runs and back with the result, which fades", async () => {
  const room = (extra: Record<string, unknown>) => ({generatedAt: "x", runs: [], reviews: [], lobby: [desk("qa-room", {phase: "verifying", ...extra})]});
  const {vm, calls, elements, poll} = await boot(room({}));
  find(elements.get("overview")!, node => node.tagName === "BUTTON")[0]!.click();
  const qa = staffKey(vm, "qa"), integrator = staffKey(vm, "integrator");
  await poll(room({activities: [activity("verify")]}));
  assert.ok(vm.people[qa]!.path.length > 10, "QA leaves the lobby");
  assert.deepEqual(at(vm, integrator), feet(vm.LAYOUT.staff.rest[3]!), "the integrator stays");
  walk(vm, qa);
  assert.deepEqual(at(vm, qa), feet(vm.LAYOUT.staff.stations.qa), "QA works at the test bench");
  assert.deepEqual(bubbles(vm, calls), ["bubbleBusy"], "with a busy bubble");
  await poll(room({progress: {passed: 2, total: 2, verify: "FAIL", review: null}}));
  walk(vm, qa);
  assert.deepEqual(at(vm, qa), feet(vm.LAYOUT.staff.rest[0]!), "and walks back when verify ends");
  assert.deepEqual(bubbles(vm, calls), ["bubbleFail"], "showing the snapshot's result");
  await poll(room({progress: {passed: 2, total: 2, verify: "FAIL", review: null}, activities: [activity("finish")]}));
  walk(vm, integrator);
  assert.deepEqual(at(vm, integrator), feet(vm.LAYOUT.staff.stations.integrator), "the integrator works at the sorting table");
  await poll(room({progress: {passed: 2, total: 2, verify: "PASS", review: "PASS"}, completedAt: "2026-10-09T00:10:00.000Z"}));
  walk(vm, integrator);
  assert.equal(bubbles(vm, calls).filter(name => name === "bubbleDone").length, 2, "a finished merge shows a check over the integrator, beside the finished engineer's");
  for (let i = 0; i < 700; i++) vm.tick();
  assert.deepEqual(bubbles(vm, calls), ["bubbleDone"], "result bubbles go after about ten seconds");
});

test("both reviewers come for a review and swap the desk for round 2, named after the targets", async () => {
  const room = (extra: Record<string, unknown>) => ({generatedAt: "x", runs: [], reviews: [], lobby: [desk("review-room", {phase: "reviewing", ...extra})]});
  const {vm, elements, poll} = await boot(room({}));
  find(elements.get("overview")!, node => node.tagName === "BUTTON")[0]!.click();
  const a = staffKey(vm, "reviewerA"), b = staffKey(vm, "reviewerB"), names = () => { vm.render(); return [...vm.lastFigures.filter(f => f.actor.key === a || f.actor.key === b).map(f => f.actor.id)]; };
  assert.deepEqual(names(), ["A", "B"], "without a review or report they are A and B");
  await poll(room({activities: [activity("review", {targets: ["agy", "codex"], round: 1, target: "agy"})]}));
  walk(vm, a); walk(vm, b);
  assert.deepEqual([at(vm, a), at(vm, b)], [feet(vm.LAYOUT.staff.stations.desk), feet(vm.LAYOUT.staff.stations.armchair)], "round 1: A at the desk, B in an armchair");
  assert.deepEqual(names(), ["agy", "codex"]);
  await poll(room({activities: [activity("review", {targets: ["agy", "codex"], round: 2, target: "codex"})]}));
  walk(vm, a); walk(vm, b);
  assert.deepEqual([at(vm, a), at(vm, b)], [feet(vm.LAYOUT.staff.stations.armchair), feet(vm.LAYOUT.staff.stations.desk)], "round 2: they swap");
  await poll(room({review: {status: "PASS", createdAt: "2026-10-09T00:05:00.000Z", reason: null, refuted: false,
    rounds: [{target: "claude", summary: "", findings: []}, {target: "codex", summary: "", findings: []}]}}));
  walk(vm, a); walk(vm, b);
  assert.deepEqual([at(vm, a), at(vm, b)], [feet(vm.LAYOUT.staff.rest[1]!), feet(vm.LAYOUT.staff.rest[2]!)], "both go back to the lobby");
  assert.deepEqual(names(), ["claude", "codex"], "then the newest report names them");
});

test("under reduced motion staff jump between the lobby and their station and result bubbles stay still", async () => {
  const room = (extra: Record<string, unknown>) => ({generatedAt: "x", runs: [], reviews: [], lobby: [desk("calm", {phase: "verifying", ...extra})]});
  const {vm, calls, elements, poll} = await boot(room({}), {reduced: true});
  find(elements.get("overview")!, node => node.tagName === "BUTTON")[0]!.click();
  const qa = staffKey(vm, "qa");
  await poll(room({activities: [activity("verify")]}));
  assert.equal(vm.people[qa]!.path.length, 0, "no walk is planned");
  assert.deepEqual(at(vm, qa), feet(vm.LAYOUT.staff.stations.qa), "QA is already at the bench");
  await poll(room({progress: {passed: 1, total: 1, verify: "PASS", review: null}}));
  assert.deepEqual(at(vm, qa), feet(vm.LAYOUT.staff.rest[0]!));
  const frames = [0, 1].map(() => { calls.length = 0; for (let i = 0; i < 40; i++) vm.tick(); return JSON.stringify(calls.filter(call => call.name === "drawImage").map(call => call.args.slice(2))); });
  assert.equal(frames[0], frames[1], "the result bubble does not move or fade");
  assert.deepEqual(bubbles(vm, calls), ["bubbleDone"]);
});

test("activity records for a session send its staff to work and back, end to end through the snapshot", async () => {
  const snapshot = (activities: OfficeActivity[]) => buildOfficeSnapshot({now: Date.parse("2026-10-09T00:00:00.000Z"), runs: [], reviews: [], activities,
    worktrees: [{name: "session-int", path: "/repo/.worktrees/session-int", branch: "agent-ops/session-int", sessionId: "s-int",
      diff: {files: 0, insertions: 0, deletions: 0, paths: [], recent: null}}]});
  const record = (kind: OfficeActivity["kind"], extra: Partial<OfficeActivity> = {}): OfficeActivity =>
    ({kind, pid: 4242, root: "/repo/.worktrees/session-int", startedAt: "2026-10-09T00:00:00.000Z", sessionId: "s-int", ...extra});
  const {vm, poll} = await boot(snapshot([]));
  assert.equal(vm.model.floors.length, 1, "the activity joins the session's room, no extra room");
  await poll(snapshot([record("verify")]));
  assert.equal(vm.model.floors.length, 1);
  walk(vm, staffKey(vm, "qa"));
  assert.deepEqual(at(vm, staffKey(vm, "qa")), feet(vm.LAYOUT.staff.stations.qa), "QA is at the bench while verify runs");
  await poll(snapshot([record("review", {targets: ["agy", "codex"], round: 1, target: "agy"})]));
  for (const role of ["qa", "reviewerA", "reviewerB"] as const) walk(vm, staffKey(vm, role));
  assert.deepEqual(at(vm, staffKey(vm, "qa")), feet(vm.LAYOUT.staff.rest[0]!), "QA is back in the lobby");
  assert.deepEqual(at(vm, staffKey(vm, "reviewerA")), feet(vm.LAYOUT.staff.stations.desk), "the first reviewer is at the desk");
  await poll(snapshot([]));
  walk(vm, staffKey(vm, "reviewerA"));
  assert.deepEqual(at(vm, staffKey(vm, "reviewerA")), feet(vm.LAYOUT.staff.rest[1]!), "and back when the review ends");
});
