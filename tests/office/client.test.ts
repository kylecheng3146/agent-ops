import assert from "node:assert/strict";
import {runInNewContext} from "node:vm";
import test from "node:test";

import type {OfficeSnapshot} from "../../runtime/src/office/snapshot.js";
import {avatarPalette, avatarSprite, officePage} from "../../runtime/src/office/page.js";

test("pixel avatars have fixed individual looks, four facings and alternating steps", () => {
  const people = ["Kyle", "Ada", "reviewer 1", "Session A", "Session B"];
  const looks = people.map(id => JSON.stringify([avatarSprite(id), avatarPalette(id)]));
  assert.equal(new Set(looks).size, people.length);
  for (const id of people) {
    assert.deepEqual(avatarSprite(id), avatarSprite(id), "appearance is deterministic");
    assert.deepEqual(avatarPalette(id), avatarPalette(id));
    assert.equal(avatarPalette(id).length, 16);
    for (const color of avatarPalette(id)) assert.match(color, /^#[0-9a-f]{6}$/u);
    const directions = ["down", "up", "left", "right"].map(direction => avatarSprite(id, direction));
    assert.equal(new Set(directions.map(rows => rows.join(""))).size, 4);
    assert.deepEqual(directions[2], directions[3]!.map(row => [...row].reverse().join("")));
    for (const direction of ["down", "up", "left", "right"]) {
      const stand = avatarSprite(id, direction), first = avatarSprite(id, direction, 1), second = avatarSprite(id, direction, 3);
      assert.notDeepEqual(first, stand); assert.notDeepEqual(second, stand); assert.notDeepEqual(first, second);
      assert.equal(stand.length, 48);
      for (const row of stand) {assert.equal(row.length, 32);assert.match(row, /^[0-9a-f.]+$/u);}
    }
  }
  const viewer = avatarSprite("viewer", "down", 0, true);
  assert.equal(viewer[8]![12], "2", "the viewer has dark short hair");
  assert.equal(avatarPalette("viewer", true)[2], "#514757");
  assert.equal(viewer[28]![15], "8", "the viewer wears the yellow shirt");
  assert.equal(avatarPalette("viewer", true)[8], "#e3b64f");
  assert.equal(viewer[16]![11], "0", "small dark eyes remain separate from the fringe");
  assert.equal(viewer[16]![12], "0");
  assert.equal(viewer[16]![13], "5", "the face is warm skin rather than a white block");
  const embedded = new Function(`return (${avatarSprite.toString()})`)() as typeof avatarSprite;
  assert.deepEqual(embedded("Ada", "up", 3), avatarSprite("Ada", "up", 3));
  const embeddedColors = new Function(`return (${avatarPalette.toString()})`)() as typeof avatarPalette;
  assert.deepEqual(embeddedColors("Ada"), avatarPalette("Ada"));
});

class FakeElement {
  readonly id: string;
  readonly tagName: string;
  readonly children: FakeElement[] = [];
  readonly style: Record<string, string> = {};
  readonly paintedText: string[] = [];
  readonly events = new Map<string, (event?: unknown) => void>();
  readonly attrs = new Map<string, string>();
  private content = "";
  hidden = false;
  className = "";
  disabled = false;
  value = "";
  width = 0;
  height = 0;
  inert = false;
  constructor(id = "", tagName = "DIV") { this.id = id; this.tagName = tagName.toUpperCase(); }
  get textContent(): string { return this.content; }
  set textContent(value: string) { this.content = value; this.children.length = 0; }
  appendChild(child: FakeElement): FakeElement { this.children.push(child); return child; }
  addEventListener(name: string, handler: (event?: unknown) => void): void { this.events.set(name, handler); }
  setAttribute(name: string, value: string): void { this.attrs.set(name, value); }
  getAttribute(name: string): string | null { return this.attrs.get(name) ?? null; }
  removeAttribute(name: string): void { this.attrs.delete(name); }
  focus(): void { activeElement = this; }
  click(): void { this.events.get("click")?.({}); }
  getContext(): object { return new Proxy({}, {get: (_target, key) => key === "measureText" ? (value: string) => ({width: value.length * 8}) : key === "fillText" ? (value: string) => this.paintedText.push(value) : () => {}}); }
  getBoundingClientRect(): {left: number; top: number; width: number; height: number} { return {left: 0, top: 0, width: this.width, height: this.height}; }
  querySelectorAll(selector: string): FakeElement[] {
    const result: FakeElement[] = [];
    const visit = (node: FakeElement) => { for (const child of node.children) { if (selector.startsWith("button") && child.tagName === "BUTTON" && !child.disabled) result.push(child); visit(child); } };
    visit(this); return result;
  }
}

let activeElement: FakeElement | null = null;

function clientScript(): string {
  const page = officePage("nonce");
  return page.match(/<script[^>]*>([\s\S]*)<\/script>/u)![1]!;
}

function treeText(node: FakeElement): string {
  return node.textContent + node.children.map(treeText).join("");
}

test("the inline client bootstraps rooms, keyboard controls and remembered language", async () => {
  const ids = ["office", "dialogue", "status", "room-nav", "crumb", "back", "recent", "repo-filter", "language", "live", "work-list", "work-heading", "work-summary", "flow"];
  const elements = new Map(ids.map(id => [id, new FakeElement(id)]));
  elements.get("status")!.hidden = true;
  const canvas = elements.get("office")!;
  canvas.width = 576; canvas.height = 304;

  const document = {
    cookie: "",
    get activeElement() { return activeElement; },
    getElementById: (id: string) => elements.get(id)!,
    createElement: (tag = "div") => new FakeElement("", tag),
    addEventListener: () => {}
  };
  const storage = new Map<string, string>();
  let copied = "";
  let snapshot: OfficeSnapshot = {generatedAt: "x", runs: [], lobby: [{name: "session-a", branch: "main", sessionId: "s-a", diff: {files: 2, insertions: 2, deletions: 0, paths: ["a.ts", "b.ts"], recent: "a.ts"}, narration: "editing a.ts", commands: ["agent-ops worktree list"]}], reviews: []};
  const context = {
    document,
    window: {devicePixelRatio: 2, innerWidth: 1200, innerHeight: 800, matchMedia: () => ({matches: false}), addEventListener: () => {}},
    navigator: {language: "en-US", clipboard: {writeText: async (value: string) => {copied = value;}}},
    localStorage: {getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value)},
    fetch: async () => ({ok: true, json: async () => snapshot}),
    location: {search: ""},
    requestAnimationFrame: () => 0,
    setInterval: () => 0,
    console,
    Math, Promise
  };
  runInNewContext(clientScript(), context);
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  assert.equal(elements.get("room-nav")!.children.length, 1);
  assert.match(elements.get("crumb")!.textContent, /1 rooms/);
  type AvatarState = {x: number; y: number; direction?: string; walking?: boolean};
  type SceneFloor = {key: string; kind: string; phase: string; actors: {key: string; id: string; x: number; y: number; questionCount: number}[]; props: {kind: string; x: number; y: number; key: string; phase?: string}[]; phaseAreas: {phase: string; x: number; y: number; width: number; height: number}[]};
  const vm = context as unknown as {render: () => void; poll: () => void; frame: number; navPage: number; selectedKey: string; T: number; mode: string; detailPage: number; model: {roomCols: number; roomRows: number; floors: SceneFloor[]}; positions: Record<string, AvatarState>; roomCanvases: Record<string, {canvas: FakeElement}>; avatarImages: Record<string, FakeElement>; drawAvatar: (id: string, state: AvatarState, x: number, y: number, scale: number, viewer: boolean) => void; actorBox: (actor: {key: string; x: number; y: number}, surface: {x: number; y: number; width: number; height: number}) => {x: number; y: number; scale: number}; alertGeometry: (actor: {key: string; x: number; y: number; questionCount: number}, surface: {x: number; y: number; width: number; height: number}) => {x: number; y: number; width: number; height: number}; phaseAreaGeometry: (area: {x: number; y: number; width: number; height: number}, width: number, height: number) => {x: number; y: number; width: number; height: number}; progressBoardGeometry: (width: number, height: number) => {x: number; y: number; width: number; height: number}; pendingBoardGeometry: (width: number, height: number) => {x: number; y: number; width: number; height: number}; propGeometry: (prop: {x: number; y: number; kind: string}, width: number, height: number) => {x: number; y: number; width: number; height: number}; surfaceForFloor: (floor: {key: string}) => {x: number; y: number; width: number; height: number}; roomEntrances: () => {floor: {key: string}; x: number; y: number}[]; hallwayBounds: () => {x: number; width: number}; reducedMotion: boolean; supervisor: AvatarState & {targetX: number; targetY: number}; roomSupervisor: AvatarState & {targetX: number; targetY: number}};
  const drawings: {id: string; direction: string | undefined; walking: boolean | undefined; viewer: boolean; scale: number}[] = [];
  const drawAvatar = vm.drawAvatar;
  vm.drawAvatar = (id, state, x, y, scale, viewer) => {drawings.push({id, direction: state.direction, walking: state.walking, viewer, scale});drawAvatar(id, state, x, y, scale, viewer);};
  const keydownCanvas = canvas.events.get("keydown")!;
  assert.equal(canvas.width, 2364, "backing width matches full available width at DPR 2");
  assert.equal(canvas.height, 1240);
  assert.ok(canvas.paintedText.includes("You"), "English overview localizes the viewer badge");
  assert.ok(!canvas.paintedText.includes("你"));
  assert.equal(canvas.style.width, "1182px");
  assert.equal(canvas.style.height, "620px");
  const cached = Object.values(vm.roomCanvases)[0]!.canvas;
  vm.render();
  assert.equal(drawings.find(draw => draw.viewer)!.scale, Math.max(...drawings.filter(draw => !draw.viewer).map(draw => draw.scale)), "the overview viewer has the same scale as the largest room people");
  assert.ok(canvas.paintedText.some(text => text.includes("Agent")), "fixed clothes do not hide the actor role");
  assert.equal(Object.values(vm.roomCanvases)[0]!.canvas, cached, "unchanged room layers are reused");
  const startingX = vm.supervisor.targetX;
  keydownCanvas({key: "ArrowRight", preventDefault: () => {}});
  assert.ok(vm.supervisor.targetX > startingX);
  for (const [key, direction] of [["ArrowLeft", "left"], ["ArrowUp", "up"], ["ArrowDown", "down"], ["ArrowRight", "right"]]) {
    keydownCanvas({key, preventDefault: () => {}});
    assert.equal(vm.supervisor.direction, direction);
    assert.ok(drawings.some(draw => draw.viewer && draw.direction === direction), "the viewer renderer receives each facing");
  }
  vm.reducedMotion = true;
  vm.render();
  assert.equal(vm.supervisor.walking, false);
  vm.render();
  assert.equal(vm.supervisor.direction, "right", "facing persists at rest");
  canvas.paintedText.length = 0;
  for (let i = 0; i < 12; i++) keydownCanvas({key: "ArrowUp", preventDefault: () => {}});
  for (let i = 0; i < 30; i++) keydownCanvas({key: "ArrowLeft", preventDefault: () => {}});
  assert.equal(vm.mode, "room", "walking onto the doorway enters the room");
  assert.ok(canvas.paintedText.includes("You"), "English room localizes the viewer badge");
  assert.ok(!canvas.paintedText.includes("你"));
  elements.get("back")!.click();
  assert.equal(vm.mode, "overview");
  canvas.paintedText.length = 0;
  elements.get("language")!.click();
  assert.equal(elements.get("crumb")!.textContent.includes("辦公室"), true);
  assert.match(document.cookie, /agent-office-language=zh/);
  assert.ok(canvas.paintedText.includes("你"), "Chinese overview retains 你");
  assert.ok(!canvas.paintedText.includes("You"));
  assert.ok(canvas.paintedText.some(text => text.includes("成員")), "role labels follow the selected language");
  canvas.paintedText.length = 0;
  elements.get("room-nav")!.children[0]!.click();
  assert.ok(canvas.paintedText.includes("你"), "Chinese room retains 你");
  assert.ok(!canvas.paintedText.includes("You"));
  assert.equal(elements.get("back")!.hidden, false);
  keydownCanvas({key: "ArrowUp", preventDefault: () => {}});
  assert.equal(vm.roomSupervisor.direction, "up", "room movement uses directional avatars too");
  const selectedActor = vm.model.floors[0]!.actors[0]!, actorBox = vm.actorBox(selectedActor, {x: 0, y: 0, width: canvas.width, height: canvas.height});
  canvas.events.get("click")?.({clientX: actorBox.x + 16 * actorBox.scale, clientY: actorBox.y + 24 * actorBox.scale});
  assert.equal(elements.get("status")!.children[0]!.textContent, "session-a", "clicking the new avatar dimensions opens that actor's details");
  elements.get("status")!.events.get("keydown")!({key: "Escape", preventDefault: () => {}});
  // A clear floor point keeps this assertion on the generic room detail path;
  // phase-area clicks now intentionally open that phase's work list.
  canvas.events.get("click")?.({clientX: 1200, clientY: 700});
  const status = elements.get("status")!;
  assert.equal(status.hidden, false);
  const dialogButtons = status.querySelectorAll("button:not([disabled])");
  assert.ok(dialogButtons.some(button => button.textContent === "Next" || button.textContent === "下一頁"));
  const next = dialogButtons.find(button => button.textContent === "Next" || button.textContent === "下一頁")!;
  next.click();
  assert.equal((context as unknown as {detailPage: number}).detailPage, 1);
  const keydown = status.events.get("keydown")!;
  keydown({key: "Tab", shiftKey: true, preventDefault: () => {}});
  assert.ok(activeElement && status.querySelectorAll("button:not([disabled])").includes(activeElement));
  keydown({key: "Escape", preventDefault: () => {}});
  assert.equal(status.hidden, true);
  elements.get("back")!.click();
  assert.equal(elements.get("back")!.hidden, true);

  // A normal session's phase update visibly walks the same actor to its new area.
  vm.reducedMotion = false;
  const actor = vm.model.floors[0]!.actors[0]!, before = {...vm.positions[actor.key]!};
  snapshot = {...snapshot, lobby: [{...snapshot.lobby[0]!, phase: "verifying"}]};
  vm.poll(); await new Promise<void>(resolve => setTimeout(resolve, 0));
  const target = vm.model.floors[0]!.actors[0]!;
  assert.notDeepEqual(vm.positions[actor.key], before);
  assert.notEqual(vm.positions[actor.key]!.x, target.x * vm.T, "motion advances rather than teleporting");
  const moving = vm.positions[actor.key]!;
  assert.equal(moving.direction, "right", "phase motion faces toward the destination");
  assert.equal(moving.walking, true);
  vm.frame = 7; vm.render();
  assert.ok(Object.keys(vm.avatarImages).some(key => key === JSON.stringify([actor.id, "right", 1, false])), "agent walking renders the first step pose");
  vm.frame = 21; vm.render();
  assert.ok(Object.keys(vm.avatarImages).some(key => key === JSON.stringify([actor.id, "right", 3, false])), "agent walking alternates feet");
  vm.reducedMotion = true; vm.render();
  assert.equal(vm.positions[actor.key]!.x, target.x * vm.T);
  assert.equal(vm.positions[actor.key]!.walking, false);
  assert.equal(vm.positions[actor.key]!.direction, "right");

  // Every doorway connects to the same hallway, including rooms after nav page 1.
  snapshot = {...snapshot, lobby: Array.from({length: 12}, (_, index) => ({...snapshot.lobby[0]!, name: `session-${index}`, sessionId: `s-${index}`}))};
  vm.poll(); await new Promise<void>(resolve => setTimeout(resolve, 0));
  const nav = elements.get("room-nav")!;
  nav.children.find(button => button.textContent.includes("下一頁"))!.click();
  assert.equal(vm.navPage, 1);
  assert.ok(nav.children.some(button => button.textContent.includes("session-11")));
  vm.poll(); await new Promise<void>(resolve => setTimeout(resolve, 0));
  assert.equal(vm.navPage, 1, "polling does not reset the requested navigation page");
  for (const entry of vm.roomEntrances()) {
    const hall = vm.hallwayBounds();
    vm.supervisor.x = vm.supervisor.targetX = hall.x + hall.width / 2;
    // Start in the shared corridor and approach the doorway using keyboard input.
    vm.supervisor.y = vm.supervisor.targetY = 33;
    for (let n = 0; n < 40 && Math.abs(vm.supervisor.y - entry.y) > .7; n++) keydownCanvas({key: vm.supervisor.y > entry.y ? "ArrowUp" : "ArrowDown", preventDefault: () => {}});
    for (let n = 0; n < 4 && vm.mode === "overview"; n++) keydownCanvas({key: entry.x < hall.x + hall.width / 2 ? "ArrowLeft" : "ArrowRight", preventDefault: () => {}});
    assert.equal(vm.mode, "room", entry.floor.key);
    assert.equal(vm.selectedKey, entry.floor.key);
    elements.get("back")!.click();
    assert.equal(vm.mode, "overview", "Back does not immediately enter the same room");
  }

  // Full commands remain readable across pages, and copying keeps the original.
  const longCommand = "agent-ops " + "long-value-".repeat(32);
  snapshot = {...snapshot, lobby: [{...snapshot.lobby[0]!, commands: [longCommand]}]};
  vm.poll(); await new Promise<void>(resolve => setTimeout(resolve, 0));
  elements.get("room-nav")!.children[0]!.click();
  canvas.events.get("keydown")!({key: "Enter", preventDefault: () => {}});
  const pageTexts: string[] = [];
  const visit = (node: FakeElement) => { if(node.tagName === "CODE") {pageTexts.push(node.textContent);node.children[0]?.click();} for(const child of node.children) visit(child); };
  for (let page = 0; page < 20; page++) {
    visit(status);
    const copy = status.querySelectorAll("button").find(button => button.textContent === "複製");
    if (copy) {copy.click(); await Promise.resolve(); assert.equal(copied, longCommand);}
    const nextPage = status.querySelectorAll("button").find(button => button.textContent === "下一頁");
    if(!nextPage)break;
    nextPage.click();
  }
  assert.equal(pageTexts.join(""), longCommand);
  const focused = activeElement;
  vm.poll(); await new Promise<void>(resolve => setTimeout(resolve, 0));
  assert.equal(activeElement, focused, "unchanged polling preserves dialog focus");

  // Both boards expose the same complete room work list, while actor hits keep priority.
  status.events.get("keydown")!({key: "Escape", preventDefault: () => {}});
  if (vm.mode === "room") elements.get("back")!.click();
  snapshot = {
    generatedAt: "x",
    runs: [{runId: "team-room", title: "team-room", status: "running", phase: "implementing",
      budget: {limitMs: 1000, usedMs: 400, remainingMs: 600},
      questions: [{questionId: "q-team", prompt: "Choose a port"}],
      agents: [
        {id: "lead", role: "coordinator", status: "running", phase: "planning", taskId: "task-lead", progress: {passed: 2, total: 4, verify: "PASS", review: null}, worktree: "coord", diff: {files: 2, insertions: 2, deletions: 0, paths: ["src/lead.ts"], recent: "src/lead.ts"}, narration: "editing src/lead.ts"},
        {id: "builder", role: "worker", status: "verifying", phase: "verifying", taskId: "task-build", progress: {passed: 1, total: 3, verify: null, review: null}, worktree: "worker", diff: {files: 1, insertions: 1, deletions: 0, paths: ["tests/build.ts"], recent: "tests/build.ts"}, narration: "writing tests"}
      ],
      reviewers: [{slot: 1, since: "2026-10-07T00:00:00.000Z", taskId: "review-task", root: null}], commands: ["agent-ops run status team-room"]}],
    lobby: [{name: "ordinary", branch: "main", sessionId: "ordinary", diff: {files: 1, insertions: 1, deletions: 0, paths: ["src/ordinary.ts"], recent: "src/ordinary.ts"}, narration: "editing src/ordinary.ts", commands: ["agent-ops worktree list"], phase: "implementing", status: "running", taskId: "ordinary-task", progress: {passed: 1, total: 2, verify: null, review: null}, questions: [{questionId: "q-ordinary", prompt: "Pick a reviewer"}], host: "codex"}],
    reviews: []
  };
  vm.poll(); await new Promise<void>(resolve => setTimeout(resolve, 0));
  const team = vm.model.floors.find(floor => floor.kind === "run")!;
  const teamOverview = vm.surfaceForFloor(team), overviewBoard = vm.progressBoardGeometry(teamOverview.width, teamOverview.height);
  canvas.events.get("click")?.({clientX: teamOverview.x + overviewBoard.x + overviewBoard.width / 2, clientY: teamOverview.y + overviewBoard.y + overviewBoard.height * .25});
  assert.equal(status.hidden, false);
  assert.match(status.children[0]!.textContent, /工作清單/u);
  const workPages: string[] = [];
  for (let page = 0; page < 30; page++) {
    workPages.push(treeText(status));
    const next = status.querySelectorAll("button:not([disabled])").find(button => button.textContent === "下一頁");
    if (!next) break;
    next.click();
  }
  const workText = workPages.join("");
  for (const value of ["lead", "builder", "reviewer 1", "src/lead.ts", "Choose a port", "驗證", "進度"]) assert.ok(workText.includes(value), `work list includes ${value}`);
  status.events.get("keydown")!({key: "Escape", preventDefault: () => {}});
  assert.equal(status.hidden, true);
  assert.equal(activeElement, canvas, "Escape returns focus to the canvas after an overview board click");
  keydownCanvas({key: "l", preventDefault: () => {}});
  assert.match(status.children[0]!.textContent, /工作清單/u, "L opens the selected room work list from the overview");
  status.events.get("keydown")!({key: "Escape", preventDefault: () => {}});

  const teamButton = elements.get("room-nav")!.children.find(button => button.textContent.includes("team-room"))!;
  teamButton.click();
  const teamRoom = vm.model.floors.find(floor => floor.kind === "run")!, lead = teamRoom.actors.find(actor => actor.id === "lead")!;
  const leadBox = vm.actorBox(lead, {x: 0, y: 0, width: canvas.width, height: canvas.height});
  canvas.events.get("click")?.({clientX: leadBox.x + 16 * leadBox.scale, clientY: leadBox.y + 24 * leadBox.scale});
  assert.equal(status.children[0]!.textContent, "lead", "actor clicks win over the planning whiteboard");
  status.events.get("keydown")!({key: "Escape", preventDefault: () => {}});
  elements.get("back")!.click();
  const ordinaryButton = elements.get("room-nav")!.children.find(button => button.textContent.includes("ordinary"))!;
  ordinaryButton.click();
  const ordinary = vm.model.floors.find(floor => floor.kind === "desk")!, whiteboard = ordinary.props.find(prop => prop.kind === "whiteboard")!;
  const whiteboardRect = vm.propGeometry(whiteboard, canvas.width, canvas.height);
  canvas.events.get("click")?.({clientX: whiteboardRect.x + whiteboardRect.width / 2, clientY: whiteboardRect.y + whiteboardRect.height / 2});
  assert.match(status.children[0]!.textContent, /工作清單/u);
  const detailWorkPages: string[] = [];
  for (let page = 0; page < 20; page++) {
    detailWorkPages.push(treeText(status));
    const next = status.querySelectorAll("button:not([disabled])").find(button => button.textContent === "下一頁");
    if (!next) break;
    next.click();
  }
  assert.ok(detailWorkPages.join("").includes("Pick a reviewer"), "detail-room whiteboard includes pending questions");
  status.events.get("keydown")!({key: "Escape", preventDefault: () => {}});
  assert.equal(activeElement, canvas, "Escape restores focus after an enlarged-room whiteboard click");
  elements.get("language")!.click();
  vm.detailPage = 0;
  keydownCanvas({key: "L", preventDefault: () => {}});
  assert.match(status.children[0]!.textContent, /Work list/u);
  const englishPages: string[] = [];
  for (let page = 0; page < 20; page++) {
    englishPages.push(treeText(status));
    const next = status.querySelectorAll("button:not([disabled])").find(button => button.textContent === "Next");
    if (!next) break;
    next.click();
  }
  const englishText = englishPages.join("");
  assert.ok(englishText.includes("Owner") && englishText.includes("Current work"), "English work list localizes owner and current work");
  status.events.get("keydown")!({key: "Escape", preventDefault: () => {}});

  // Keyboard phase/question views use the same bounded, focusable dialog.
  keydownCanvas({key: "q", preventDefault: () => {}});
  assert.match(status.children[0]!.textContent, /Questions/u);
  assert.ok(treeText(status).includes("Pick a reviewer"));
  status.events.get("keydown")!({key: "Escape", preventDefault: () => {}});
  keydownCanvas({key: "3", preventDefault: () => {}});
  assert.match(status.children[0]!.textContent, /Verifying/u);
  assert.ok(treeText(status).includes("No known work is in this phase"));
  status.events.get("keydown")!({key: "Escape", preventDefault: () => {}});
  keydownCanvas({key: "q", ctrlKey: true, preventDefault: () => {}});
  assert.equal(status.hidden, true, "modified shortcuts remain available to the browser");

  // Overview alert, pending row, and phase surfaces all open read-only views.
  elements.get("back")!.click();
  const overviewTeam = vm.model.floors.find(floor => floor.kind === "run")!;
  const overviewSurface = vm.surfaceForFloor(overviewTeam);
  const leadOverview = overviewTeam.actors.find(actor => actor.id === "lead")!;
  const spriteVm = context as unknown as {draw: (kind: string, x: number, y: number) => void};
  const spriteDraw = spriteVm.draw, previousMotion = vm.reducedMotion;
  let alertDraws = 0;
  spriteVm.draw = (kind, x, y) => {if (kind === "alert") alertDraws++;spriteDraw(kind, x, y);};
  vm.reducedMotion = false;vm.frame = 21;vm.render();
  spriteVm.draw = spriteDraw;vm.reducedMotion = previousMotion;
  assert.ok(alertDraws > 0, "clickable pending prompts stay visible throughout animation");
  const overviewAlert = vm.alertGeometry(leadOverview, overviewSurface);
  canvas.events.get("click")?.({clientX: overviewAlert.x + overviewAlert.width / 2, clientY: overviewAlert.y + overviewAlert.height / 2});
  assert.match(status.children[0]!.textContent, /Questions/u);
  assert.ok(treeText(status).includes("Choose a port"));
  status.events.get("keydown")!({key: "Escape", preventDefault: () => {}});
  const overviewPending = vm.pendingBoardGeometry(overviewSurface.width, overviewSurface.height);
  canvas.events.get("click")?.({clientX: overviewSurface.x + overviewPending.x + overviewPending.width / 2, clientY: overviewSurface.y + overviewPending.y + overviewPending.height / 2});
  assert.match(status.children[0]!.textContent, /Questions/u);
  status.events.get("keydown")!({key: "Escape", preventDefault: () => {}});
  const verifyingArea = overviewTeam.phaseAreas.find(area => area.phase === "verifying")!;
  const verifyingRect = vm.phaseAreaGeometry(verifyingArea, overviewSurface.width, overviewSurface.height);
  canvas.events.get("click")?.({clientX: overviewSurface.x + verifyingRect.x + verifyingRect.width / 2, clientY: overviewSurface.y + verifyingRect.y + verifyingRect.height * .9});
  assert.match(status.children[0]!.textContent, /Verifying/u);
  assert.ok(treeText(status).includes("builder"));
  status.events.get("keydown")!({key: "Escape", preventDefault: () => {}});
  const integratingArea = overviewTeam.phaseAreas.find(area => area.phase === "integrating")!;
  const integratingRect = vm.phaseAreaGeometry(integratingArea, overviewSurface.width, overviewSurface.height);
  canvas.events.get("click")?.({clientX: overviewSurface.x + integratingRect.x + integratingRect.width * .95, clientY: overviewSurface.y + integratingRect.y + integratingRect.height * .9});
  assert.match(status.children[0]!.textContent, /Integrating/u);
  assert.ok(treeText(status).includes("No known work is in this phase"));
  status.events.get("keydown")!({key: "Escape", preventDefault: () => {}});

  // In the enlarged room, a workstation with a known phase opens that phase,
  // while the viewer can still use the existing whiteboard/work-list path.
  const overviewTeamButton = elements.get("room-nav")!.children.find(button => button.textContent.includes("team-room"))!;
  overviewTeamButton.click();
  const detailTeam = vm.model.floors.find(floor => floor.kind === "run")!, detailVerifyArea = detailTeam.phaseAreas.find(area => area.phase === "verifying")!;
  const detailBench = detailTeam.props.find(prop => prop.kind === "bench")!, benchRect = vm.propGeometry(detailBench, canvas.width, canvas.height);
  canvas.events.get("click")?.({clientX: benchRect.x + benchRect.width * .9, clientY: benchRect.y + benchRect.height * .9});
  assert.match(status.children[0]!.textContent, /Verifying/u);
  assert.ok(treeText(status).includes("builder"));
  status.events.get("keydown")!({key: "Escape", preventDefault: () => {}});
  const detailVerify = vm.phaseAreaGeometry(detailVerifyArea, canvas.width, canvas.height);
  canvas.events.get("click")?.({clientX: detailVerify.x + detailVerify.width * .95, clientY: detailVerify.y + detailVerify.height * .9});
  assert.match(status.children[0]!.textContent, /Verifying/u);
  assert.ok(treeText(status).includes("builder"));
  status.events.get("keydown")!({key: "Escape", preventDefault: () => {}});

  // Many prompts and a command are all reachable through question paging.
  const manyQuestions = Array.from({length: 12}, (_, index) => ({questionId: `q-${index}`, prompt: `Prompt ${index}`}));
  snapshot = {...snapshot, runs: snapshot.runs.map(run => ({...run, questions: manyQuestions}))};
  vm.poll(); await new Promise<void>(resolve => setTimeout(resolve, 0));
  const refreshedTeam = vm.model.floors.find(floor => floor.kind === "run")!, refreshedLead = refreshedTeam.actors.find(actor => actor.id === "lead")!, refreshedAlert = vm.alertGeometry(refreshedLead, {x: 0, y: 0, width: canvas.width, height: canvas.height});
  canvas.events.get("click")?.({clientX: refreshedAlert.x + refreshedAlert.width / 2, clientY: refreshedAlert.y + refreshedAlert.height / 2});
  const questionPages: string[] = [];
  for (let page = 0; page < 20; page++) {
    questionPages.push(treeText(status));
    const next = status.querySelectorAll("button:not([disabled])").find(button => button.textContent === "Next");
    if (!next) break;
    next.click();
  }
  const questionText = questionPages.join("");
  assert.ok(questionText.includes("Prompt 0") && questionText.includes("Prompt 11") && questionText.includes("agent-ops run status team-room"));
  vm.detailPage = 0;
  keydownCanvas({key: "q", preventDefault: () => {}});
  const budgetNext = status.querySelectorAll("button:not([disabled])").find(button => button.textContent === "Next")!;
  budgetNext.click();
  const budgetPage = vm.detailPage, budgetFocus = activeElement;
  snapshot = {...snapshot, runs: snapshot.runs.map(run => ({...run, budget: {...run.budget, usedMs: run.budget.usedMs + 10, remainingMs: Math.max(0, run.budget.remainingMs - 10)}}))};
  vm.poll(); await new Promise<void>(resolve => setTimeout(resolve, 0));
  assert.equal(vm.detailPage, budgetPage, "budget-only polling preserves the question page");
  assert.equal(activeElement, budgetFocus, "budget-only polling preserves dialog focus");
  status.events.get("keydown")!({key: "Escape", preventDefault: () => {}});
  elements.get("back")!.click();

  // Extra desks carry the full actor id, so equal short labels cannot select
  // the wrong worker when their workstation is clicked.
  const duplicateRun = {...snapshot.runs[0]!, runId: "duplicate-room", title: "duplicate-room", questions: [], agents: [
    {...snapshot.runs[0]!.agents[0]!, id: "shared-worker-name-alpha", role: "coordinator" as const, phase: "implementing" as const, diff: {files: 1, insertions: 1, deletions: 0, paths: ["src/alpha.ts"], recent: "src/alpha.ts"}, narration: "editing src/alpha.ts"},
    {...snapshot.runs[0]!.agents[1]!, id: "shared-worker-name-beta", role: "worker" as const, phase: "implementing" as const, diff: {files: 1, insertions: 1, deletions: 0, paths: ["src/beta.ts"], recent: "src/beta.ts"}, narration: "editing src/beta.ts"}
  ]};
  snapshot = {generatedAt: "x", runs: [duplicateRun], lobby: [], reviews: []};
  vm.poll(); await new Promise<void>(resolve => setTimeout(resolve, 0));
  const duplicateFloor = vm.model.floors[0]!, extraDesk = duplicateFloor.props.find(prop => prop.key === "duplicate-room:desk:shared-worker-name-beta")!;
  const duplicateSurface = vm.surfaceForFloor(duplicateFloor), extraRect = vm.propGeometry(extraDesk, duplicateSurface.width, duplicateSurface.height);
  canvas.events.get("click")?.({clientX: duplicateSurface.x + extraRect.x + extraRect.width / 2, clientY: duplicateSurface.y + extraRect.y + extraRect.height / 2});
  const deskPages: string[] = [];
  for (let page = 0; page < 10; page++) {
    deskPages.push(treeText(status));
    const next = status.querySelectorAll("button:not([disabled])").find(button => button.textContent === "Next");
    if (!next) break;
    next.click();
  }
  assert.ok(deskPages.join("").includes("src/beta.ts"), "the exact desk key opens the matching actor details");
  snapshot = {generatedAt: "x", runs: [], lobby: [], reviews: []};
  vm.poll(); await new Promise<void>(resolve => setTimeout(resolve, 0));
  assert.equal(status.hidden, true, "a disappeared room closes its stale dialog");
  assert.equal(vm.mode, "overview", "a disappeared room returns to the overview");
  assert.equal(activeElement, canvas, "closing a disappeared room returns focus to the canvas");
  status.events.get("keydown")!({key: "Escape", preventDefault: () => {}});
});

