import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  readRecordedSessionId,
  runProjectLoop
} from "../../runtime/src/hooks/codex-loop.js";
import { FileTaskStore } from "../../runtime/src/task/store.js";
import { TaskService } from "../../runtime/src/task/service.js";

const SESSION = "11111111-2222-3333-4444-555555555555";
const OTHER_SESSION = "99999999-8888-7777-6666-555555555555";

async function loopRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-loop-restore-"));
  await mkdir(join(root, ".claude"), { recursive: true });
  await writeFile(
    join(root, ".claude", "loop-goal.md"),
    "# Current goal\n\nRestore what the last session proved.\n"
  );
  await writeFile(join(root, ".claude", "loop-telemetry.jsonl"), "");
  return root;
}

function store(root: string): FileTaskStore {
  return new FileTaskStore(
    join(root, ".agent-ops", "tasks", "state.json"),
    root
  );
}

function service(root: string): TaskService {
  return new TaskService(store(root));
}

/** One active task with a satisfied and an unsatisfied criterion. */
async function seedTask(root: string, sessionId?: string): Promise<string> {
  const created = await service(root).create({
    title: "Restore the loop",
    criteria: [
      { id: "proven", description: "This one already has evidence.", verifierIds: ["node-test"] },
      { id: "unproven", description: "This one still needs proof.", verifierIds: ["node-test"] }
    ],
    ...(sessionId === undefined ? {} : { sessionId })
  });
  // recordEvidence demands a non-empty reference for every criterion, which
  // is exactly the half-proven state a recovery has to describe, so the store
  // is seeded directly.
  await store(root).mutate((state) => {
    const record = state.tasks.find((item) => item.task.id === created.task.id);
    if (record !== undefined) {
      state.tasks[state.tasks.indexOf(record)] = {
        ...record,
        evidence: { proven: ["evidence/one.json"] }
      };
    }
  });
  return created.task.id;
}

async function sessionStart(
  root: string,
  input: Record<string, unknown>
): Promise<string> {
  const result = await runProjectLoop({
    harness: "claude",
    event: "SessionStart",
    input: { cwd: root, ...input },
    root
  });
  const parsed = JSON.parse(result.stdout) as {
    hookSpecificOutput: { additionalContext: string };
  };
  return parsed.hookSpecificOutput.additionalContext;
}

