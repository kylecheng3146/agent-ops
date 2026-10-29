import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ReviewTargetId } from "../../runtime/src/contracts.js";
import { reviewReportDigest } from "../../runtime/src/review/attestation.js";
import { createReviewExecutor, type ReviewCheckpointJournal } from "../../runtime/src/review/execute.js";
import { redactReviewReport, type ReviewExecutionRequest } from "../../runtime/src/review/runner.js";
import { runReviewCheckpoints } from "../../runtime/src/run/proof-recovery.js";
import { createRunState, FileRunRepository } from "../../runtime/src/run/service.js";
import type { ProcessRequest, VerificationProcessRunner } from "../../runtime/src/verify/spawn.js";

interface Step { readonly stdout?: string; readonly stderr?: string; readonly exitCode?: number; readonly before?: () => Promise<void> }

const HELP = ["--add-dir", "--permission-mode", "--no-session-persistence", "--safe-mode", "--disable-slash-commands",
  "--json-schema", "--sandbox", "--mode", "--cd", "--ephemeral", "--ignore-user-config", "--ignore-rules",
  "--output-schema", "--log-file"].join(" ");

const bytes = (value: string): AsyncIterable<Uint8Array> => ({
  async *[Symbol.asyncIterator]() { if (value.length > 0) yield Buffer.from(value); }
});

/** Reviewer calls only: help probes and the snapshot clone are answered silently. */
function scripted(script: readonly Step[]): { runner: VerificationProcessRunner; calls: string[] } {
  const calls: string[] = [];
  let index = 0;
  return { calls, runner: { start(request: ProcessRequest) {
    const help = request.args.includes("--help");
    const snapshot = request.command === "git";
    if (!help && !snapshot) calls.push(request.command);
    const step: Step = snapshot ? {} : help ? (request.command === "agy" ? { stderr: HELP } : { stdout: HELP }) : script[index++] ?? {};
    return { pid: 4242, stdout: bytes(step.stdout ?? ""), stderr: bytes(step.stderr ?? ""), terminateTree: async () => {},
      completion: Promise.resolve(step.before?.()).then(() => ({ exitCode: step.exitCode ?? 0, signal: null })) };
  } } };
}

function answer(status: "PASS" | "FAIL", target: ReviewTargetId): string {
  const report = { summary: "Review complete.", results: [{ criterionId: "tests", status, summary: "Checked.", evidence: ["npm test"] }],
    findings: status === "PASS" ? [] : [{ severity: "important", blocking: true, title: "Broken.", details: "It fails.", locations: [],
      evidence: ["npm test"], recommendation: "Fix it.", criterionIds: ["tests"] }],
    residualRisks: [], changedFilesInspected: [], supportingFilesInspected: [] };
  return JSON.stringify(target === "codex" ? report : { structured_output: report });
}

const dropped: Step = { exitCode: 1, stderr: "error: There was a network issue connecting to the server, please try again." };

const request: ReviewExecutionRequest = { readOnly: true, invocation: { harness: "codex", model: "configured", effort: "configured",
  packet: { request: "Review it.", criteria: [{ id: "tests", description: "The test suite passes." }], artifactRefs: [], evidenceRequirements: [] } } };