test("rooms from several repositories wear nameplates and filter by repository", async () => {
  const ids = ["office", "dialogue", "status", "room-nav", "crumb", "back", "recent", "repo-filter", "language", "live", "work-list", "work-heading", "work-summary", "flow"];
  const elements = new Map(ids.map(id => [id, new FakeElement(id)]));
  elements.get("status")!.hidden = true;
  elements.get("repo-filter")!.hidden = true;
  const canvas = elements.get("office")!;
  canvas.width = 576; canvas.height = 304;
  const desk = (repo: string) => ({name: "session-a", branch: "main", sessionId: "same", repo, narration: "editing",
    diff: {files: 0, insertions: 0, deletions: 0, paths: [], recent: null}, commands: []});
  const snapshot: OfficeSnapshot = {generatedAt: "x", runs: [], lobby: [desk("shop"), desk("api")], reviews: []};
  const created: FakeElement[] = [];
  const context = {
    document: {cookie: "", activeElement: null, getElementById: (id: string) => elements.get(id)!, createElement: (tag = "div") => { const element = new FakeElement("", tag); created.push(element); return element; }, addEventListener: () => {}},
    window: {devicePixelRatio: 1, innerWidth: 1200, innerHeight: 800, matchMedia: () => ({matches: false}), addEventListener: () => {}},
    navigator: {language: "en-US", clipboard: {writeText: async () => {}}},
    localStorage: {getItem: () => null, setItem: () => {}},
    fetch: async () => ({ok: true, json: async () => snapshot}),
    location: {search: ""}, requestAnimationFrame: () => 0, setInterval: () => 0, console, Math, Promise
  };
  runInNewContext(clientScript(), context);
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  const filter = elements.get("repo-filter")!;
  assert.equal(filter.hidden, false);
  assert.deepEqual(filter.children.map(option => option.value), ["", "api", "shop"]);
  assert.equal(elements.get("room-nav")!.children.length, 2);
  assert.match(treeText(elements.get("room-nav")!), /api · session-a/u);
  assert.ok(treeText(elements.get("work-list")!).includes("shop") && treeText(elements.get("work-list")!).includes("api"), "the work list keeps repository context visible");
  // Boards are painted on each room's own canvas.
  const painted = created.flatMap(element => element.paintedText);
  assert.ok(painted.includes("No task"), "a room without a task says so");
  assert.ok(!painted.some(text => /^Verify /u.test(text)), "and claims no pending verify or review");
  filter.value = "shop";
  filter.events.get("change")!();
  assert.equal(elements.get("room-nav")!.children.length, 1);
  assert.match(treeText(elements.get("room-nav")!), /shop · session-a/u);
  assert.match(elements.get("crumb")!.textContent, /1 rooms/u);
  assert.doesNotMatch(treeText(elements.get("work-list")!), /api/u);
});

