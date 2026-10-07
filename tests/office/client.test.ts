import assert from "node:assert/strict";
import {runInNewContext} from "node:vm";
import test from "node:test";

import {officePage} from "../../runtime/src/office/page.js";

class FakeElement {
  readonly id: string;
  readonly tagName: string;
  readonly children: FakeElement[] = [];
  readonly style: Record<string, string> = {};
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
  (canvas as FakeElement & {getContext: () => object}).getContext = () => new Proxy({}, {get: () => () => {}});
  const document = {
    cookie: "",
    get activeElement() { return activeElement; },
    getElementById: (id: string) => elements.get(id)!,
    createElement: (tag = "div") => new FakeElement("", tag),
    addEventListener: () => {}
  };
  const storage = new Map<string, string>();
  const snapshot = {generatedAt: "x", runs: [], lobby: [{name: "session-a", branch: "main", sessionId: "s-a", diff: {files: 2, insertions: 2, deletions: 0, paths: ["a.ts", "b.ts"], recent: "a.ts"}, narration: "editing a.ts", commands: ["agent-ops worktree list"]}], reviews: []};
  const context = {
    document,
    window: {innerWidth: 1200, innerHeight: 800, matchMedia: () => ({matches: false}), addEventListener: () => {}},
    navigator: {language: "en-US", clipboard: {writeText: async () => {}}},
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
  const vm = context as unknown as {mode: string; reducedMotion: boolean; supervisor: {x: number; y: number; targetX: number; targetY: number}};
  const keydownCanvas = canvas.events.get("keydown")!;
  const startingX = vm.supervisor.targetX;
  keydownCanvas({key: "ArrowRight", preventDefault: () => {}});
  assert.ok(vm.supervisor.targetX > startingX);
  vm.reducedMotion = true;
  for (let i = 0; i < 12; i++) keydownCanvas({key: "ArrowUp", preventDefault: () => {}});
  for (let i = 0; i < 30; i++) keydownCanvas({key: "ArrowLeft", preventDefault: () => {}});
  assert.equal(vm.mode, "room", "walking onto the doorway enters the room");
  elements.get("back")!.click();
  assert.equal(vm.mode, "overview");
  elements.get("language")!.click();
  assert.equal(elements.get("crumb")!.textContent.includes("辦公室"), true);
  assert.match(document.cookie, /agent-office-language=zh/);
  elements.get("room-nav")!.children[0]!.click();
  assert.equal(elements.get("back")!.hidden, false);
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
});