async function fixture(check: (f: { root: string; repository: FileRunRepository; runId: string; journal: ReviewCheckpointJournal;
  review: (script: readonly Step[], native?: boolean) => Promise<{ result: Awaited<ReturnType<ReturnType<typeof createReviewExecutor>>>; calls: string[] }>;
  saved: () => Promise<string[]> }) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agent-ops-checkpoint-")));
  try {
    const repository = new FileRunRepository(join(root, "agent-ops/runs"), root);
    const state = createRunState({ root, commonDir: root, targetBranch: "main", goal: "Recover final proof", host: "codex", ownerSessionId: "owner" });
    await repository.create(state);
    await repository.mutate(state.runId, s => ({ ...s, finalProof: { attemptKey: "a".repeat(64), recoveries: 0, pending: true,
      reviewTransient: false, failures: [], stopped: false } }));
    const journal = runReviewCheckpoints(repository, state);
    const directory = join(root, "agent-ops/runs", state.runId, "final-review");
    await check({ root, repository, runId: state.runId, journal,
      review: async (script, native = true) => {
        const { runner, calls } = scripted(script);
        const execute = createReviewExecutor({ targets: ["codex", "claude"], cwd: root, runner, env: {}, probeBind: async () => true,
          timeoutMs: 120_000, ...(native ? { checkpoints: journal } : {}) });
        return { result: await execute(request), calls };
      },
      saved: async () => (await readdir(directory).catch(() => [])).map(name => join(directory, name)) });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("an interrupted second round resumes from the saved primary PASS with no second primary call", async () => {
  await fixture(async ({ repository, runId, review, saved }) => {
    let savedBeforeSecondRound = false;
    const first = await review([{ stdout: answer("PASS", "codex") },
      { ...dropped, before: async () => { savedBeforeSecondRound = (await saved()).length === 1; } }]);
    assert.equal(savedBeforeSecondRound, true, "primary PASS must be durable before the adversarial round starts");
    assert.equal(first.result.status, "NOT_RUN");
    assert.deepEqual(first.calls, ["codex", "claude"], "no in-process retry inside native final proof");
    assert.equal((await repository.read(runId))!.finalProof!.reviewTransient, true);

    const second = await review([{ stdout: answer("PASS", "claude") }]);
    assert.equal(second.result.status, "PASS", JSON.stringify(second.result));
    assert.deepEqual(second.calls, ["claude"], "primary is never called again");
    const [primary, adversarial] = second.result.attempts!;
    assert.equal(primary!.sessionId, first.result.attempts![0]!.sessionId);
    assert.notEqual(adversarial!.sessionId, primary!.sessionId);
    assert.notEqual(adversarial!.sessionId, first.result.attempts![1]!.sessionId);
    const [path] = await saved();
    const checkpoint = JSON.parse(await readFile(path!, "utf8")).checkpoint;
    assert.equal(reviewReportDigest(redactReviewReport(second.result.report!)), reviewReportDigest(checkpoint.primary.report),
      "the attested primary digest is the checkpoint's");
    assert.equal(checkpoint.adversarial.sessionId, adversarial!.sessionId);

    const third = await review([]);
    assert.equal(third.result.status, "PASS");
    assert.deepEqual(third.calls, [], "a saved complete pair costs no model call");
    assert.deepEqual(third.result.attempts!.map(a => a.sessionId), second.result.attempts!.map(a => a.sessionId));
  });
});

test("a refuted pair is never resumed and a dropped primary is not retried in process", async () => {
  await fixture(async ({ repository, runId, review }) => {
    const refuted = await review([{ stdout: answer("PASS", "codex") }, { stdout: answer("FAIL", "claude") }]);
    assert.equal(refuted.result.status, "FAIL");
    const again = await review([{ stdout: answer("PASS", "codex") }, { stdout: answer("PASS", "claude") }]);
    assert.deepEqual(again.calls, ["codex", "claude"], "a refuted pair is reviewed from scratch, never re-asked to PASS");

    await repository.mutate(runId, s => ({ ...s, finalProof: { ...s.finalProof!, reviewTransient: false } }));
    const changed: ReviewExecutionRequest = { ...request, invocation: { ...request.invocation, packet: { ...request.invocation.packet, request: "Changed." } } };
    const { runner, calls } = scripted([dropped, { stdout: answer("PASS", "codex") }]);
    const root = (await repository.read(runId))!.root;
    const execute = createReviewExecutor({ targets: ["codex", "claude"], cwd: root, runner, env: {}, probeBind: async () => true,
      checkpoints: runReviewCheckpoints(repository, (await repository.read(runId))!) });
    const result = await execute(changed);
    assert.equal(result.status, "NOT_RUN");
    assert.deepEqual(calls, ["codex"]);
    assert.equal((await repository.read(runId))!.finalProof!.reviewTransient, true);
  });
});

test("a corrupt or mismatched checkpoint stops the review without calling any reviewer", async () => {
  await fixture(async ({ review, saved }) => {
    await review([{ stdout: answer("PASS", "codex") }, dropped]);
    const [path] = await saved();
    const source = await readFile(path!, "utf8");
    await writeFile(path!, source.replace("Review complete.", "Review altered."));
    const altered = await review([{ stdout: answer("PASS", "claude") }]);
    assert.equal(altered.result.status, "NOT_RUN");
    assert.equal(altered.result.status === "NOT_RUN" ? altered.result.reason : undefined, "checkpoint-invalid");
    assert.deepEqual(altered.calls, []);

    const saved_ = JSON.parse(source);
    saved_.checkpoint.primary.report.results[0].status = "FAIL";
    const { sha256 } = await import("../../runtime/src/fs/hash.js");
    saved_.digest = sha256(JSON.stringify(saved_.checkpoint));
    await writeFile(path!, JSON.stringify(saved_));
    const mismatched = await review([{ stdout: answer("PASS", "claude") }]);
    assert.equal(mismatched.result.status === "NOT_RUN" ? mismatched.result.reason : undefined, "checkpoint-invalid");
    assert.deepEqual(mismatched.calls, []);
  });
});

test("without a checkpoint journal the review keeps its in-process retry and writes nothing", async () => {
  await fixture(async ({ review, saved }) => {
    const { result, calls } = await review([dropped, { stdout: answer("PASS", "codex") }, { stdout: answer("PASS", "claude") }], false);
    assert.equal(result.status, "PASS");
    assert.deepEqual(calls, ["codex", "codex", "claude"]);
    assert.deepEqual(await saved(), []);
  });
});