test("a compaction restores the attached task and names what is unproven", async () => {
  const root = await loopRoot();
  const taskId = await seedTask(root, SESSION);

  const context = await sessionStart(root, {
    session_id: SESSION,
    source: "compact"
  });

  assert.match(context, new RegExp(taskId));
  assert.match(context, /Criteria satisfied: 1\/2\./);
  assert.match(context, /unproven: This one still needs proof\./);
  assert.doesNotMatch(context, /proven: This one already has evidence\./);
  // Evidence is pointed at, never quoted: one real task's evidence runs past
  // the whole context budget.
  assert.doesNotMatch(context, /evidence\/one\.json/);
  assert.match(context, /1 reference\(s\) under \.agent-ops\/tasks\/evidence\//);
  assert.match(context, /Current goal:/);
});

test("a checkpoint states a zero evidence count rather than omitting it", async () => {
  const root = await loopRoot();
  const created = await service(root).create({
    title: "Nothing proven yet",
    criteria: [
      { id: "one", description: "First.", verifierIds: ["node-test"] },
      { id: "two", description: "Second.", verifierIds: ["node-test"] }
    ],
    sessionId: SESSION
  });

  const context = await sessionStart(root, {
    session_id: SESSION,
    source: "compact"
  });

  assert.match(context, /Criteria satisfied: 0\/2\./);
  assert.match(
    context,
    new RegExp(`0 reference\\(s\\) under \\.agent-ops/tasks/evidence/${created.task.id}/`)
  );
});

test("a long title cannot evict the unproven criteria", async () => {
  const root = await loopRoot();
  await service(root).create({
    title: "T".repeat(4_000),
    criteria: [
      { id: "survives", description: "This must still be listed.", verifierIds: ["node-test"] },
      { id: "also", description: "So must this.", verifierIds: ["node-test"] }
    ],
    sessionId: SESSION
  });

  const context = await sessionStart(root, {
    session_id: SESSION,
    source: "compact"
  });

  assert.match(context, /survives: This must still be listed\./);
  assert.match(context, /also: So must this\./);
  assert.ok(context.length <= 1_200, `context was ${context.length} characters`);
});

test("a secret-shaped task title is dropped, not injected", async () => {
  const root = await loopRoot();
  await service(root).create({
    title: `Rotate ghp_${"A".repeat(36)} everywhere`,
    criteria: [
      { id: "one", description: "First.", verifierIds: ["node-test"] },
      { id: "two", description: "Second.", verifierIds: ["node-test"] }
    ],
    sessionId: SESSION
  });

  const context = await sessionStart(root, {
    session_id: SESSION,
    source: "compact"
  });

  assert.doesNotMatch(context, /ghp_A/);
});

test("a resume injects no checkpoint, because the transcript still has it", async () => {
  const root = await loopRoot();
  const taskId = await seedTask(root, SESSION);

  const context = await sessionStart(root, {
    session_id: SESSION,
    source: "resume"
  });

  assert.doesNotMatch(context, new RegExp(taskId));
  assert.match(context, /Current goal:/);
});

test("a fresh session is offered the last task, never given its state", async () => {
  const root = await loopRoot();
  const taskId = await seedTask(root, SESSION);
  // The first start records the marker this checkout will point back to.
  await sessionStart(root, { session_id: SESSION, source: "compact" });

  const context = await sessionStart(root, {
    session_id: OTHER_SESSION,
    source: "startup"
  });

  assert.match(context, new RegExp(`Last active task here: ${taskId}`));
  assert.doesNotMatch(context, /Still unproven/);
  assert.doesNotMatch(context, /Criteria satisfied/);
});

test("a cleared session keeps its attachment but is still only offered it", async () => {
  const root = await loopRoot();
  const taskId = await seedTask(root, SESSION);

  // `/clear` keeps the session id, so the attachment survives while the
  // context does not. State is offered, never injected.
  const context = await sessionStart(root, {
    session_id: SESSION,
    source: "clear"
  });

  assert.match(context, new RegExp(`Attached task here: ${taskId}`));
  assert.doesNotMatch(context, /Still unproven/);
  assert.doesNotMatch(context, /Criteria satisfied/);
});

test("a compaction with no attachment injects nothing, not even a pointer", async () => {
  const root = await loopRoot();
  const taskId = await seedTask(root, SESSION);
  await sessionStart(root, { session_id: SESSION, source: "compact" });

  const context = await sessionStart(root, {
    session_id: OTHER_SESSION,
    source: "compact"
  });

  assert.doesNotMatch(context, new RegExp(taskId));
  assert.match(context, /Current goal:/);
});

test("an unknown session with no recorded task restores nothing", async () => {
  const root = await loopRoot();
  await seedTask(root);

  const context = await sessionStart(root, {
    session_id: OTHER_SESSION,
    source: "compact"
  });

  assert.doesNotMatch(context, /Last active task/);
  assert.doesNotMatch(context, /Still unproven/);
  assert.match(context, /Current goal:/);
});

test("PostCompact stays silent so the same payload is not paid twice", async () => {
  const root = await loopRoot();
  await seedTask(root, SESSION);

  const result = await runProjectLoop({
    harness: "claude",
    event: "PostCompact",
    input: { cwd: root, session_id: SESSION, trigger: "manual" },
    root
  });

  assert.equal(result.stdout, "");
});

test("SessionStart records the session id and the CLI can read it back", async () => {
  const root = await loopRoot();
  const taskId = await seedTask(root, SESSION);

  await sessionStart(root, { session_id: SESSION, source: "compact" });

  const state = await readFile(join(root, ".claude", "loop-state.md"), "utf8");
  assert.match(state, new RegExp(`Session: ${SESSION}`));
  assert.match(state, new RegExp(`Task: ${taskId}`));
  assert.equal(await readRecordedSessionId(root), SESSION);
});

test("every SessionStart logs which restore outcome it produced", async () => {
  const root = await loopRoot();
  await seedTask(root, SESSION);

  await sessionStart(root, { session_id: SESSION, source: "compact" });
  await sessionStart(root, { session_id: OTHER_SESSION, source: "startup" });

  const telemetry = await readFile(
    join(root, ".claude", "loop-telemetry.jsonl"),
    "utf8"
  );
  const events = telemetry
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { event: string; code: string });
  // One event per start, and it names the outcome: no generic duplicate.
  assert.deepEqual(
    events.filter((item) => item.event === "session-start").map((item) => item.code),
    ["restore-hit", "restore-pointer"]
  );
});

