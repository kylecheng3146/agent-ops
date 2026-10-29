import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { runRunCommand } from "../../packages/cli/src/commands/run.js";
import { runControlledStep } from "../../packages/cli/src/run-entry.js";
import { sha256 } from "../../runtime/src/fs/hash.js";
import { AgentOpsError } from "../../runtime/src/fs/paths.js";
import { beginFinalProof, discardReviewCheckpoints, finalProofAttemptKey, InterruptedStepError, processGroupAlive,
  runFinalProof, runReviewCheckpoints, settleFinalProofFailure } from "../../runtime/src/run/proof-recovery.js";
import { createRunState, FileRunRepository, RunService, type RunState } from "../../runtime/src/run/service.js";

const KEY = finalProofAttemptKey({ candidate: "c".repeat(40), target: "t".repeat(40), contractHash: "h".repeat(64), configHash: null, runtimeHash: null });

async function fixture(check: (f: { root: string; repository: FileRunRepository; state: RunState }) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agent-ops-proof-recovery-")));
  try {
    const repository = new FileRunRepository(join(root, "agent-ops/runs"), root);
    const state = createRunState({ root, commonDir: root, targetBranch: "main", goal: "Recover final proof", host: "codex", ownerSessionId: "owner" });
    await repository.create(state);
    await check({ root, repository, state });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("one automatic recovery per immutable attempt survives restart, repetition and concurrent settles", async () => {
  await fixture(async ({ repository, state }) => {
    const runId = state.runId;
    assert.equal((await repository.read(runId))!.finalProof, undefined, "older runs carry no recovery record and stay readable");
    await beginFinalProof(repository, runId, KEY);
    const decisions = await Promise.all([1, 2, 3].map(() => settleFinalProofFailure(repository, runId, KEY, "RUN_FINAL_PROOF_INTERRUPTED", true)));
    assert.deepEqual(decisions.filter(d => d === "replay").length, 1, "the run lock admits exactly one replay");
    let record = (await repository.read(runId))!.finalProof!;
    assert.equal(record.recoveries, 1);
    assert.equal(record.stopped, true);
    assert.equal(record.failures[0]!.code, "RUN_FINAL_PROOF_INTERRUPTED");

    // A restarted supervisor or a repeated finalize of the same candidate gets no new allowance.
    await beginFinalProof(repository, runId, KEY);
    assert.equal(await settleFinalProofFailure(repository, runId, KEY, "RUN_SUPERVISOR_RESTARTED", true), "stop");
    record = (await repository.read(runId))!.finalProof!;
    assert.deepEqual([record.recoveries, record.pending, record.stopped], [1, false, true]);
    assert.deepEqual(record.failures.map(f => f.code), ["RUN_FINAL_PROOF_INTERRUPTED", "RUN_SUPERVISOR_RESTARTED"],
      "the first failure is kept and the latest replaces only the last slot");

    const status = await runRunCommand({ args: { runAction: "status", runId } as never, service: new RunService(repository),
      root: state.root, commonDir: state.commonDir, targetBranch: "main", ownerSessionId: "owner" });
    assert.match((status.data as { text: string }).text,
      /Final proof recovery: 1\/1 used; first failure RUN_FINAL_PROOF_INTERRUPTED; last failure RUN_SUPERVISOR_RESTARTED; automatic recovery stopped/);

    const next = KEY.replace(/^./u, "0");
    await beginFinalProof(repository, runId, next);
    assert.deepEqual((await repository.read(runId))!.finalProof, { attemptKey: next, recoveries: 0, pending: true,
      reviewTransient: false, failures: [], stopped: false }, "a changed candidate starts a fresh allowance");
  });
});

test("ineligible failures, stopped runs and other attempts never consume the allowance", async () => {
  await fixture(async ({ repository, state }) => {
    const runId = state.runId;
    await beginFinalProof(repository, runId, KEY);
    assert.equal(await settleFinalProofFailure(repository, runId, KEY.replace(/^./u, "0"), "REVIEW_NOT_RUN", true), "stop");
    assert.equal((await repository.read(runId))!.finalProof!.failures.length, 0, "another attempt's settle changes nothing");
    await repository.mutate(runId, s => ({ ...s, status: "stopping", disableRestart: true }));
    assert.equal(await settleFinalProofFailure(repository, runId, KEY, "RUN_FINAL_PROOF_INTERRUPTED", true), "stop", "stop wins");
    assert.equal((await repository.read(runId))!.finalProof!.recoveries, 0);
    await repository.mutate(runId, s => ({ ...s, status: "active", disableRestart: false }));
    await beginFinalProof(repository, runId, KEY);
    assert.equal(await settleFinalProofFailure(repository, runId, KEY, "REVIEW_FAILED", false), "stop");
    assert.equal(await settleFinalProofFailure(repository, runId, KEY, "RUN_FINAL_PROOF_INTERRUPTED", true), "stop",
      "once automatic recovery stopped for this attempt it stays stopped");
    await assert.rejects(repository.mutate(runId, s => ({ ...s, finalProof: { ...s.finalProof!, recoveries: 2 as never } })),
      /final proof recovery record/u);
  });
});

type Outcome = () => Promise<{ status: string; code: string }>;
const interrupted = (replayable: boolean): Outcome => async () => { throw new InterruptedStepError("cut", replayable); };
const passed: Outcome = async () => ({ status: "ok", code: "TASK_ADVANCED" });
const keyOf = (n: number) => finalProofAttemptKey({ candidate: String(n), target: "t", contractHash: null, configHash: null, runtimeHash: null });

test("final proof spends its one recovery only on a replayable failure of an untouched attempt", async () => {
  await fixture(async ({ repository, state }) => {
    const runId = state.runId;
    const proof = async (key: string, outcomes: Outcome[], options: { untouched?: boolean; keys?: readonly string[]; restarted?: boolean } = {}) => {
      let calls = 0;
      const keys = options.keys ?? [key];
      let asked = 0;
      const result = await runFinalProof(repository, runId, { advance: async () => await outcomes[calls++]!(),
        attemptKey: async () => keys[Math.min(asked++, keys.length - 1)]!, untouched: async () => options.untouched ?? true },
        options.restarted === true ? key : undefined).then(value => value, (cause: unknown) => cause);
      return { result, calls, record: (await repository.read(runId))!.finalProof! };
    };

    let run = await proof(keyOf(1), [interrupted(true), passed]);
    assert.deepEqual([(run.result as { status: string }).status, run.calls, run.record.recoveries], ["ok", 2, 1]);
    assert.ok((await repository.read(runId))!.events.some(e => e.code === "RUN_FINAL_PROOF_RECOVERING"));

    run = await proof(keyOf(2), [interrupted(true), interrupted(true), passed]);
    assert.ok(run.result instanceof InterruptedStepError, "the second interruption is returned, not retried");
    assert.deepEqual([run.calls, run.record.recoveries, run.record.stopped, run.record.failures.length], [2, 1, true, 2]);

    run = await proof(keyOf(3), [async () => {
      await repository.mutate(runId, s => ({ ...s, finalProof: { ...s.finalProof!, reviewTransient: true } }));
      return { status: "error", code: "REVIEW_NOT_RUN" };
    }, passed]);
    assert.deepEqual([(run.result as { status: string }).status, run.calls], ["ok", 2], "a transient review ending is replayed once");

    for (const [n, outcomes, options, reason] of [
      [4, [interrupted(false), passed], {}, "a stop, deadline or live group is never replayed"],
      [5, [async () => ({ status: "error", code: "REVIEW_FAILED" }), passed], {}, "a substantive FAIL is returned as-is"],
      [6, [interrupted(true), passed], { untouched: false }, "a dirty checkout or an integration keeps its state"],
      [7, [interrupted(true), passed], { keys: [keyOf(7), keyOf(70)] }, "a moved candidate, target, contract or policy is a new attempt"]
    ] as const) {
      run = await proof(keyOf(n), [...outcomes], options);
      assert.equal(run.calls, 1, reason);
      assert.deepEqual([run.record.recoveries, run.record.stopped, run.record.pending], [0, true, false], reason);
    }
    assert.ok(run.result instanceof AgentOpsError);

    await beginFinalProof(repository, runId, keyOf(8));
    run = await proof(keyOf(8), [passed], { restarted: true });
    assert.deepEqual([(run.result as { status: string }).status, run.calls, run.record.failures[0]!.code],
      ["ok", 1, "RUN_SUPERVISOR_RESTARTED"], "a proof left pending by a crash is replayed once at startup");
    await beginFinalProof(repository, runId, keyOf(8));
    run = await proof(keyOf(8), [passed], { restarted: true });
    assert.ok(run.result instanceof AgentOpsError && run.result.code === "RUN_FINAL_PROOF_INTERRUPTED");
    assert.equal(run.calls, 0, "a restart never refunds a spent recovery");
  });
});

test("checkpoints are private to the run and discarded after delivery", async () => {
  await fixture(async ({ repository, state }) => {
    const journal = runReviewCheckpoints(repository, state);
    const binding = "b".repeat(64);
    const checkpoint = { binding, primary: { target: "codex" as const, sessionId: "s1", metrics: { promptBytes: 1, durationMs: 1 },
      report: { summary: "ok", results: [], findings: [], residualRisks: [], changedFilesInspected: [], supportingFilesInspected: [] } } };
    await assert.rejects(journal.load("../escape"), /sha256/u);
    assert.equal(await journal.load(binding), null);
    await journal.transient();
    assert.equal((await repository.read(state.runId))!.finalProof, undefined, "no record, nothing to mark");
    await assert.rejects(journal.save(checkpoint), { code: "RUN_REVIEW_CHECKPOINT_UNBOUND" }, "only a final proof records checkpoints");
    assert.equal(await journal.load(binding), null, "the file written without a record is never trusted");

    await beginFinalProof(repository, state.runId, KEY);
    await journal.save(checkpoint);
    assert.equal((await journal.load(binding))!.primary.sessionId, "s1");
    await beginFinalProof(repository, state.runId, KEY);
    assert.equal((await journal.load(binding))!.primary.sessionId, "s1", "the same attempt keeps its records");
    await assert.rejects(repository.mutate(state.runId, s => ({ ...s, finalProof: { ...s.finalProof!, checkpoints: { "not-a-digest": "x" } } })),
      /Invalid final proof recovery record/u);
    await assert.rejects(repository.mutate(state.runId, s => ({ ...s, finalProof: { ...s.finalProof!,
      checkpoints: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [sha256(String(i)), sha256(String(i))])) } })),
      /Invalid final proof recovery record/u);
    await beginFinalProof(repository, state.runId, keyOf(99));
    assert.equal(await journal.load(binding), null, "a new attempt starts without records");
    await discardReviewCheckpoints(state);
    assert.equal(await journal.load(binding), null);
  });
});

