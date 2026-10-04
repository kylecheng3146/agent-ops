import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdtemp, mkdir, writeFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import type {AgentOpsConfig} from "../../runtime/src/contracts.js";
import {FileTaskStore} from "../../runtime/src/task/store.js";
import {TaskService} from "../../runtime/src/task/service.js";
import {FileEvidenceStore, calculateConfigHash} from "../../runtime/src/verify/evidence.js";
import {VerificationService} from "../../runtime/src/verify/service.js";
import {NodeVerificationProcessRunner} from "../../runtime/src/verify/spawn.js";
import {acceptanceCoverage} from "../../runtime/src/verify/acceptance-coverage.js";
import {taskContractHash} from "../../runtime/src/task/contract.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-replay-test-"));
  const git = (...args: string[]) => execFileSync("git", args, {cwd: root, stdio: ["ignore", "pipe", "pipe"]});
  git("init", "-q"); git("config", "user.name", "Acceptance fixture"); git("config", "user.email", "fixture@example.invalid");
  await writeFile(join(root, ".gitignore"), ".agent-ops/\n");
  await writeFile(join(root, "product.mjs"), "export const value = 0;\n");
  git("add", "."); git("commit", "-qm", "baseline");
  const baseline = git("rev-parse", "HEAD").toString().trim();
  const gitRunner = {run: async (args: readonly string[]) => {
    try {return {exitCode: 0, stdout: git(...args)};}
    catch {return {exitCode: 1, stdout: Buffer.alloc(0)};}
  }};
  const config: AgentOpsConfig = {schemaVersion: 3, profiles: ["core"], verification: {commands: [],
    acceptanceRunners: [{id: "acceptance", command: process.execPath, args: ["tests/check.mjs"], cwd: ".", adapter: "generic"}]},
    features: {completionGate: {enabled: false}, stopVerification: {enabled: false}}, pathMappings: [], securityExceptions: []};
  const store = new FileTaskStore(join(root, ".agent-ops/tasks/state.json"), root);
  const tasks = new TaskService(store, {completion: {root, gitRunner, base: baseline, loadConfig: async () => config}});
  const materials = [{path: "tests/check.mjs", role: "test" as const}];
  const record = await tasks.create({title: "Fix value", goal: "Value equals one and remains numeric", policyConfigHash: calculateConfigHash(config), criteria: [
    {id: "behavior", description: "Value equals one", verifierIds: [], acceptance: {mode: "behavioral", baselineCommit: baseline,
      bindings: [{runnerId: "acceptance", materials, checkIds: ["behavior"], redCheckIds: ["behavior"]}]}},
    {id: "invariant", description: "Value remains numeric", verifierIds: [], acceptance: {mode: "invariant", baselineCommit: baseline,
      bindings: [{runnerId: "acceptance", materials, checkIds: ["invariant"]}]}}
  ]});
  await mkdir(join(root, "tests"));
  await writeFile(join(root, "tests/check.mjs"), [
    "import assert from 'node:assert/strict'; import {value} from '../product.mjs';",
    "const executionId=process.env.AGENT_OPS_ACCEPTANCE_EXECUTION_ID, phase=process.env.AGENT_OPS_ACCEPTANCE_PHASE;",
    "const results=[['behavior',()=>assert.equal(value,1)],['invariant',()=>assert.equal(typeof value,'number')]].map(([checkId,check])=>{",
    "let status='PASS',failureClass='none'; try{check()}catch(e){status='FAIL';failureClass=e.code==='ERR_ASSERTION'?'assertion-failed':'infrastructure-error'}",
    "return {executionId,phase,framework:'fixture',frameworkVersion:'1',checkId,status,failureClass,attempts:1,evidence:['actual assertion']}});",
    "console.log(JSON.stringify({protocolVersion:1,executionId,phase,framework:'fixture',frameworkVersion:'1',results,completed:true,completionEvidence:['complete'],diagnostics:[]}));",
    "process.exitCode=results.some(r=>r.status==='FAIL')?1:0;"
  ].join("\n"));
  await writeFile(join(root, "product.mjs"), "export const value = 1;\n");
  git("add", "."); git("commit", "-qm", "candidate and independent test");
  const evidenceStore = new FileEvidenceStore(root, root);
  const verify = () => new VerificationService({root, scope: "project", config, gitRunner,
    processRunner: new NodeVerificationProcessRunner(), taskService: tasks, evidenceStore, trusted: true, base: baseline}).verify(record.task.id);
  return {root, baseline, config, tasks, record, verify, evidenceStore};
}