test("eight sessions keep full identities, honest proof states and actionable read-only details", async () => {
  const ids = ["office", "dialogue", "status", "room-nav", "crumb", "back", "recent", "repo-filter", "language", "live", "work-list", "work-heading", "work-summary", "flow"];
  const elements = new Map(ids.map(id => [id, new FakeElement(id)]));
  elements.get("status")!.hidden = true;
  const names = Array.from({length: 8}, (_, index) => `shared-session-name-long-enough-to-truncate-${index}`);
  let snapshot: OfficeSnapshot = {generatedAt: "x", runs: [], reviews: [], lobby: names.map((name, index) => ({
    name, sessionId: name, branch: "main", narration: `editing src/work-${index}.ts`, phase: "verifying",
    status: index === 7 ? "blocked" : "active", taskId: `task-${index}`,
    progress: {passed: 2, total: 2, verify: "PASS", review: null},
    questions: index === 7 ? [{questionId: "q-7", prompt: "Which version should ship?"}] : [],
    diff: {files: 1, insertions: 1, deletions: 0, paths: [`src/work-${index}.ts`], recent: null},
    commands: [`agent-ops task status --session ${name}`]
  }))};
  let offline = false, copied = "", clipboardFailure = false;
  const context = {
    document: {cookie: "", get activeElement() { return activeElement; }, getElementById: (id: string) => elements.get(id)!, createElement: (tag = "div") => new FakeElement("", tag), addEventListener: () => {}},
    window: {devicePixelRatio: 2, innerWidth: 1440, innerHeight: 900, matchMedia: () => ({matches: false}), addEventListener: () => {}},
    navigator: {language: "zh-TW", clipboard: {writeText: async (value: string) => {if(clipboardFailure)throw new Error("unavailable");copied = value;}}},
    localStorage: {getItem: () => null, setItem: () => {}},
    fetch: async () => {if(offline)throw new Error("offline");return {ok: true, json: async () => snapshot};},
    location: {search: ""}, requestAnimationFrame: () => 0, setInterval: () => 0, console, Math, Promise
  };
  runInNewContext(clientScript(), context);
  const vm = context as unknown as {poll: () => void; shortName: (name: string, limit: number) => string; progressBoardGeometry: (width: number, height: number) => {x: number; y: number; width: number; height: number}; phaseAreaGeometry: (area: object, width: number, height: number) => {x: number; y: number}; model: {floors: {phaseAreas: {x: number; y: number}[]}[]}};
  const refresh = async () => {vm.poll();await new Promise<void>(resolve => setTimeout(resolve, 0));};
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  const list = elements.get("work-list")!, status = elements.get("status")!;
  assert.equal(list.children.length, 8);
  assert.equal(list.children[0]!.children[0]!.textContent, names[7] + " ↗", "the pending answer is first");
  for (const name of names) assert.ok(treeText(list).includes(name));
  assert.notEqual(vm.shortName(names[0]!,14),vm.shortName(names[1]!,14),"small scene badges retain the distinguishing suffix");
  assert.match(treeText(list), /驗收條件 2\/2 · 驗證 PASS · 審查 尚未完成/u);
  assert.match(treeText(list), /進行中 · 尚未完成/u);
  assert.match(treeText(list), /Which version should ship\?/u);
  assert.equal(elements.get("flow")!.children.map(step => step.textContent).join(" → "), "1 規劃 → 2 開發 → 3 驗證 → 4 審查 → 5 整合");
  for (const [width, height] of [[2880, 1600], [980, 280], [220, 160]]) {
    const board = vm.progressBoardGeometry(width!, height!);
    for (const area of vm.model.floors[0]!.phaseAreas) {
      const rect = vm.phaseAreaGeometry(area, width!, height!);
      assert.ok(board.y + board.height < rect.y, "the board never reaches a phase heading");
    }
  }
  const first = list.children[0]!.children[0]!;
  first.focus();
  await refresh();
  assert.equal(list.children[0]!.children[0], first, "unchanged polling preserves the card and keyboard focus");
  snapshot = {...snapshot, lobby: snapshot.lobby.map(desk => ({...desk, narration: "writing tests"}))};
  await refresh();
  assert.equal(activeElement, list.children[0]!.children[0], "changed polling restores focus to the same actor");
  assert.match(treeText(list), /撰寫測試/u);
  list.children[0]!.children[0]!.click();
  assert.equal(status.children[0]!.textContent, names[7], "detail titles retain the full identity");
  const pages: string[] = [];
  for(let page=0;page<10;page++){
    pages.push(treeText(status));
    const copy = status.querySelectorAll("button:not([disabled])").find(button => button.textContent === "複製");
    if(copy){copy.click();await Promise.resolve();}
    const next = status.querySelectorAll("button:not([disabled])").find(button => button.textContent === "下一頁");
    if(!next)break;next.click();
  }
  assert.ok(pages.join("").includes("src/work-7.ts"));
  assert.equal(copied, snapshot.lobby[7]!.commands[0]);
  clipboardFailure = true;
  const copyButton=status.querySelectorAll("button:not([disabled])").find(button=>button.textContent==="已複製")!;
  copyButton.click();await Promise.resolve();
  assert.equal(copyButton.textContent,"手動複製","clipboard denial exposes a manual fallback");
  assert.match(copyButton.getAttribute('aria-label')!,/無法存取剪貼簿/u);
  clipboardFailure=false;
  status.events.get("keydown")!({key: "Escape", preventDefault: () => {}});
  const question = list.children[0]!.querySelectorAll("button").find(button => button.textContent.includes("查看問題"))!;
  question.click();
  assert.match(treeText(status), /Which version should ship\?/u);
  status.events.get("keydown")!({key: "Escape", preventDefault: () => {}});
  offline = true;await refresh();
  assert.match(elements.get("work-summary")!.textContent, /最後已知狀態/u);
  offline = false;
  snapshot = {...snapshot, lobby: snapshot.lobby.map((desk, index) => index === 7 ? {...desk, questions: [], status: "active", progress: {...desk.progress!, verify: "FAIL"}} : desk)};
  await refresh();
  assert.match(treeText(list.children[0]!), /驗證未通過/u);
  snapshot = {...snapshot, lobby: [{...snapshot.lobby[0]!, taskId: null, progress: null}]};
  await refresh();
  assert.match(treeText(list), /無任務/u);
  assert.doesNotMatch(treeText(list), /PASS/u);
  elements.get("language")!.click();
  assert.match(treeText(list), /No task/u);
  const completed = {...snapshot.lobby[0]!, name: "completed-session", status: "complete", completedAt: "2026-10-08T00:00:00.000Z"};
  snapshot = {...snapshot, lobby: [...snapshot.lobby, completed]};await refresh();
  assert.doesNotMatch(treeText(list), /completed-session/u);
  elements.get("recent")!.click();
  assert.match(treeText(list), /completed-session/u);
  assert.match(treeText(list), /complete/u);
  elements.get("recent")!.click();
  assert.doesNotMatch(treeText(list), /completed-session/u);

  // A repository prefix must not disconnect a team from its commands.
  const command = "agent-ops run status scoped-team";
  snapshot = {generatedAt: "x", lobby: [], reviews: [], runs: [{runId: "scoped-team", repo: "shop", title: "scoped-team",
    status: "active", phase: "implementing", budget: {limitMs: 1000, usedMs: 0, remainingMs: 1000}, questions: [], reviewers: [], commands: [command],
    agents: [{id: names[0]!, role: "coordinator", status: "running", phase: "implementing", taskId: "team-task", progress: null, worktree: null, diff: null, narration: "writing tests"}]}]};
  await refresh();list.children[0]!.children[0]!.click();
  for(let page=0;page<10;page++){
    const copy=status.querySelectorAll("button:not([disabled])").find(button=>button.textContent==="Copy");
    if(copy){copy.click();await Promise.resolve();break;}
    const next=status.querySelectorAll("button:not([disabled])").find(button=>button.textContent==="Next");
    assert.ok(next);next.click();
  }
  assert.equal(copied, command);
  status.events.get("keydown")!({key: "Escape", preventDefault: () => {}});
  snapshot = {...snapshot, runs: []};await refresh();
  assert.match(treeText(list), /The office is quiet/u);
});