test("a live process group counts as a running proof; an ended one does not", { skip: process.platform === "win32" }, async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  const closed = new Promise(resolve => child.once("close", resolve));
  try {
    assert.equal(processGroupAlive(child.pid!), true);
  } finally { process.kill(-child.pid!, "SIGKILL"); }
  await closed;
  assert.equal(processGroupAlive(child.pid!), false);
});

const cli = fileURLToPath(new URL("../../packages/cli/src/bin.js", import.meta.url));

/** The controlled CLI sleeps first, so the test can end it while it is registered. */
async function controlled(f: { root: string; repository: FileRunRepository; state: RunState }, saved: RunState,
  interrupt: (pid: number) => Promise<void>): Promise<InterruptedStepError | null> {
  const sleep = join(f.root, "sleep.mjs");
  await writeFile(sleep, "await new Promise(resolve => setTimeout(resolve, 20000));\n");
  const previous = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `--import ${pathToFileURL(sleep).href}`;
  try {
    const step = runControlledStep(f.repository, cli, f.root, ["--version"], saved).then(() => null, (cause: unknown) => {
      assert.ok(cause instanceof InterruptedStepError, String(cause));
      return cause;
    });
    let pid: number | undefined;
    for (let attempt = 0; attempt < 200 && pid === undefined; attempt++) {
      pid = (await f.repository.read(f.state.runId))!.proofProcess?.processId;
      if (pid === undefined) await delay(25);
    }
    assert.ok(pid, "the proof group registers before it starts");
    await interrupt(pid!);
    return await step;
  } finally {
    if (previous === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previous;
  }
}

test("an externally killed proof group is replayable; a stop or deadline end is not", { skip: process.platform === "win32" }, async () => {
  await fixture(async f => {
    const killed = await controlled(f, f.state, async pid => { process.kill(-pid, "SIGKILL"); });
    assert.ok(killed instanceof InterruptedStepError, String(killed));
    assert.equal(killed.code, "RUN_FINAL_PROOF_INTERRUPTED");
    assert.equal(killed.replayable, true, killed.message);

    const stopped = await controlled(f, f.state, async () => {
      await f.repository.mutate(f.state.runId, s => ({ ...s, status: "stopping", disableRestart: true }));
    });
    assert.ok(stopped instanceof InterruptedStepError);
    assert.equal(stopped.replayable, false, "a stop is never replayed");
    await f.repository.mutate(f.state.runId, s => ({ ...s, status: "active", disableRestart: false }));

    const limited = { ...f.state, budget: { ...f.state.budget, limitMs: 400, activeIntervals: [] } };
    const late = await controlled(f, limited, async () => {});
    assert.ok(late instanceof InterruptedStepError);
    assert.equal(late.replayable, false, "the run deadline is never refreshed by a replay");
  });
});
