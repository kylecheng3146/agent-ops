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

test("the inline client bootstraps rooms, keyboard controls and remembered language", async () => {
  const ids = ["office", "dialogue", "status", "room-nav", "crumb", "back", "recent", "language", "live"];
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
  const vm = context as unknown as {render: () => void; poll: () => void; frame: number; navPage: number; selectedKey: string; T: number; model: {roomCols: number; roomRows: number; floors: {key: string; actors: {key: string; id: string; x: number; y: number}[]}[]}; positions: Record<string, AvatarState>; roomCanvases: Record<string, {canvas: FakeElement}>; avatarImages: Record<string, FakeElement>; drawAvatar: (id: string, state: AvatarState, x: number, y: number, scale: number, viewer: boolean) => void; actorBox: (actor: {key: string; x: number; y: number}, surface: {x: number; y: number; width: number; height: number}) => {x: number; y: number; scale: number}; roomEntrances: () => {floor: {key: string}; x: number; y: number}[]; hallwayBounds: () => {x: number; width: number}; mode: string; reducedMotion: boolean; supervisor: AvatarState & {targetX: number; targetY: number}; roomSupervisor: AvatarState & {targetX: number; targetY: number}};
  const drawings: {id: string; direction: string | undefined; walking: boolean | undefined; viewer: boolean; scale: number}[] = [];
  const drawAvatar = vm.drawAvatar;
  vm.drawAvatar = (id, state, x, y, scale, viewer) => {drawings.push({id, direction: state.direction, walking: state.walking, viewer, scale});drawAvatar(id, state, x, y, scale, viewer);};
  const keydownCanvas = canvas.events.get("keydown")!;
  assert.equal(canvas.width, 2364, "backing width matches full available width at DPR 2");
  assert.equal(canvas.height, 1312);
  assert.ok(canvas.paintedText.includes("你"), "the viewer badge displays only 你");
  assert.equal(canvas.style.width, "1182px");
  assert.equal(canvas.style.height, "656px");
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
  for (let i = 0; i < 12; i++) keydownCanvas({key: "ArrowUp", preventDefault: () => {}});
  for (let i = 0; i < 30; i++) keydownCanvas({key: "ArrowLeft", preventDefault: () => {}});
  assert.equal(vm.mode, "room", "walking onto the doorway enters the room");
  elements.get("back")!.click();
  assert.equal(vm.mode, "overview");
  elements.get("language")!.click();
  assert.equal(elements.get("crumb")!.textContent.includes("辦公室"), true);
  assert.match(document.cookie, /agent-office-language=zh/);
  assert.ok(canvas.paintedText.some(text => text.includes("成員")), "role labels follow the selected language");
  elements.get("room-nav")!.children[0]!.click();
  assert.equal(elements.get("back")!.hidden, false);
  keydownCanvas({key: "ArrowUp", preventDefault: () => {}});
  assert.equal(vm.roomSupervisor.direction, "up", "room movement uses directional avatars too");
  const selectedActor = vm.model.floors[0]!.actors[0]!, actorBox = vm.actorBox(selectedActor, {x: 0, y: 0, width: canvas.width, height: canvas.height});
  canvas.events.get("click")?.({clientX: actorBox.x + 16 * actorBox.scale, clientY: actorBox.y + 24 * actorBox.scale});
  assert.equal(elements.get("status")!.children[0]!.textContent, "session-a", "clicking the new avatar dimensions opens that actor's details");
  elements.get("status")!.events.get("keydown")!({key: "Escape", preventDefault: () => {}});
  canvas.events.get("click")?.({clientX: 560, clientY: 300});
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
});
