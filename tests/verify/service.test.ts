import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  AgentOpsConfig,
  VerificationCommand
} from "../../runtime/src/contracts.js";
import { AgentOpsError } from "../../runtime/src/fs/paths.js";
import { TaskService } from "../../runtime/src/task/service.js";
import { FileTaskStore } from "../../runtime/src/task/store.js";
import type {
  GitRunResult,
  GitRunner
} from "../../runtime/src/verify/change-surface.js";
import { FileEvidenceStore } from "../../runtime/src/verify/evidence.js";
import {
  VerificationService
} from "../../runtime/src/verify/service.js";
import type {
  ProcessCompletion,
  ProcessRequest,
  RunningVerificationProcess,
  VerificationProcessRunner
} from "../../runtime/src/verify/spawn.js";

const SECRET = `ghp_${"a".repeat(24)}`;

function nul(...paths: readonly string[]): Uint8Array {
  return Buffer.from(paths.map((path) => `${path}\0`).join(""), "utf8");
}

class SurfaceRunner implements GitRunner {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  async run(args: readonly string[]): Promise<GitRunResult> {
    return {
      exitCode: 0,
      stdout: args[0] === "rev-parse"
        ? Buffer.from(`${"a".repeat(40)}\n`)
        : args[0] === "diff" && args[1] === "--cached"
          ? nul(this.#path)
          : new Uint8Array()
    };
  }
}

async function* output(value = ""): AsyncIterable<Uint8Array> {
  if (value.length > 0) {
    yield Buffer.from(value);
  }
}

interface ProcessFixture {
  readonly completion: ProcessCompletion;
  readonly stdout?: string;
  readonly stderr?: string;
}

class FixtureProcessRunner implements VerificationProcessRunner {
  readonly calls: ProcessRequest[] = [];
  readonly #fixtures: Readonly<Record<string, ProcessFixture>>;

  constructor(fixtures: Readonly<Record<string, ProcessFixture>>) {
    this.#fixtures = fixtures;
  }

  start(request: ProcessRequest): RunningVerificationProcess {
    this.calls.push(request);
    const fixture = this.#fixtures[request.command] ?? {
      completion: {
        exitCode: null,
        signal: null,
        errorCode: "ENOENT"
      }
    };
    return {
      pid: 123,
      stdout: output(fixture.stdout),
      stderr: output(fixture.stderr),
      completion: Promise.resolve(fixture.completion),
      terminateTree: async () => undefined
    };
  }
}

function verifier(
  id: string,
  evidence: VerificationCommand["evidence"]
): VerificationCommand {
  return {
    id,
    command: `${id}-tool`,
    args: ["--check"],
    cwd: ".",
    required: true,
    evidence
  };
}

function config(): AgentOpsConfig {
  return {
    schemaVersion: 3,
    profiles: ["core"],
    verification: {
      commands: [
        verifier("unit", {
          kind: "test-count",
          minimum: 1
        }),
        verifier("lint", { kind: "exit-code" })
      ]
    },
    features: {
      completionGate: { enabled: false },
      stopVerification: { enabled: false }
    },
    pathMappings: [
      { path: "src", verifierIds: ["unit"] }
    ],
    securityExceptions: []
  };
}

async function taskService(root: string): Promise<{
  service: TaskService;
  taskId: string;
}> {
  const service = new TaskService(
    new FileTaskStore(
      join(root, ".agent-ops", "tasks", "state.json"),
      root
    ),
    {
      generateId: () => "task-one",
      now: () => "2026-07-23T12:00:00.000Z"
    }
  );
  const task = await service.create({
    title: "Verify the change",
    criteria: [
      {
        id: "criterion-unit",
        description: "Unit tests pass.",
        verifierIds: ["unit"]
      },
      {
        id: "criterion-lint",
        description: "Lint passes.",
        verifierIds: ["lint"]
      }
    ]
  });
  return { service, taskId: task.task.id };
}

function clock(): () => string {
  let second = 0;
  return () =>
    `2026-07-23T12:00:${String(second++).padStart(2, "0")}.000Z`;
}