test("a long goal cannot crowd the task state out of the budget", async () => {
  const root = await loopRoot();
  const taskId = await seedTask(root, SESSION);
  await writeFile(
    join(root, ".claude", "loop-goal.md"),
    `# Current goal\n\n${"goal text ".repeat(400)}\n`
  );

  const context = await sessionStart(root, {
    session_id: SESSION,
    source: "compact"
  });

  assert.ok(context.length <= 1_200, `context was ${context.length} characters`);
  assert.match(context, new RegExp(taskId));
  assert.match(context, /Still unproven/);
});

test("five long criteria keep their ids and the evidence pointer", async () => {
  const root = await loopRoot();
  const created = await service(root).create({
    title: "T".repeat(120),
    criteria: Array.from({ length: 5 }, (_unused, index) => ({
      id: `criterion-${index + 1}`,
      description: "D".repeat(160),
      verifierIds: ["node-test"]
    })),
    sessionId: SESSION
  });

  const context = await sessionStart(root, {
    session_id: SESSION,
    source: "compact"
  });

  for (let index = 1; index <= 5; index += 1) {
    assert.match(context, new RegExp(`criterion-${index}:`));
  }
  assert.match(
    context,
    new RegExp(`0 reference\\(s\\) under \\.agent-ops/tasks/evidence/${created.task.id}/`)
  );
  assert.ok(context.length <= 1_200, `context was ${context.length} characters`);
});

test("maximum-length criterion ids keep the evidence pointer inside the budget", async () => {
  const root = await loopRoot();
  const ids = Array.from({ length: 5 }, (_unused, index) =>
    `${"c".repeat(126)}-${index + 1}`
  );
  const created = await service(root).create({
    title: "T".repeat(120),
    criteria: ids.map((id) => ({
      id,
      description: "D".repeat(160),
      verifierIds: ["node-test"]
    })),
    sessionId: SESSION
  });

  const context = await sessionStart(root, {
    session_id: SESSION,
    source: "compact"
  });

  for (const id of ids) {
    assert.ok(context.includes(id), `criterion ${id.slice(-8)} was dropped`);
  }
  assert.match(
    context,
    new RegExp(`0 reference\\(s\\) under \\.agent-ops/tasks/evidence/${created.task.id}/`)
  );
  assert.ok(context.length <= 1_200, `context was ${context.length} characters`);
});

test("a token straddling the truncation boundary is dropped, not shortened", async () => {
  const root = await loopRoot();
  // The token sits past the title ceiling: shortening first would leave a
  // prefix too short for the detector to recognise.
  await service(root).create({
    title: `${"T".repeat(108)} ghp_${"A".repeat(36)}`,
    criteria: [
      { id: "one", description: "First.", verifierIds: ["node-test"] },
      { id: "two", description: "Second.", verifierIds: ["node-test"] }
    ],
    sessionId: SESSION
  });

  const context = await sessionStart(root, {
    session_id: SESSION,
    source: "compact"
  });

  assert.doesNotMatch(context, /ghp_/);
  assert.match(context, /one: First\./);
});

test("maximum-length ids still keep a description for every criterion", async () => {
  const root = await loopRoot();
  await service(root).create({
    title: "T".repeat(120),
    criteria: Array.from({ length: 5 }, (_unused, index) => ({
      id: `${"c".repeat(126)}-${index + 1}`,
      description: `DESCRIPTION-${index + 1} explains what is still unproven.`,
      verifierIds: ["node-test"]
    })),
    sessionId: SESSION
  });

  const context = await sessionStart(root, {
    session_id: SESSION,
    source: "compact"
  });

  for (let index = 1; index <= 5; index += 1) {
    assert.match(context, new RegExp(`DESCRIPTION-${index}`));
  }
  assert.ok(context.length <= 1_200, `context was ${context.length} characters`);
});

test("a credential-shaped criterion id is redacted, not injected", async () => {
  const root = await loopRoot();
  await service(root).create({
    title: "Rotate the signing key",
    criteria: [
      { id: `sk-${"abcdefgh".repeat(3)}`, description: "First.", verifierIds: ["node-test"] },
      { id: "plain-id", description: "Second.", verifierIds: ["node-test"] }
    ],
    sessionId: SESSION
  });

  const context = await sessionStart(root, {
    session_id: SESSION,
    source: "compact"
  });

  assert.doesNotMatch(context, /sk-abcdefgh/);
  assert.match(context, /plain-id:/);
});