test("real paired replay shares execution and proves behavioral and invariant criteria", async () => {
  const f = await fixture();
  try {
    const report = await f.verify();
    assert.equal(report.status, "PASS", JSON.stringify(report.acceptance));
    assert.equal(report.acceptance?.length, 4);
    const record = await f.tasks.status({taskId: f.record.task.id});
    const coverage = await acceptanceCoverage(record, f.config, report.sourceFingerprint, f.evidenceStore);
    assert.deepEqual(coverage.map(c => c.status), ["proven", "proven"]);
    const baseline = await f.evidenceStore.load(report.acceptance![0]!.reference) as {acceptance: {checks: {status: string}[]}};
    assert.equal(baseline.acceptance.checks[0]?.status, "FAIL");
    const revised = await f.tasks.revise(record.task.id, {expectedContractHash: taskContractHash(record.task),
      criteria: record.task.criteria, reason: "Reassess the same contract against the original goal"});
    assert.deepEqual((await acceptanceCoverage(revised, f.config, report.sourceFingerprint, f.evidenceStore)).map(c => c.status), ["undischarged", "undischarged"]);
  } finally {await rm(f.root, {recursive: true, force: true});}
});

test("setup failure persists UNKNOWN and never becomes red", async () => {
  const f = await fixture();
  try {
    f.config.verification.acceptanceRunners![0]!.build = [{command: process.execPath, args: ["-e", "process.exit(1)"]}];
    const report = await f.verify();
    assert.equal(report.status, "UNKNOWN");
    assert.ok(report.acceptance?.every(result => result.status === "UNKNOWN"));
    const record = await f.tasks.status({taskId: f.record.task.id});
    assert.equal(record.evidence.behavior?.length, 2);
    assert.ok(record.failureFingerprint);
  } finally {await rm(f.root, {recursive: true, force: true});}
});


test("completed typed task reverification preserves completion and requires original paired artifacts", async () => {
  const f = await fixture();
  try {
    const first = await f.verify();
    assert.equal(first.status, "PASS");
    const original = await f.tasks.status({taskId: f.record.task.id});
    // Seed a previously completed record to exercise the immutable reverification path.
    const completedAt = "2026-10-05T00:00:00.000Z";
    await new FileTaskStore(join(f.root, ".agent-ops/tasks/state.json"), f.root).mutate(state => {
      state.tasks[0] = {...state.tasks[0]!, status: "complete", completedAt};
    });
    assert.equal((await f.verify()).status, "PASS");
    const refreshed = await f.tasks.status({taskId: f.record.task.id});
    assert.equal(refreshed.status, "complete");
    assert.equal(refreshed.completedAt, completedAt);
    assert.ok(original.evidence.behavior!.every(ref => refreshed.evidence.behavior!.includes(ref)));
    assert.ok(refreshed.evidence.behavior!.length > original.evidence.behavior!.length);
    const old = await f.evidenceStore.load(refreshed.evidence.behavior!.at(-1)!) as {acceptance: {executionArtifact: string}};
    await writeFile(join(f.root, old.acceptance.executionArtifact), "changed original execution artifact");
    await assert.rejects(f.verify(), {code: "TASK_REVERIFICATION_CHANGED"});
    assert.equal((await f.tasks.status({taskId: f.record.task.id})).completedAt, completedAt);
  } finally {await rm(f.root, {recursive: true, force: true});}
});
