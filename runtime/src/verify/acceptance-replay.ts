import {lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile, chmod} from "node:fs/promises";
import {dirname, join, delimiter, isAbsolute} from "node:path";
import {tmpdir} from "node:os";
import {writePrivateFile} from "../security/permissions.js";
import {redactSecrets} from "../security/redact.js";
import {randomUUID} from "node:crypto";
import type {AcceptanceBinding, AcceptanceRunner, AgentOpsConfig, AgentTask, VerificationEvidence} from "../contracts.js";
import {canonicalJson} from "../config/hash.js";
import {sha256} from "../fs/hash.js";
import {AgentOpsError, resolveContainedPath} from "../fs/paths.js";
import {criterionContractHash, taskContractHash} from "../task/contract.js";
import {aggregateAcceptanceRun, makeAcceptanceCheck, makeAcceptanceRun, type AcceptanceRun, type AcceptanceAggregate, type AcceptancePhase} from "./acceptance-protocol.js";
import {collectNodeAcceptance, collectJestAcceptance, collectVitestAcceptance, collectPytestAcceptance, collectRustAcceptance} from "./adapters/index.js";
import {buildVerificationEvidence, type FileEvidenceStore} from "./evidence.js";
import {collectChangeSurface, resolveGitCommit, type GitRunner} from "./change-surface.js";
import {runVerificationCommand, type VerificationProcessRunner, type SpawnResult} from "./spawn.js";

export interface AcceptanceReplayOptions {
  readonly root: string;
  readonly task: AgentTask;
  readonly config: AgentOpsConfig;
  readonly gitRunner: GitRunner;
  readonly processRunner: VerificationProcessRunner;
  readonly evidenceStore: FileEvidenceStore;
  readonly sourceFingerprint: string;
  readonly trusted: boolean;
  readonly scope: "project" | "user";
  readonly signal?: AbortSignal;
}
export interface AcceptanceReplayResult {
  readonly criterionId: string;
  readonly runnerId: string;
  readonly phase: AcceptancePhase;
  readonly status: "PASS" | "FAIL" | "UNKNOWN";
  readonly failureClass: string;
  readonly reference: string;
}

async function executableIdentity(command: string, cwd: string, env: Record<string, string>): Promise<string> {
  const paths = isAbsolute(command) ? [command] : command.includes("/") ? [join(cwd, command)] :
    (env.PATH ?? "").split(delimiter).filter(Boolean).map(path => join(path, command));
  for (const path of paths) {
    try {
      const resolved = await realpath(path);
      const entry = await lstat(resolved);
      if (!entry.isFile() || (process.platform !== "win32" && (entry.mode & 0o111) === 0)) continue;
      return sha256(canonicalJson({path: resolved, bytes: sha256(await readFile(resolved))}));
    } catch { /* Try the next fixed PATH entry. */ }
  }
  return "unavailable";
}

function replayEnvironment(checkout: string, phase: AcceptancePhase, executionId: string): Record<string, string> {
  const env = Object.fromEntries(Object.entries(process.env).filter((pair): pair is [string, string] =>
    pair[1] !== undefined && !/^(?:NODE_OPTIONS|NODE_PATH|PYTHONPATH|PYTHONHOME|CARGO_TARGET_DIR|RUSTC_WRAPPER|RUSTC_WORKSPACE_WRAPPER|AGENT_OPS_|CLAUDE_|CODEX_)/u.test(pair[0])));
  env.PATH = [join(checkout, "node_modules/.bin"), join(checkout, ".venv/bin"),
    ...(process.env.PATH ?? "").split(delimiter).filter(path => !path.includes("node_modules/.bin"))].join(delimiter);
  env.AGENT_OPS_ACCEPTANCE_PHASE = phase;
  env.AGENT_OPS_ACCEPTANCE_EXECUTION_ID = executionId;
  return env;
}

