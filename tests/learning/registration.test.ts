import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import {loadConfigFile} from "../../runtime/src/config/load.js";
import type {AgentOpsConfig} from "../../runtime/src/contracts.js";
import {runGit} from "../../runtime/src/escape/rules.js";
import {digest} from "../../runtime/src/learning/data.js";
import type {CandidateRecord} from "../../runtime/src/learning/history.js";
import {resolveLearningSetup} from "../../runtime/src/learning/setup.js";

// tests/learning/suite.json is this repository's human-labelled automatic-learning suite. Its
// registration lives in the gitignored .agent-ops/config.json, so the committed side is checked
// against the canonical registration, and a local registration (when present) must equal it.
const suitePath = "tests/learning/suite.json";
const settings = {target: "agy", model: "gemini-3.8-flash-high", effort: "high"} as const;
const candidate: CandidateRecord = {
  schemaVersion: 1, history: [],
  author: {taskId: "task-registration-check", attemptId: "check", snapshotHash: "0".repeat(64)},
  proposal: {strategies: [{id: "registration-check", paths: ["runtime/src/learning/**"], cue: "Registration check", check: "Registration check"}],
    expectedImprovement: "None", failureCondition: "None"}
};
const git = async (cwd: string, args: readonly string[]) => {
  const r = await runGit(cwd, args, 30_000);
  return {exitCode: r.code ?? 1, stdout: r.stdout.toString("utf8"), stderr: ""};
};
// Empty history is refused by the first candidate gate, reached only after every setup and suite gate passed.
const resolve = (config: AgentOpsConfig) =>
  resolveLearningSetup({git, mainRoot: process.cwd(), commonDir: process.cwd(), config, candidate});

async function canonical() {
  const suite: unknown = JSON.parse(await readFile(suitePath, "utf8"));
  return {suitePath, suiteDigest: digest(suite), humanConfirmed: true, independentlyLabelled: true, settings};
}

test("learning-suite-registration-eligible", async () => {
  const config = {reviewRoles: [{role: "independent-review", targets: ["agy"]}], learning: await canonical()} as unknown as AgentOpsConfig;
  assert.equal((await resolve(config)).reason, "CANDIDATE_SOURCE_INVALID");
});

test("local-learning-registration-matches-suite", async t => {
  let config: AgentOpsConfig;
  try {({config} = await loadConfigFile(".agent-ops/config.json"));} catch {return t.skip("no local .agent-ops/config.json");}
  if (config.learning === undefined) return t.skip("no local learning registration");
  assert.deepEqual(config.learning, await canonical());
  assert.equal((await resolve(config)).reason, "CANDIDATE_SOURCE_INVALID");
});
