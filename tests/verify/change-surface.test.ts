import assert from "node:assert/strict";
import test from "node:test";

import { AgentOpsError } from "../../runtime/src/fs/paths.js";
import {
  collectChangeSurface,
  type GitRunResult,
  type GitRunner
} from "../../runtime/src/verify/change-surface.js";

function nul(...paths: readonly string[]): Uint8Array {
  return Buffer.from(paths.map((path) => `${path}\0`).join(""), "utf8");
}

function argvKey(args: readonly string[]): string {
  return JSON.stringify(args);
}

const STAGED_ARGS = [
  "diff", "--cached", "--name-only", "--full-name", "--no-renames",
  "--no-ext-diff", "--no-textconv", "-z"
] as const;
const UNSTAGED_ARGS = [
  "diff", "--name-only", "--full-name", "--no-renames", "--no-ext-diff",
  "--no-textconv", "-z"
] as const;

class FakeGitRunner implements GitRunner {
  readonly calls: string[][] = [];
  private readonly results: ReadonlyMap<string, GitRunResult>;

  constructor(entries: readonly (readonly [readonly string[], GitRunResult])[]) {
    this.results = new Map(
      entries.map(([args, result]) => [argvKey(args), result])
    );
  }

  async run(args: readonly string[]): Promise<GitRunResult> {
    this.calls.push([...args]);
    return (
      this.results.get(argvKey(args)) ?? {
        exitCode: 0,
        stdout: new Uint8Array()
      }
    );
  }
}

test("collects staged, unstaged, and untracked paths without a shell", async () => {
  const runner = new FakeGitRunner([
    [
      STAGED_ARGS,
      { exitCode: 0, stdout: nul("src/z.ts", "src/shared.ts") }
    ],
    [
      UNSTAGED_ARGS,
      {
        exitCode: 0,
        stdout: nul(
          "src/shared.ts",
          "./src//a.ts",
          "src/a.ts",
          "docs/My Guide.md",
          "src/元件.ts"
        )
      }
    ],
    [
      ["ls-files", "--others", "--exclude-standard", "-z"],
      { exitCode: 0, stdout: nul("new/file.ts", "new/file.ts") }
    ]
  ]);

  const surface = await collectChangeSurface(runner);

  assert.deepEqual(runner.calls, [
    STAGED_ARGS,
    UNSTAGED_ARGS,
    ["ls-files", "--others", "--exclude-standard", "-z"]
  ]);
  assert.deepEqual(surface.staged, ["src/shared.ts", "src/z.ts"]);
  assert.deepEqual(surface.unstaged, [
    "docs/My Guide.md",
    "src/a.ts",
    "src/shared.ts",
    "src/元件.ts"
  ]);
  assert.deepEqual(surface.untracked, ["new/file.ts"]);
  assert.deepEqual(surface.paths, [
    "new/file.ts",
    "docs/My Guide.md",
    "src/a.ts",
    "src/shared.ts",
    "src/元件.ts",
    "src/z.ts"
  ].sort());
});

test("rejects malformed or unsafe NUL-delimited Git output", async (t) => {
  const cases: readonly {
    readonly name: string;
    readonly stdout: Uint8Array;
    readonly code: string;
  }[] = [
    {
      name: "missing terminal NUL",
      stdout: Buffer.from("src/file.ts", "utf8"),
      code: "CHANGE_SURFACE_INVALID_OUTPUT"
    },
    {
      name: "empty entry",
      stdout: Buffer.from("src/file.ts\0\0", "utf8"),
      code: "CHANGE_SURFACE_INVALID_OUTPUT"
    },
    {
      name: "invalid UTF-8",
      stdout: Uint8Array.from([0xff, 0]),
      code: "CHANGE_SURFACE_INVALID_OUTPUT"
    },
    {
      name: "parent traversal",
      stdout: nul("../secret"),
      code: "CHANGE_SURFACE_UNSAFE_PATH"
    },
    {
      name: "absolute path",
      stdout: nul("/absolute"),
      code: "CHANGE_SURFACE_UNSAFE_PATH"
    },
    {
      name: "Windows drive path",
      stdout: nul("C:/root"),
      code: "CHANGE_SURFACE_UNSAFE_PATH"
    },
    {
      name: "backslash path",
      stdout: nul("src\\bad.ts"),
      code: "CHANGE_SURFACE_UNSAFE_PATH"
    },
    {
      name: "reserved segment",
      stdout: nul("src/NUL.txt"),
      code: "CHANGE_SURFACE_UNSAFE_PATH"
    },
    {
      name: "terminal control in path",
      stdout: nul("src/\u001b[31m.ts"),
      code: "CHANGE_SURFACE_UNSAFE_PATH"
    }
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const runner = new FakeGitRunner([
        [
          STAGED_ARGS,
          { exitCode: 0, stdout: scenario.stdout }
        ]
      ]);

      await assert.rejects(
        collectChangeSurface(runner),
        (error: unknown) =>
          error instanceof AgentOpsError && error.code === scenario.code
      );
    });
  }
});

test("fails closed when a Git command exits non-zero", async () => {
  const runner = new FakeGitRunner([
    [
      STAGED_ARGS,
      { exitCode: 2, stdout: new Uint8Array() }
    ]
  ]);

  await assert.rejects(
    collectChangeSurface(runner),
    (error: unknown) =>
      error instanceof AgentOpsError &&
      error.code === "CHANGE_SURFACE_GIT_FAILED"
  );
});
