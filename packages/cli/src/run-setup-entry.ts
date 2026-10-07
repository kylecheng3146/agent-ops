import {FileRunRepository} from "../../../runtime/src/run/service.js";
import {readRunPolicy, runRuntimeHash} from "../../../runtime/src/run/policy.js";
import {activeWallTimeMs} from "../../../runtime/src/run/scheduler.js";
import {runVerificationCommand, NodeVerificationProcessRunner} from "../../../runtime/src/verify/spawn.js";
import {redactSecrets} from "../../../runtime/src/security/redact.js";
import {join} from "node:path";
import {realpath} from "node:fs/promises";
import {execFileSync} from "node:child_process";

// This entry is released by run-step-entry only after its process group is registered.
const [commonDir, runId, root, index, expectedPolicy] = process.argv.slice(2);
if ([commonDir, runId, root, index, expectedPolicy].some(v => v === undefined)) throw new Error("Incomplete run setup identity.");
const repository = new FileRunRepository(join(commonDir!, "agent-ops/runs"), commonDir!);
const state = await repository.read(runId!);
const group = process.env.AGENT_OPS_RUN_PROOF_PID;
const actualCommon = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {cwd: root, encoding: "utf8"}).trim();
if (state === null || state.status !== "active" || state.disableRestart || state.proofProcess?.processId !== Number(group) ||
  state.policyBinding?.artifactDigest !== expectedPolicy || await realpath(actualCommon) !== await realpath(state.commonDir)) throw new Error("Stale run setup authorization.");
const policy = await readRunPolicy(state, await runRuntimeHash());
const step = /^(?:0|[1-9][0-9]*)$/u.test(index!) ? policy?.config.worktree?.setup?.[Number(index)] : undefined;
if (step === undefined) throw new Error("Setup must select an authorized fixed policy command.");
const remaining = state.budget.limitMs - activeWallTimeMs(state.budget.activeIntervals, Date.now());
if (remaining <= 0) throw new Error("Run budget is exhausted.");
const result = await runVerificationCommand({id: "run-setup", ...step, cwd: ".", required: true,
  timeoutMs: Math.min(step.timeoutMs ?? 600000, remaining), evidence: {kind: "exit-code"}}, {
  cwd: root!, runner: new NodeVerificationProcessRunner({processGroupId: Number(group)})});
process.stdout.write(JSON.stringify({exitCode: result.status === "PASS" ? 0 : result.exitCode ?? 1,
  output: redactSecrets(result.stdout + result.stderr)}) + "\n");