test("runs only a known mapped scope and persists criterion evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-verify-"));
  try {
    const task = await taskService(root);
    const runner = new FixtureProcessRunner({
      "unit-tool": {
        completion: { exitCode: 0, signal: null },
        stdout: "# tests 2\n# pass 2\n"
      }
    });
    const service = new VerificationService({
      root,
      scope: "project",
      config: config(),
      gitRunner: new SurfaceRunner("src/example.ts"),
      processRunner: runner,
      taskService: task.service,
      evidenceStore: new FileEvidenceStore(root, root),
      trusted: true,
      now: clock(),
      toolVersions: { node: "v22.14.0" }
    });

    const report = await service.verify(task.taskId);

    assert.equal(report.status, "PASS");
    assert.equal(report.selection.reason, "mapped");
    assert.deepEqual(
      report.results.map(({ commandId }) => commandId),
      ["unit"]
    );
    assert.equal(report.results[0]?.testCount, 2);
    assert.equal(report.results[0]?.evidenceReferences.length, 1);
    assert.deepEqual(
      runner.calls.map(({ command, shell }) => ({ command, shell })),
      [{ command: "unit-tool", shell: false }]
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fallback failures persist a redacted consecutive fingerprint", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-verify-"));
  try {
    const task = await taskService(root);
    const original = (
      await task.service.status({ taskId: task.taskId })
    ).task;
    const service = new VerificationService({
      root,
      scope: "project",
      config: config(),
      gitRunner: new SurfaceRunner("README.md"),
      processRunner: new FixtureProcessRunner({
        "unit-tool": {
          completion: { exitCode: 0, signal: null },
          stdout: "# tests 1\n# pass 1\n"
        },
        "lint-tool": {
          completion: { exitCode: 1, signal: null },
          stderr: `token=${SECRET}`
        }
      }),
      taskService: task.service,
      evidenceStore: new FileEvidenceStore(root, root),
      trusted: true,
      now: clock(),
      toolVersions: { node: "v22.14.0" }
    });

    const first = await service.verify(task.taskId);
    const second = await service.verify(task.taskId);

    assert.equal(first.status, "FAIL");
    assert.equal(first.signal, null);
    assert.equal(second.status, "FAIL");
    assert.equal(second.signal, "CHANGE_APPROACH_REQUIRED");
    assert.doesNotMatch(JSON.stringify(second), new RegExp(SECRET));
    const stored = await task.service.status({ taskId: task.taskId });
    assert.deepEqual(stored.task, original);
    assert.equal(stored.failureFingerprint?.consecutive, 2);
    assert.doesNotMatch(
      stored.failureFingerprint?.diagnostics ?? "",
      new RegExp(SECRET)
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("zero tests fail and missing tools remain UNKNOWN", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-verify-"));
  try {
    const task = await taskService(root);
    const zero = new VerificationService({
      root,
      scope: "project",
      config: config(),
      gitRunner: new SurfaceRunner("src/example.ts"),
      processRunner: new FixtureProcessRunner({
        "unit-tool": {
          completion: { exitCode: 0, signal: null },
          stdout: "# tests 0\n"
        }
      }),
      taskService: task.service,
      evidenceStore: new FileEvidenceStore(root, root),
      trusted: true,
      now: clock(),
      toolVersions: { node: "v22.14.0" }
    });
    assert.equal((await zero.verify(task.taskId)).status, "FAIL");

    const missing = new VerificationService({
      root,
      scope: "project",
      config: config(),
      gitRunner: new SurfaceRunner("src/example.ts"),
      processRunner: new FixtureProcessRunner({}),
      taskService: task.service,
      evidenceStore: new FileEvidenceStore(root, root),
      trusted: true,
      now: clock(),
      toolVersions: { node: "v22.14.0" }
    });
    assert.equal((await missing.verify(task.taskId)).status, "UNKNOWN");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file evidence cannot PASS without an artifact contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-verify-"));
  try {
    const task = await taskService(root);
    const fileConfig = config();
    fileConfig.verification.commands[0] = verifier(
      "unit",
      { kind: "file" }
    );
    const service = new VerificationService({
      root,
      scope: "project",
      config: fileConfig,
      gitRunner: new SurfaceRunner("src/example.ts"),
      processRunner: new FixtureProcessRunner({
        "unit-tool": {
          completion: { exitCode: 0, signal: null }
        }
      }),
      taskService: task.service,
      evidenceStore: new FileEvidenceStore(root, root),
      trusted: true,
      now: clock(),
      toolVersions: { node: "v22.14.0" }
    });

    const report = await service.verify(task.taskId);

    assert.equal(report.status, "UNKNOWN");
    assert.equal(
      report.results[0]?.failureClass,
      "file-evidence-unsupported"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an untrusted repository never starts a configured process", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-verify-"));
  try {
    const task = await taskService(root);
    const runner = new FixtureProcessRunner({});
    const service = new VerificationService({
      root,
      scope: "project",
      config: config(),
      gitRunner: new SurfaceRunner("src/example.ts"),
      processRunner: runner,
      taskService: task.service,
      evidenceStore: new FileEvidenceStore(root, root),
      trusted: false,
      now: clock(),
      toolVersions: { node: "v22.14.0" }
    });

    const report = await service.verify(task.taskId);

    assert.equal(report.status, "UNKNOWN");
    assert.equal(report.results[0]?.failureClass, "repository-untrusted");
    assert.equal(runner.calls.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an archived task is rejected before any configured process starts", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-ops-verify-"));
  try {
    const task = await taskService(root);
    await task.service.archive(task.taskId);
    const runner = new FixtureProcessRunner({
      "unit-tool": {
        completion: { exitCode: 0, signal: null },
        stdout: "# tests 1\n"
      }
    });
    const service = new VerificationService({
      root,
      scope: "project",
      config: config(),
      gitRunner: new SurfaceRunner("src/example.ts"),
      processRunner: runner,
      taskService: task.service,
      evidenceStore: new FileEvidenceStore(root, root),
      trusted: true,
      now: clock(),
      toolVersions: { node: "v22.14.0" }
    });

    await assert.rejects(
      service.verify(task.taskId),
      (error: unknown) =>
        error instanceof AgentOpsError &&
        error.code === "TASK_NOT_ACTIVE"
    );
    assert.equal(runner.calls.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
