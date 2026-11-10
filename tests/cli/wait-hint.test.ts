import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { durationsPath, hintWriter, withWaitHint } from "../../packages/cli/src/wait-hint.js";

test("the wait hint has no number until a run is recorded, then names the last minutes", async () => {
  const commonDir = await mkdtemp(join(tmpdir(), "agent-ops-wait-"));
  try {
    const lines: string[] = [];
    let clock = 0;
    const first = await withWaitHint(commonDir, "verify", async () => { clock += 22 * 60_000; return "first"; },
      line => lines.push(line), () => clock);
    assert.equal(first, "first");
    assert.match(lines[0]!, /^agent-ops: verify runs until it exits\. Wait for the process to exit in one step; do not poll/u);
    assert.doesNotMatch(lines[0]!, /Last/u);
    assert.deepEqual(JSON.parse(await readFile(durationsPath(commonDir), "utf8")), {verify: 22 * 60_000});

    await withWaitHint(commonDir, "review", async () => { clock += 90_000; }, line => lines.push(line), () => clock);
    assert.doesNotMatch(lines[1]!, /Last/u);
    await withWaitHint(commonDir, "verify", async () => undefined, line => lines.push(line), () => clock);
    assert.match(lines[2]!, /Last verify here took about 22 min\./u);
    // Each command keeps its own entry.
    assert.deepEqual(Object.keys(JSON.parse(await readFile(durationsPath(commonDir), "utf8"))).sort(), ["review", "verify"]);
  } finally {
    await rm(commonDir, { recursive: true, force: true });
  }
});

test("JSON mode prints no hint but still records the duration", async () => {
  const commonDir = await mkdtemp(join(tmpdir(), "agent-ops-wait-"));
  const original = process.stderr.write.bind(process.stderr);
  const written: string[] = [];
  try {
    assert.equal(hintWriter(false), undefined);
    assert.equal(hintWriter(undefined), undefined);
    let clock = 0;
    process.stderr.write = ((chunk: string | Uint8Array) => { written.push(String(chunk)); return true; }) as typeof process.stderr.write;
    const result = await withWaitHint(commonDir, "verify", async () => { clock += 60_000; return "json"; }, hintWriter(true), () => clock);
    process.stderr.write = original;
    assert.equal(result, "json");
    assert.deepEqual(written, []);
    assert.deepEqual(JSON.parse(await readFile(durationsPath(commonDir), "utf8")), {verify: 60_000});
  } finally {
    process.stderr.write = original;
    await rm(commonDir, { recursive: true, force: true });
  }
});

test("hint failures never change the command result", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-wait-"));
  try {
    // A common dir that is a file: reading and writing durations both fail.
    const blocked = join(root, "not-a-directory");
    await writeFile(blocked, "x");
    assert.equal(await withWaitHint(blocked, "batch", async () => 7, () => { throw new Error("closed stderr"); }), 7);
    // A corrupt record reads as no record.
    const commonDir = join(root, "common");
    await mkdir(join(commonDir, "agent-ops"), { recursive: true });
    await writeFile(durationsPath(commonDir), "{not json");
    const lines: string[] = [];
    assert.equal(await withWaitHint(commonDir, "verify", async () => "ok", line => lines.push(line)), "ok");
    assert.doesNotMatch(lines[0]!, /Last/u);
    // No common dir at all still prints the guidance.
    const none: string[] = [];
    await withWaitHint(undefined, "review", async () => undefined, line => none.push(line));
    assert.equal(none.length, 1);
    // A failing command is not recorded and its error is not swallowed.
    await assert.rejects(withWaitHint(commonDir, "review", async () => { throw new Error("boom"); }, () => undefined), /boom/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
