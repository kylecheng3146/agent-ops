import assert from "node:assert/strict";
import test from "node:test";

import type { ReviewTargetId } from "../../runtime/src/contracts.js";
import {
  buildProbeInvocation,
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
  assert.equal(buildTargetInvocation({ target: "codex", prompt: PROMPT })?.command, "codex");
  assert.equal(buildTargetInvocation({ target: "agy", prompt: PROMPT })?.command, "agy");
  assert.deepEqual(argsFor("claude").slice(0, 1), ["-p"]);
  assert.deepEqual(argsFor("codex").slice(0, 2), ["exec", "-"]);
  // claude and codex read the prompt from stdin, which keeps it out of `ps`.
  for (const target of ["claude", "codex"] as const) {
    assert.equal(stdinFor(target), PROMPT);
    assert.ok(!argsFor(target).includes(PROMPT));
  }
  // Unlike Claude, agy requires the prompt as --print's value.
  assert.deepEqual(argsFor("agy").slice(0, 2), ["-p", PROMPT]);
  assert.equal(stdinFor("agy"), "");
});



test("every eligible target carries its read-only flag", () => {
  for (const target of ["agy", "claude", "codex"] as const) {
    const args = argsFor(target);
    const required = READ_ONLY_ARGS[target] ?? [];
    assert.notEqual(required.length, 0, `${target} needs a read-only flag`);
    for (const flag of required) {
      assert.ok(args.includes(flag), `${target} args must include ${flag}`);
    }
  }
  assert.deepEqual(READ_ONLY_ARGS.agy, ["--sandbox", "--mode", "plan"]);
  assert.deepEqual(READ_ONLY_ARGS.claude, ["--permission-mode", "plan"]);
  assert.deepEqual(READ_ONLY_ARGS.codex, ["-s", "read-only"]);
});

test("model flags differ per target and are omitted when unset", () => {
  assert.ok(argsFor("claude", { model: "m" }).join(" ").includes("--model m"));
  assert.ok(argsFor("agy", { model: "m" }).join(" ").includes("--model m"));
  assert.ok(argsFor("codex", { model: "m" }).join(" ").includes("-m m"));
  for (const target of ["agy", "claude", "codex"] as const) {
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
  for (const target of ["claude", "codex"] as const) {
    assert.ok(!argsFor(target).includes("--effort"));
  }
});

test("codex runs outside a trusted git directory", () => {
  // Without this flag codex refuses to start and the caller misreads the
  // non-zero exit as an authentication failure.
  assert.ok(argsFor("codex").includes("--skip-git-repo-check"));
  assert.ok(!argsFor("claude").includes("--skip-git-repo-check"));
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
  assert.ok(argsFor("agy").join(" ").includes("--output-format json"));
  assert.ok(argsFor("claude").join(" ").includes("--output-format json"));
  assert.ok(!argsFor("codex").includes("--output-format"));
  assert.ok(!argsFor("codex").includes("--json"));
});

test("envelope targets use native schemas while Codex stays runtime-validated", () => {
  for (const target of ["agy", "claude", "codex"] as const) {
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
  const target = "opencode" as ReviewTargetId;
  assert.equal(buildTargetInvocation({ target, prompt: PROMPT }), undefined);
  assert.equal(buildProbeInvocation({ target, prompt: PROMPT }), undefined);
  assert.equal(READ_ONLY_ARGS[target], undefined);
});

test("agy uses sandboxed plan mode without bypassing permissions", () => {
  const args = buildTargetInvocation({
    target: "agy",
    prompt: PROMPT,
    logFile: "/tmp/agy.log"
  })?.args ?? [];
  assert.deepEqual(READ_ONLY_ARGS.agy, ["--sandbox", "--mode", "plan"]);
  assert.ok(!args.includes("--dangerously-skip-permissions"));
  assert.ok(!args.includes("--disable-slash-commands"));
  assert.deepEqual(
    args.slice(args.indexOf("--log-file"), args.indexOf("--log-file") + 2),
    ["--log-file", "/tmp/agy.log"]
  );
});

test("the schema handed to a reviewer drops its meta-schema declaration", () => {
  const args = argsFor("agy");
  const schema = args[args.indexOf("--json-schema") + 1] ?? "";
  const parsed = JSON.parse(schema) as Record<string, unknown>;
  // A target that resolves $schema offline rejects the entire schema over it.
  assert.equal(parsed.$schema, undefined);
  // Patterns go too: Go's RE2 refuses lookaheads and \uXXXX escapes, and a
  // target validates the schema before it will run. validateReviewReport still
  // applies the strict patterns to the answer.
  assert.doesNotMatch(schema, /"pattern"/);
  assert.equal(typeof parsed.properties, "object");
  assert.deepEqual(parsed.required, [
    "summary", "results", "findings", "residualRisks",
    "changedFilesInspected", "supportingFilesInspected"
  ]);
});
