import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  selectOption,
  selectOptions,
  selectYesNo,
  writeBanner
} from "../../packages/cli/src/ui.js";

class FakeOutput extends EventEmitter {
  chunks: string[] = [];
  columns?: number;
  write(value: string): boolean {
    this.chunks.push(value);
    return true;
  }
  get text(): string {
    return this.chunks.join("");
  }
}

class FakeRawInput extends EventEmitter {
  isTTY = true;
  rawMode = false;
  setRawMode(mode: boolean): void {
    this.rawMode = mode;
  }
  resume(): void {}
  pause(): void {}
  pressKey(name: string, extra: Record<string, unknown> = {}): void {
    this.emit("keypress", undefined, { name, ...extra });
  }
}

test("writeBanner stays silent when not interactive", () => {
  const output = new FakeOutput();
  writeBanner({ isTTY: false, write: (v) => output.write(v) });
  assert.equal(output.text, "");
});

test("writeBanner stays silent in a narrow terminal", () => {
  const output = new FakeOutput();
  writeBanner({ isTTY: true, columns: 40, write: (v) => output.write(v) });
  assert.equal(output.text, "");
});

test("writeBanner renders the wordmark on a wide interactive terminal", () => {
  const output = new FakeOutput();
  writeBanner({ isTTY: true, columns: 80, write: (v) => output.write(v) });
  assert.match(output.text, /loop engineering toolkit/);
});

class FakeNonRawInput extends EventEmitter {
  isTTY = false;
  resume(): void {}
  pause(): void {}
}

test("selectYesNo falls back to a typed prompt when stdin cannot go raw", async () => {
  const input = new FakeNonRawInput();
  const output = new FakeOutput();
  const resultPromise = selectYesNo(
    "Proceed?",
    { input: input as never, output: output as never },
    false
  );
  setTimeout(() => input.emit("data", "yes\n"), 10);
  assert.equal(await resultPromise, true);
});

test("selectYesNo toggles with arrow keys and confirms on return", async () => {
  const input = new FakeRawInput();
  const output = new FakeOutput();
  const resultPromise = selectYesNo(
    "Overwrite existing installation?",
    { input: input as never, output: output as never },
    false
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(input.rawMode, true);
  assert.match(output.text, /No/);

  input.pressKey("left");
  input.pressKey("return");
  assert.equal(await resultPromise, true);
  assert.equal(input.rawMode, false);
});

test("selectOption moves between choices and confirms on return", async () => {
  const input = new FakeRawInput();
  const output = new FakeOutput();
  const resultPromise = selectOption(
    "Scope",
    [
      { label: "project", value: "project" },
      { label: "user", value: "user" }
    ],
    { input: input as never, output: output as never }
  );
  await new Promise((resolve) => setImmediate(resolve));
  input.pressKey("down");
  input.pressKey("return");
  assert.equal(await resultPromise, "user");
  assert.match(output.text, /Scope/);
  assert.equal(input.rawMode, false);
});

test("selectOptions toggles multiple choices with space", async () => {
  const input = new FakeRawInput();
  const output = new FakeOutput();
  const resultPromise = selectOptions(
    "Profiles",
    [
      { label: "core", value: "core" },
      { label: "advisory", value: "advisory" },
      { label: "guardrails", value: "guardrails" }
    ],
    { input: input as never, output: output as never },
    ["core"]
  );
  await new Promise((resolve) => setImmediate(resolve));
  const initialRender = output.text.replace(/\u001b\[[0-9;]*m/gu, "");
  assert.match(
    initialRender,
    /Profiles\n│  ❯ ● core\n│    ○ advisory\n│    ○ guardrails/u
  );
  input.pressKey("down");
  const movedRender = output.text.replace(/\u001b\[[0-9;]*m/gu, "");
  assert.match(movedRender, /│  ❯ ○ advisory/u);
  input.pressKey("space");
  input.pressKey("return");
  assert.deepEqual(await resultPromise, ["core", "advisory"]);
  assert.equal(input.rawMode, false);
});

test("selectOptions explains choices and supports selecting all", async () => {
  const input = new FakeRawInput();
  const output = new FakeOutput();
  const resultPromise = selectOptions(
    "Profiles (multi-select: ↑↓ move, Space toggle, Enter confirm)",
    [
      {
        label: "core",
        value: "core",
        description: "Base rules, tasks, verification, and reviews."
      },
      {
        label: "advisory",
        value: "advisory",
        description: "Informational lifecycle summaries and local logs."
      },
      {
        label: "guardrails",
        value: "guardrails",
        description: "Blocks high-confidence unsafe commands and can verify on Stop."
      }
    ],
    { input: input as never, output: output as never },
    [],
    {
      selectAll: true,
      selectAllDescription: "Enable core, advisory, and guardrails together."
    }
  );
  await new Promise((resolve) => setImmediate(resolve));
  const initialRender = output.text.replace(/\u001b\[[0-9;]*m/gu, "");
  assert.match(
    initialRender,
    /Profiles \(multi-select: ↑↓ move, Space toggle, Enter confirm\)\n│  ❯ ○ Select all\n│    Enable core, advisory, and guardrails together\.\n│    ○ core\n│    Base rules, tasks, verification, and reviews\./u
  );
  input.pressKey("return");
  const emptySelectionRender = output.text.replace(/\u001b\[[0-9;]*m/gu, "");
  assert.match(emptySelectionRender, /Choose at least one option with Space\./u);
  input.pressKey("down");
  const movedRender = output.text.replace(/\u001b\[[0-9;]*m/gu, "");
  assert.match(movedRender, /│  ❯ ○ core/u);
  input.pressKey("up");
  input.pressKey("space");
  input.pressKey("return");
  assert.deepEqual(await resultPromise, ["core", "advisory", "guardrails"]);
  assert.equal(input.rawMode, false);
});

test("selectYesNo exits on Ctrl-C without resolving", async () => {
  const input = new FakeRawInput();
  const output = new FakeOutput();
  const originalExit = process.exit;
  let exitCode: number | undefined;
  process.exit = ((code?: number) => {
    exitCode = code;
    throw new Error("process.exit called");
  }) as never;
  try {
    const resultPromise = selectYesNo(
      "Proceed?",
      { input: input as never, output: output as never },
      false
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.throws(() => input.pressKey("c", { ctrl: true }));
    assert.equal(exitCode, 130);
    resultPromise.catch(() => undefined);
  } finally {
    process.exit = originalExit;
  }
});
