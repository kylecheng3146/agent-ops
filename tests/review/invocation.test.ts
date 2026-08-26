import assert from "node:assert/strict";
import test from "node:test";

import type { ReviewTargetId } from "../../runtime/src/contracts.js";
import {
  buildTargetInvocation,
  READ_ONLY_ARGS
} from "../../runtime/src/review/invocation.js";

const PROMPT = "Review the requested criteria.";

function argsFor(
  target: ReviewTargetId,
  overrides: { model?: string; effort?: string } = {}
): readonly string[] {
  const invocation = buildTargetInvocation({
    target,
    prompt: PROMPT,
    ...overrides
  });
  assert.notEqual(invocation, undefined, `${target} must be eligible`);
  return invocation?.args ?? [];
}

function stdinFor(target: ReviewTargetId): string {
  const invocation = buildTargetInvocation({ target, prompt: PROMPT });
  assert.notEqual(invocation, undefined);
  return invocation?.stdin ?? "";
}

test("each target gets its own executable and subcommand", () => {
  assert.equal(buildTargetInvocation({ target: "claude", prompt: PROMPT })?.command, "claude");
  assert.equal(buildTargetInvocation({ target: "agy", prompt: PROMPT })?.command, "agy");
  assert.equal(buildTargetInvocation({ target: "codex", prompt: PROMPT })?.command, "codex");
  assert.deepEqual(argsFor("claude").slice(0, 1), ["-p"]);
  assert.deepEqual(argsFor("agy").slice(0, 1), ["-p"]);
  assert.deepEqual(argsFor("codex").slice(0, 2), ["exec", "-"]);
  for (const target of ["claude", "agy", "codex"] as const) {
    assert.equal(stdinFor(target), PROMPT);
    assert.ok(!argsFor(target).includes(PROMPT));
  }
});

test("every eligible target carries its read-only flag", () => {
  for (const target of ["claude", "agy", "codex"] as const) {
    const args = argsFor(target);
    const required = READ_ONLY_ARGS[target];
    assert.notEqual(required.length, 0, `${target} needs a read-only flag`);
    for (const flag of required) {
      assert.ok(args.includes(flag), `${target} args must include ${flag}`);
    }
  }
  assert.deepEqual(READ_ONLY_ARGS.claude, ["--permission-mode", "plan"]);
  assert.deepEqual(READ_ONLY_ARGS.agy, ["--sandbox", "--mode", "plan"]);
  assert.deepEqual(READ_ONLY_ARGS.codex, ["-s", "read-only"]);
});

test("model flags differ per target and are omitted when unset", () => {
  assert.ok(argsFor("claude", { model: "m" }).join(" ").includes("--model m"));
  assert.ok(argsFor("agy", { model: "m" }).join(" ").includes("--model m"));
  assert.ok(argsFor("codex", { model: "m" }).join(" ").includes("-m m"));
  for (const target of ["claude", "agy", "codex"] as const) {
    assert.ok(!argsFor(target).some((arg) => arg === "--model" || arg === "-m"));
  }
});

test("codex routes effort through a config override, the others through a flag", () => {
  assert.ok(argsFor("claude", { effort: "high" }).join(" ").includes("--effort high"));
  assert.ok(argsFor("agy", { effort: "high" }).join(" ").includes("--effort high"));
  assert.deepEqual(
    argsFor("codex", { effort: "high" }).filter(
      (arg) => arg === "-c" || arg.startsWith("model_reasoning_effort")
    ),
    ["-c", "model_reasoning_effort=high"]
  );
  for (const target of ["claude", "agy", "codex"] as const) {
    assert.ok(!argsFor(target).includes("--effort"));
  }
});

test("codex runs outside a trusted git directory", () => {
  // Without this flag codex refuses to start and the caller misreads the
  // non-zero exit as an authentication failure.
  assert.ok(argsFor("codex").includes("--skip-git-repo-check"));
  assert.ok(!argsFor("claude").includes("--skip-git-repo-check"));
  assert.ok(!argsFor("agy").includes("--skip-git-repo-check"));
});

test("codex opens the repository as its read-only working root", () => {
  const args = buildTargetInvocation({
    target: "codex",
    prompt: PROMPT,
    repositoryRoot: "/repository"
  })?.args ?? [];
  assert.deepEqual(args.slice(args.indexOf("-C"), args.indexOf("-C") + 2), [
    "-C",
    "/repository"
  ]);
  assert.ok(!args.includes("--add-dir"));
});

test("only the JSON-envelope targets get an output-format flag", () => {
  assert.ok(argsFor("claude").join(" ").includes("--output-format json"));
  assert.ok(argsFor("agy").join(" ").includes("--output-format json"));
  assert.ok(!argsFor("codex").includes("--output-format"));
  assert.ok(!argsFor("codex").includes("--json"));
});

test("envelope targets use native schemas while Codex stays runtime-validated", () => {
  for (const target of ["claude", "agy", "codex"] as const) {
    const args = argsFor(target, { model: "m", effort: "high" });
    assert.ok(!args.includes("-o"));
    if (target === "codex") {
      assert.ok(!args.includes("--output-schema"));
      continue;
    }
    assert.ok(args.includes("--json-schema"));
  }
});

test("a target with no read-only flag is ineligible rather than unsandboxed", () => {
  assert.equal(
    buildTargetInvocation({
      target: "opencode" as ReviewTargetId,
      prompt: PROMPT
    }),
    undefined
  );
});