function collected(runner: AcceptanceRunner, output: SpawnResult, checkout: string, options: {executionId: string; phase: AcceptancePhase; frameworkVersion: string}): AcceptanceRun {
  if (output.timedOut || output.signal !== null || output.stdoutTruncated || output.stderrTruncated || output.status === "UNKNOWN")
    return makeAcceptanceRun({...options, framework: runner.adapter, results: [], completed: false, diagnostics: [output.failureClass]});
  // Framework file identities must be repository-relative across disposable checkouts.
  const normalize = (value: unknown): unknown => typeof value === "string" && value.startsWith(checkout + "/") ? value.slice(checkout.length + 1) :
    Array.isArray(value) ? value.map(normalize) : typeof value === "object" && value !== null ?
      Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item)])) : value;
  let structured = output.stdout;
  try { structured = JSON.stringify(normalize(JSON.parse(structured))); }
  catch { structured = structured.split("\n").map(line => { try { return JSON.stringify(normalize(JSON.parse(line))); } catch { return line; } }).join("\n"); }
  switch (runner.adapter) {
    case "node": return collectNodeAcceptance(structured, options);
    case "jest": return collectJestAcceptance(structured, options);
    case "vitest": return collectVitestAcceptance(structured, options);
    case "pytest": return collectPytestAcceptance(structured, options);
    case "rust": return collectRustAcceptance(structured, options);
    case "generic": {
      const value = JSON.parse(structured) as AcceptanceRun;
      if (value.protocolVersion !== 1 || value.executionId !== options.executionId || value.phase !== options.phase)
        throw new TypeError("Generic output does not match this execution.");
      return makeAcceptanceRun({...value, results: value.results.map(makeAcceptanceCheck)});
    }
  }
}

