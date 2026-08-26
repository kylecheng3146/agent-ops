import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import type {
  AgentOpsConfig,
  VerificationCommand
} from "../../runtime/src/contracts.js";
import { calculateConfigHash } from "../../runtime/src/config/hash.js";
import { StopVerificationService } from "../../runtime/src/hooks/stop-service.js";
import { saveReviewAttestation } from "../../runtime/src/review/attestation.js";
import { resolveReviewScope } from "../../runtime/src/review/scope.js";
import { calculateSourceFingerprint } from "../../runtime/src/verify/source-fingerprint.js";
import type {
  GitRunResult,
  GitRunner
} from "../../runtime/src/verify/change-surface.js";
import type {
  ProcessRequest,
  RunningVerificationProcess,
  VerificationProcessRunner
} from "../../runtime/src/verify/spawn.js";

const HEAD = "0".repeat(40);

async function* output(value = ""): AsyncIterable<Uint8Array> {
  if (value.length > 0) {
    yield Buffer.from(value);
  }
}

/** Reports one changed worktree path and a resolvable HEAD. */
class WorktreeGitRunner implements GitRunner {
  readonly #paths: readonly string[];

  constructor(paths: readonly string[]) {
    this.#paths = paths;
  }

  async run(args: readonly string[]): Promise<GitRunResult> {
    if (args[0] === "rev-parse") {
      return { exitCode: 0, stdout: Buffer.from(`${HEAD}\n`) };
    }
    return {
      exitCode: 0,
      stdout:
        args[0] === "diff" && args[1] === "--cached"
          ? Buffer.from(this.#paths.map((path) => `${path}\0`).join(""))
          : new Uint8Array()
    };
  }
}

class PassingProcessRunner implements VerificationProcessRunner {
  start(_request: ProcessRequest): RunningVerificationProcess {
    return {
      pid: 111,
      stdout: output("# tests 4\n# pass 4\n"),
      stderr: output(),
      completion: Promise.resolve({ exitCode: 0, signal: null }),
      terminateTree: async () => undefined
    };
  }
}

function command(): VerificationCommand {
  return {
    id: "unit",
    command: "unit-tool",
    args: ["--check"],
    cwd: ".",
    required: true,
    evidence: { kind: "test-count", minimum: 1 }
  } as VerificationCommand;
}

function config(reviewRoles: AgentOpsConfig["reviewRoles"]): AgentOpsConfig {
  return {
    schemaVersion: 2,
    profiles: ["core"],
    verification: { commands: [command()] },
    features: { stopVerification: { enabled: true } },
    pathMappings: [{ path: "src", verifierIds: ["unit"] }],
    securityExceptions: [],
    ...(reviewRoles === undefined ? {} : { reviewRoles })
  };
}

const ROLES: AgentOpsConfig["reviewRoles"] = [
  { role: "independent-review", targets: ["codex"] }
];

async function workspace(): Promise<{
  readonly root: string;
  readonly runner: GitRunner;
}> {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-stop-gate-"));
  await writeFile(join(root, "changed.ts"), "export const value = 1;\n", {
    mode: 0o600
  });
  return { root, runner: new WorktreeGitRunner(["changed.ts"]) };
}

function service(
  root: string,
  runner: GitRunner,
  value: AgentOpsConfig
): StopVerificationService {
  return new StopVerificationService({
    root,
    config: value,
    trusted: true,
    gitRunner: runner,
    processRunner: new PassingProcessRunner(),
    recursionActive: false,
    configHash: calculateConfigHash(value)
  });
}

test("fails a stop with passing commands but no independent review", async () => {
  const { root, runner } = await workspace();
  const report = await service(root, runner, config(ROLES)).verify();
  assert.equal(report.status, "FAIL");
  assert.deepEqual(report.results.at(-1), {
    commandId: "independent-review",
    exitCode: 1,
    testCount: null
  });
});

test("passes once an attestation matches the reviewed source state", async () => {
  const { root, runner } = await workspace();
  const scope = await resolveReviewScope({ root, runner });
  await saveReviewAttestation(root, {
    schemaVersion: 1,
    taskId: "task-1234",
    harness: "codex",
    status: "PASS",
    sourceFingerprint: await calculateSourceFingerprint(root, scope, runner),
    createdAt: "2026-08-01T00:00:00.000Z"
  });

  const report = await service(root, runner, config(ROLES)).verify();

  assert.equal(report.status, "PASS");
  assert.deepEqual(report.results.at(-1), {
    commandId: "independent-review",
    exitCode: 0,
    testCount: null
  });
});

test("fails again after the reviewed source state changes", async () => {
  const { root, runner } = await workspace();
  const scope = await resolveReviewScope({ root, runner });
  await saveReviewAttestation(root, {
    schemaVersion: 1,
    taskId: "task-1234",
    harness: "codex",
    status: "PASS",
    sourceFingerprint: await calculateSourceFingerprint(root, scope, runner),
    createdAt: "2026-08-01T00:00:00.000Z"
  });
  await writeFile(join(root, "changed.ts"), "export const value = 2;\n", {
    mode: 0o600
  });

  const report = await service(root, runner, config(ROLES)).verify();

  assert.equal(report.status, "FAIL");
});

test("applies no gate without configured review roles", async () => {
  const { root, runner } = await workspace();
  const report = await service(root, runner, config(undefined)).verify();
  assert.equal(report.status, "PASS");
  assert.deepEqual(
    report.results.map(({ commandId }) => commandId),
    ["unit"]
  );
});

test("stays fail-open when the reviewed source state cannot be fingerprinted", async () => {
  const { root } = await workspace();
  // Change surface resolves, HEAD does not: the gate cannot know which source
  // state a review would cover, so it must not block.
  const runner: GitRunner = {
    async run(args: readonly string[]): Promise<GitRunResult> {
      if (args[0] === "rev-parse") {
        return { exitCode: 128, stdout: new Uint8Array() };
      }
      return {
        exitCode: 0,
        stdout:
          args[0] === "diff" && args[1] === "--cached"
            ? Buffer.from("changed.ts\0")
            : new Uint8Array()
      };
    }
  };
  const report = await service(root, runner, config(ROLES)).verify();
  assert.equal(report.status, "PASS");
  assert.deepEqual(
    report.results.map(({ commandId }) => commandId),
    ["unit"]
  );
});
