import assert from "node:assert/strict";
import {runInNewContext} from "node:vm";
import test from "node:test";

import {officePage} from "../../runtime/src/office/page.js";

class FakeElement {
  readonly id: string;
  readonly children: FakeElement[] = [];
  readonly style: Record<string, string> = {};
  readonly events = new Map<string, (event?: unknown) => void>();
  textContent = "";
  hidden = false;
  className = "";
  disabled = false;
  value = "";
  width = 0;
  height = 0;
  constructor(id = "") { this.id = id; }
  appendChild(child: FakeElement): FakeElement { this.children.push(child); return child; }
  addEventListener(name: string, handler: (event?: unknown) => void): void { this.events.set(name, handler); }
  setAttribute(): void {}
  focus(): void {}
  click(): void { this.events.get("click")?.({}); }
  getBoundingClientRect(): {left: number; top: number; width: number; height: number} { return {left: 0, top: 0, width: this.width, height: this.height}; }
}

function clientScript(): string {
  const page = officePage("nonce");
  return page.match(/<script[^>]*>([\s\S]*)<\/script>/u)![1]!;
}

test("the inline client bootstraps rooms, keyboard controls and remembered language", async () => {
  const ids = ["office", "dialogue", "status", "room-nav", "crumb", "back", "recent", "language", "live"];
  const elements = new Map(ids.map(id => [id, new FakeElement(id)]));
  const canvas = elements.get("office")!;
  canvas.width = 576; canvas.height = 304;
  (canvas as FakeElement & {getContext: () => object}).getContext = () => new Proxy({}, {get: () => () => {}});
  const document = {
    cookie: "",
    getElementById: (id: string) => elements.get(id)!,
    createElement: () => new FakeElement(),
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
  elements.get("language")!.click();
  assert.equal(elements.get("crumb")!.textContent.includes("辦公室"), true);
  assert.match(document.cookie, /agent-office-language=zh/);
  elements.get("room-nav")!.children[0]!.click();
  assert.equal(elements.get("back")!.hidden, false);
  elements.get("back")!.click();
  assert.equal(elements.get("back")!.hidden, true);
});
