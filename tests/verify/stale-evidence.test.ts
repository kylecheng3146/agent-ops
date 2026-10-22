import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { aggregateAcceptanceRun, type AcceptanceRun } from "../../runtime/src/verify/acceptance-protocol.js";
import { calculateSourceFingerprint } from "../../runtime/src/verify/source-fingerprint.js";
import { resolveReviewScope } from "../../runtime/src/review/scope.js";
import { writeWorktreeRecord } from "../../runtime/src/parallel/service.js";
import { defaultBase } from "../../packages/cli/src/default-base.js";
import { runVerifyCommand } from "../../packages/cli/src/commands/verify.js";
import { parseArgs } from "../../packages/cli/src/args.js";
import type { VerificationReport } from "../../runtime/src/verify/service.js";

async function repo() {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-stale-"));
  const git = (...args: string[]) => execFileSync("git", args, {cwd: root, stdio: ["ignore", "pipe", "pipe"]}).toString().trim();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  const commit = async (files: Record<string, string>, message: string) => {
    for (const [path, content] of Object.entries(files)) {
      await mkdir(join(root, path, ".."), {recursive: true});
      await writeFile(join(root, path), content);
    }
    git("add", "-A");
    git("commit", "-qm", message);
    return git("rev-parse", "HEAD");
  };
  const runner = {run: async (args: readonly string[]) => {
    try { return {exitCode: 0, stdout: execFileSync("git", args, {cwd: root, stdio: ["ignore", "pipe", "pipe"]})}; }
    catch { return {exitCode: 1, stdout: Buffer.alloc(0)}; }
  }};
  return {root, git, commit, runner, close: async () => await rm(root, {recursive: true, force: true})};
}

const check = (checkId: string, status: "PASS" | "FAIL") => ({executionId: "e", framework: "f", frameworkVersion: "1", checkId, phase: "candidate" as const,
  status, failureClass: status === "PASS" ? "none" : "assertion-failed", attempts: 1, evidence: ["ran"]});
const run = (results: ReturnType<typeof check>[]): AcceptanceRun => ({protocolVersion: 1, executionId: "e", framework: "f", frameworkVersion: "1",
  phase: "candidate", results, completed: true, completionEvidence: ["done"], diagnostics: []});

test("checks beyond the bound ones are ignored; missing bound checks stay UNKNOWN", () => {
  assert.equal(aggregateAcceptanceRun(run([check("issue", "PASS"), check("other", "PASS")]), ["issue"]).status, "PASS");
  assert.equal(aggregateAcceptanceRun(run([check("issue", "FAIL"), check("other", "PASS")]), ["issue"]).status, "FAIL");
  const missing = aggregateAcceptanceRun(run([check("other", "PASS")]), ["issue"]);
  assert.equal(missing.status, "UNKNOWN");
  assert.equal(missing.failureClass, "missing-check");
});

test("a commit touching only the escape ledger keeps the base-mode fingerprint", async () => {
  const r = await repo();
  try {
    const base = await r.commit({"src/a.ts": "export const a = 1;\n"}, "base");
    await r.commit({"src/a.ts": "export const a = 2;\n"}, "fix");
    const fingerprint = async () => await calculateSourceFingerprint(r.root, await resolveReviewScope({root: r.root, runner: r.runner, base}), r.runner);
    const fixed = await fingerprint();
    await r.commit({".agent-ops-escapes/task-x.json": "{}\n"}, "ledger");
    assert.equal(await fingerprint(), fixed, "ledger-only commit");
    await r.commit({".agent-ops-escapes/rules/r.json": "{}\n"}, "rule");
    assert.notEqual(await fingerprint(), fixed, "escape rules steer the surface gate and stay fingerprinted");
    await r.commit({"src/b.ts": "export const b = 1;\n"}, "more");
    assert.notEqual(await fingerprint(), fixed, "any other path changes it");
  } finally {
    await r.close();
  }
});

test("the default base follows the worktree's target branch or the task's creation commit", async () => {
  const r = await repo();
  try {
    const created = await r.commit({"a.txt": "1\n"}, "created");
    const none = async () => undefined;
    assert.equal(await defaultBase(r.root, r.runner, async () => created), undefined, "nothing committed since creation");
    await r.commit({"a.txt": "2\n"}, "work");
    assert.equal(await defaultBase(r.root, r.runner, async () => created), created, "main checkout: creation commit");
    assert.equal(await defaultBase(r.root, r.runner, none), undefined, "no task, no worktree record");
    await writeFile(join(r.root, "a.txt"), "dirty\n");
    assert.equal(await defaultBase(r.root, r.runner, async () => created), undefined, "a dirty tree keeps worktree mode");
    r.git("checkout", "-q", "--", "a.txt");
    // A session worktree: compare against the merge-base with its target branch, which a finish rebase moves.
    r.git("checkout", "-q", "-b", "agent-ops/session-x");
    await r.commit({"b.txt": "1\n"}, "session work");
    await writeWorktreeRecord({schemaVersion: 1, name: "session-x", branch: "agent-ops/session-x", path: r.root, mainRoot: r.root,
      targetBranch: "main", base: created, sessionId: "s", createdAt: new Date().toISOString()});
    assert.equal(await defaultBase(r.root, r.runner, none), r.git("rev-parse", "main"));
  } finally {
    await r.close();
  }
});

test("verify prints the surface gate as advice without changing its result", async () => {
  const report = {taskId: "task-1", status: "PASS", results: [], acceptance: [], signal: null,
    surface: {staged: [], unstaged: [], untracked: [], paths: []},
    selection: {verifierIds: [], fallback: true, reason: "unknown-path", evidence: {changedPaths: [], mappings: [], requiredVerifierIds: []}},
    reviewScope: {mode: "worktree", changedFiles: []}} as unknown as VerificationReport;
  const base = {args: parseArgs(["verify", "--task", "task-1"]), service: {verify: async () => report}, taskService: {status: async () => ({task: {id: "task-1"}})}};
  const advised = await runVerifyCommand({...base, surface: async () => ["Surface (advisory; review would stop with SURFACE_UNCLASSIFIED): x", "  - src/b.ts"]});
  assert.equal(advised.code, "VERIFICATION_PASSED");
  assert.match(advised.data?.text ?? "", /SURFACE_UNCLASSIFIED[\s\S]*src\/b\.ts/u);
  const broken = await runVerifyCommand({...base, surface: async () => { throw new Error("gate unavailable"); }});
  assert.equal(broken.code, "VERIFICATION_PASSED");
  assert.equal(broken.data?.surface, undefined);
});

test("verification evidence survives metadata revisions, baselines move only on request", async () => {
  const result = await promisify(execFile)(process.execPath, ["tests/verify/stale-evidence.acceptance.mjs"], {
    cwd: process.cwd(), env: {...process.env, AGENT_OPS_DEBUG_TEST_BUILD: resolve(".tmp/test-dist")}, timeout: 240000, maxBuffer: 1024 * 1024
  });
  assert.match(result.stdout, /stale evidence passed/u);
});