/** Clean disposable clones are verification checkouts, never managed writer worktrees. */
export async function replayAcceptance(options: AcceptanceReplayOptions): Promise<AcceptanceReplayResult[]> {
  if (!options.trusted) throw new AgentOpsError("VERIFICATION_UNTRUSTED", "Acceptance runners require the repository's current trust binding.");
  if ((await collectChangeSurface(options.gitRunner)).paths.length > 0)
    throw new AgentOpsError("ACCEPTANCE_COMMITTED_SOURCE_REQUIRED", "Formal acceptance replay requires a clean committed candidate.");
  const candidate = await resolveGitCommit(options.gitRunner, "HEAD");
  const groups = new Map<string, {baseline: string; runner: AcceptanceRunner; binding: AcceptanceBinding; criteria: AgentTask["criteria"]}>();
  for (const criterion of options.task.criteria) {
    if (criterion.acceptance === undefined || criterion.acceptance.mode === "review-only") continue;
    for (const binding of criterion.acceptance.bindings) {
      const runner = options.config.verification.acceptanceRunners?.find(r => r.id === binding.runnerId);
      if (runner === undefined) throw new AgentOpsError("ACCEPTANCE_RUNNER_MISSING", "The acceptance runner is not configured.");
      const key = canonicalJson({baseline: criterion.acceptance.baselineCommit, runner, materials: binding.materials});
      const group = groups.get(key);
      if (group === undefined) groups.set(key, {baseline: criterion.acceptance.baselineCommit, runner, binding, criteria: [criterion]});
      else if (!group.criteria.some(c => c.id === criterion.id)) group.criteria.push(criterion);
    }
  }
  const reports: AcceptanceReplayResult[] = [];
  for (const group of groups.values()) {
    const materials = [] as Array<{path: string; role: string; bytes: Uint8Array; mode: number}>;
    for (const material of group.binding.materials) {
      const metadata = await options.gitRunner.run(["ls-tree", "-z", candidate, "--", material.path]);
      const entry = Buffer.from(metadata.stdout).toString("utf8").match(/^(100644|100755) blob ([a-f0-9]+)\t([^\0]+)\0$/u);
      if (metadata.exitCode !== 0 || entry === null || entry[3] !== material.path)
        throw new AgentOpsError("ACCEPTANCE_UNSAFE_MATERIAL", "Acceptance materials must be committed regular files.");
      const blob = await options.gitRunner.run(["cat-file", "blob", entry[2]!]);
      if (blob.exitCode !== 0 || blob.stdout.byteLength > 1024 * 1024)
        throw new AgentOpsError("ACCEPTANCE_MATERIAL_UNAVAILABLE", "Acceptance material exceeds its bound or is unavailable.");
      materials.push({...material, bytes: blob.stdout, mode: entry[1] === "100755" ? 0o755 : 0o644});
    }
    const materialDigest = sha256(canonicalJson(materials.map(m => ({path: m.path, role: m.role, mode: m.mode, hash: sha256(m.bytes)}))));
    for (const phase of ["baseline", "candidate"] as const) {
      const commit = phase === "baseline" ? group.baseline : candidate;
      const executionId = randomUUID();
      const startedAt = new Date().toISOString();
      const temp = await mkdtemp(join(tmpdir(), "agent-ops-acceptance-"));
      const checkout = join(temp, "repository");
      const env = replayEnvironment(checkout, phase, executionId);
      const command = async (executable: string, args: readonly string[], cwd: string, timeoutMs = 60_000) =>
        await runVerificationCommand({id: group.runner.id, command: executable, args: [...args], cwd: ".", required: true,
          evidence: {kind: "exit-code"}, timeoutMs}, {cwd, runner: options.processRunner, env, replaceEnv: true,
          outputLimitBytes: 1024 * 1024, ...(options.signal === undefined ? {} : {signal: options.signal})});
      let aggregate: AcceptanceAggregate | undefined;
      let failure = "replay-unavailable";
      let output: SpawnResult | undefined;
      let run: AcceptanceRun | undefined;
      const steps: Array<{command: string; args: readonly string[]; status: string; failureClass: string; stderr: string}> = [];
      let executionDigest = sha256(executionId);
      let argv: string[] = [];
      const requested = [...new Set(group.criteria.flatMap(c => c.acceptance!.bindings
        .filter(b => b.runnerId === group.runner.id && canonicalJson(b.materials) === canonicalJson(group.binding.materials)).flatMap(b => b.checkIds)))];
      try {
        for (const [cwd, args] of [[temp, ["clone", "--no-hardlinks", "--quiet", "--", options.root, checkout]],
          [checkout, ["fetch", "--quiet", "--", options.root, commit]], [checkout, ["checkout", "--detach", "--quiet", commit]]] as const) {
          const result = await command("git", args, cwd);
          if (result.status !== "PASS") throw new Error("checkout-unavailable");
        }
        const cwd = group.runner.cwd === "." ? checkout : await resolveContainedPath(checkout, group.runner.cwd);
        for (const step of [...(group.runner.setup ?? []), ...(group.runner.build ?? [])]) {
          const result = await command(step.command, step.args, cwd, step.timeoutMs);
          steps.push({command: step.command, args: step.args, status: result.status, failureClass: result.failureClass, stderr: result.stderr});
          if (result.status !== "PASS") throw new Error("setup-or-build-unavailable");
        }
        // Both sides receive exactly the candidate's explicit test material, after their own build.
        for (const material of materials) {
          let parent = checkout;
          for (const segment of material.path.split("/").slice(0, -1)) {
            parent = join(parent, segment);
            try { if (!(await lstat(parent)).isDirectory()) throw new Error("unsafe-material-parent"); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; await mkdir(parent); }
          }
          const path = join(checkout, ...material.path.split("/"));
          try { if (!(await lstat(path)).isFile()) throw new Error("unsafe-material-target"); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
          await writeFile(path, material.bytes);
          await chmod(path, material.mode);
        }
        for (const step of group.runner.testBuild ?? []) {
          const result = await command(step.command, step.args, cwd, step.timeoutMs);
          steps.push({command: step.command, args: step.args, status: result.status, failureClass: result.failureClass, stderr: result.stderr});
          if (result.status !== "PASS") throw new Error("test-build-unavailable");
        }
        argv = group.runner.args.flatMap(arg => arg === "{materials}" ?
          materials.filter(m => m.role === "test").map(m => m.path) : [arg]);
        const dependencies = [] as Array<{path: string; hash: string}>;
        for (const path of ["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "Cargo.toml", "Cargo.lock", "pyproject.toml", "requirements.txt"]) {
          try { dependencies.push({path, hash: sha256(await readFile(join(checkout, path)))}); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        }
        const identity = await executableIdentity(group.runner.command, cwd, env);
        if (identity === "unavailable") throw new Error("missing-executable");
        executionDigest = sha256(canonicalJson({commit, materialDigest, runner: group.runner, argv, dependencies,
          executable: identity, platform: process.platform, arch: process.arch, environment: sha256(canonicalJson(env))}));
        output = await command(group.runner.command, argv, cwd, group.runner.timeoutMs);
        run = collected(group.runner, output, checkout, {executionId, phase,
          frameworkVersion: group.runner.adapter === "node" ? process.version : "dependency-lock:" + sha256(canonicalJson(dependencies))});
        aggregate = aggregateAcceptanceRun(run, requested);
        // Process errors never become assertion red, even if stdout claims a result.
        if (output.exitCode === null || output.status === "UNKNOWN" ||
            (aggregate.status === "PASS" && output.exitCode !== 0) || (aggregate.status === "FAIL" && output.exitCode === 0))
          aggregate = undefined;
        failure = aggregate?.failureClass ?? output.failureClass;
      } catch (error) {
        failure = error instanceof Error && /^[a-z-]+$/u.test(error.message) ? error.message : "replay-unavailable";
      } finally { await rm(temp, {recursive: true, force: true}); }
      const finishedAt = new Date().toISOString();
      const artifactContent = redactSecrets(JSON.stringify({schemaVersion: 1, executionId, phase, commit,
        pairedCommit: phase === "baseline" ? candidate : group.baseline, materialDigest, executionDigest,
        runner: group.runner, argv, run: run ?? null, aggregate: aggregate ?? null, output: output ?? null, steps, failure, startedAt, finishedAt}));
      const executionArtifact = ".agent-ops/tasks/acceptance/" + sha256(artifactContent) + ".json";
      await writePrivateFile(join(options.root, ...executionArtifact.split("/")), artifactContent, options.root);
      for (const criterion of group.criteria) {
        const bindings = criterion.acceptance!.bindings.filter(b => b.runnerId === group.runner.id && canonicalJson(b.materials) === canonicalJson(group.binding.materials));
        const binding = {checkIds: [...new Set(bindings.flatMap(b => b.checkIds))], redCheckIds: [...new Set(bindings.flatMap(b => b.redCheckIds ?? []))]};
        const checks = binding.checkIds.map(checkId => {
          const check = aggregate?.results.find(result => result.checkId === checkId);
          return {checkId, status: check?.status ?? "UNKNOWN" as const,
            failureClass: check?.failureClass === "assertion-failed" ? "assertion" : check?.failureClass ?? failure};
        });
        const red = binding.redCheckIds ?? [];
        const status = aggregate === undefined || aggregate.status === "UNKNOWN" ? "UNKNOWN" :
          phase === "candidate" ? checks.every(c => c.status === "PASS") ? "PASS" : "FAIL" :
          red.every(id => checks.some(c => c.checkId === id && c.status === "FAIL" && c.failureClass === "assertion")) ? "PASS" : "FAIL";
        const evidence: VerificationEvidence = buildVerificationEvidence({taskId: options.task.id, criterionId: criterion.id,
          command: {id: group.runner.id, command: group.runner.command, args: argv, cwd: group.runner.cwd, required: true, evidence: {kind: "exit-code"}},
          scope: options.scope, startedAt, finishedAt, exitCode: output?.exitCode ?? null, testCount: checks.length,
          status, failureClass: status === "PASS" ? "none" : phase === "baseline" && aggregate?.status === "PASS" ? "non-discriminating" : failure,
          sourceFingerprint: options.sourceFingerprint, toolVersions: {node: process.version}, config: options.config,
          taskContractHash: taskContractHash(options.task), acceptance: {criterionContractHash: criterionContractHash(criterion),
            bindingHash: sha256(canonicalJson({runnerId: group.runner.id, materials: group.binding.materials})), phase, commit, pairedCommit: phase === "baseline" ? candidate : group.baseline, materialDigest, executionDigest, executionArtifact, checks}});
        const reference = await options.evidenceStore.save(evidence);
        reports.push({criterionId: criterion.id, runnerId: group.runner.id, phase, status, failureClass: evidence.failureClass, reference});
      }
    }
  }
  return reports;
}
