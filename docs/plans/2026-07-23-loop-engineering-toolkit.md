# Loop Engineering Toolkit Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Deliver a reviewable, cross-platform `@kylecheng3146/agent-ops` pre-1.0 implementation that installs evidence-driven Loop Engineering rules and safe Node.js lifecycle hooks for Codex and Claude Code without publishing to npm.

**Architecture:** The repository is one TypeScript npm package with no runtime dependencies. A transactional CLI manages project/user installations, while harness-specific adapters translate native configuration and lifecycle protocols into a shared runtime. English specifications are canonical; Traditional Chinese documents mirror stable rule IDs.

**Tech Stack:** Node.js `>=22.14.0`, TypeScript, Node built-in `node:test`, npm, JSON Schema documents, GitHub Actions, Markdown.

**Approved design:** `docs/plans/2026-07-23-loop-engineering-toolkit-design.md`

**Worktree:** `.worktrees/loop-engineering-toolkit`

**Branch:** `feat/loop-engineering-toolkit`

## Delivery acceptance criteria

1. `npm ci`, `npm run typecheck`, `npm test`, `npm run build`, and
   `npm run package:check` all exit 0; tests execute a non-zero count.
2. Lifecycle fixtures prove `init → doctor → update → uninstall` for project
   and user scopes, all three profiles, and both harnesses without overwriting
   unmanaged content.
3. Guardrail, trust, scope fallback, zero-test, rollback, config migration, and
   fresh-review failure paths have observable regression tests.
4. The packed npm tarball has zero runtime dependencies and contains only the
   declared CLI, runtime, schemas, templates, English/Traditional Chinese
   specifications, and required legal/security files.
5. Repository and tarball scans contain no source-project identifiers, internal
   domains, personal absolute paths, literal credentials, or unapproved network
   telemetry code.
6. macOS, Linux, and Windows CI jobs exercise the supported Node matrix and the
   package-installed CLI; the release workflow cannot publish from a pull
   request or ordinary merge.
7. A fresh-context reviewer independently re-runs the delivery criteria and
   returns criterion-level `PASS` evidence before PR creation.

## Execution rules

- Use `@superpowers:test-driven-development` for every behavior task.
- Use one red → green → refactor cycle at a time; do not batch implementation
  ahead of failing tests.
- Commit after each task or bounded subtask using the commit message shown.
- Do not publish an npm version, enable GitHub release credentials, or weaken a
  failing check.
- For 3+ documentation files with the same pattern, create and review one
  exemplar before delegating bounded batches.
- Before completion, use `@superpowers:verification-before-completion` and an
  independent fresh-context reviewer.

### Task 1: Bootstrap the zero-runtime-dependency TypeScript package

**Files:**
- Create: `package.json`
- Create: `package-lock.json`
- Create: `tsconfig.json`
- Create: `tsconfig.build.json`
- Create: `tsconfig.test.json`
- Create: `scripts/clean.mjs`
- Create: `scripts/run-tests-lib.mjs`
- Create: `scripts/run-tests.mjs`
- Create: `packages/cli/src/bin.ts`
- Test: `tests/package-metadata.test.mjs`
- Test: `tests/run-tests.test.mjs`

**Step 1: Write the failing bootstrap tests**

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("package exposes a Node 22 CLI without runtime dependencies", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.name, "@kylecheng3146/agent-ops");
  assert.equal(pkg.engines.node, ">=22.14.0");
  assert.equal(pkg.bin["agent-ops"], "dist/packages/cli/src/bin.js");
  assert.deepEqual(pkg.dependencies ?? {}, {});
});
```

Test `collectTestFiles()` with nested fixtures supplied through injected
filesystem functions. Assert it accepts explicit files and directories,
recurses, de-duplicates, sorts paths deterministically, rejects unsupported
inputs, and fails when zero `*.test.js` files are found. Keep process spawning
behind a separately injected function so the unit test does not recursively
launch itself. Assert the entry passes `process.execPath`, an explicit
`["--test", ...sortedFiles]` argv, and `shell: false` to the injected spawn;
the entry must propagate signals and every non-zero child exit code instead of
reporting a false PASS.

**Step 2: Run the test and verify it fails**

Run:
`node --test tests/package-metadata.test.mjs tests/run-tests.test.mjs`

Expected: FAIL because `package.json` and the test-runner module do not exist.

**Step 3: Add package and compiler scaffolding**

Create an ESM package with these scripts:

```json
{
  "name": "@kylecheng3146/agent-ops",
  "version": "0.0.0-development",
  "private": true,
  "description": "Evidence-driven development loops for Codex and Claude Code",
  "type": "module",
  "license": "MIT",
  "repository": "github:kylecheng3146/agent-ops",
  "engines": { "node": ">=22.14.0" },
  "bin": { "agent-ops": "dist/packages/cli/src/bin.js" },
  "files": [
    "dist/",
    "schemas/",
    "templates/",
    "docs/en/spec/",
    "docs/zh-TW/spec/",
    "README.md",
    "LICENSE",
    "SECURITY.md"
  ],
  "publishConfig": { "access": "public" },
  "scripts": {
    "clean": "node scripts/clean.mjs dist .tmp",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test:compile": "node scripts/clean.mjs .tmp/test-dist && tsc -p tsconfig.test.json",
    "test": "npm run test:compile && node scripts/run-tests.mjs .tmp/test-dist/tests",
    "build": "node scripts/clean.mjs dist && tsc -p tsconfig.build.json",
    "package:check": "node scripts/package-check.mjs"
  }
}
```

Use `module`/`moduleResolution: NodeNext`, strict mode, no implicit `any`, and
separate `dist` and `.tmp/test-dist` outputs. `scripts/clean.mjs` MUST reject
absolute paths and any target outside the allowlist `dist`/`.tmp`.
TypeScript source uses explicit `.js` import specifiers so compiled ESM works in
Node without a loader.
`scripts/run-tests-lib.mjs` recursively resolves sorted `*.test.js` files from
explicit file/directory arguments. `scripts/run-tests.mjs` is the thin process
entry: it exits non-zero when it finds zero tests and spawns `node --test`
without shell glob expansion.

**Step 4: Install only pinned development dependencies**

Run: `npm install --save-dev --save-exact typescript @types/node`

Expected: `package-lock.json` records exact versions; `dependencies` remains
absent or empty.

**Step 5: Add the minimal CLI entry**

```ts
#!/usr/bin/env node

process.stdout.write("agent-ops: implementation in progress\n");
```

**Step 6: Run bootstrap checks**

Run:
`node --test tests/package-metadata.test.mjs tests/run-tests.test.mjs && npm run typecheck && npm run build`

Expected: PASS, at least one test, and an executable shebang in the compiled
entry.

**Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig*.json scripts/clean.mjs scripts/run-tests-lib.mjs scripts/run-tests.mjs packages/cli/src/bin.ts tests/package-metadata.test.mjs tests/run-tests.test.mjs
git commit -m "build: bootstrap agent-ops CLI"
```

### Task 2: Define versioned contracts and schema validation

**Files:**
- Create: `schemas/config.schema.json`
- Create: `schemas/task.schema.json`
- Create: `schemas/evidence.schema.json`
- Create: `schemas/manifest.schema.json`
- Create: `runtime/src/contracts.ts`
- Create: `runtime/src/schema/validate.ts`
- Test: `tests/schema/validate.test.ts`
- Test fixtures: `tests/fixtures/schema/*.json`

**Step 1: Write failing valid/invalid fixture tests**

```ts
test("rejects shell execution without explicit acknowledgement", () => {
  const result = validateConfig({
    schemaVersion: 1,
    verification: {
      commands: [{ id: "test", command: "npm test", shell: true }]
    }
  });
  assert.equal(result.ok, false);
  assert.match(result.errors[0]?.code ?? "", /SHELL_ACK_REQUIRED/);
});
```

Cover wrong schema versions, duplicate IDs, unknown verifier references,
invalid relative paths, malformed profile names, unsafe exception scope, and a
fully valid config.

**Step 2: Run the targeted test and verify it fails**

Run: `npm run test:compile && node scripts/run-tests.mjs .tmp/test-dist/tests/schema/validate.test.js`

Expected: FAIL because contracts and validator do not exist.

**Step 3: Define the contracts**

Use discriminated types with `schemaVersion: 1`. The verifier command shape is:

```ts
export interface VerifierCommand {
  id: string;
  command: string;
  args: string[];
  cwd: string;
  required: boolean;
  shell?: false;
  timeoutMs?: number;
  evidence: { kind: "exit-code" | "test-count" | "file"; minimum?: number };
}
```

Represent shell commands with a separate discriminant requiring
`shell: true` and `acknowledgeRisk: true`; do not make unsafe fields optional.

**Step 4: Implement bounded validation**

Validate JSON values with explicit type guards and stable error codes. Do not
execute code, import config modules, or add a runtime schema dependency. Keep
JSON Schema documents aligned through shared fixture tests.

**Step 5: Run tests and type-check**

Run: `npm run typecheck && npm run test:compile && node scripts/run-tests.mjs .tmp/test-dist/tests/schema/validate.test.js`

Expected: PASS with non-zero tests.

**Step 6: Commit**

```bash
git add schemas runtime/src/contracts.ts runtime/src/schema tests/schema tests/fixtures/schema
git commit -m "feat: define versioned agent-ops contracts"
```

### Task 3: Build the CLI parser, output contract, and wizard boundary

**Files:**
- Modify: `packages/cli/src/bin.ts`
- Create: `packages/cli/src/cli.ts`
- Create: `packages/cli/src/args.ts`
- Create: `packages/cli/src/output.ts`
- Create: `packages/cli/src/wizard.ts`
- Test: `tests/cli/args.test.ts`
- Test: `tests/cli/help.test.ts`

**Step 1: Write failing parser and help tests**

Cover all command names, `--scope`, `--harness`, repeated `--profile`,
`--dry-run`, `--json`, `--yes`, unknown flags, and missing required values.
Assert non-TTY input never silently chooses a scope/harness/profile.

```ts
assert.deepEqual(parseArgs([
  "init",
  "--scope", "project",
  "--harness", "both",
  "--profile", "core"
]), {
  command: "init",
  scope: "project",
  harness: "both",
  profiles: ["core"],
  dryRun: false,
  json: false,
  yes: false
});
```

**Step 2: Verify red**

Run: `npm run test:compile && node scripts/run-tests.mjs .tmp/test-dist/tests/cli`

Expected: FAIL because parser modules do not exist.

**Step 3: Implement a dependency-free parser and injected I/O**

Expose `runCli(argv, io, services): Promise<number>`. Do not call
`process.exit()` below `bin.ts`. Output JSON envelopes with stable `code`,
`status`, `data`, and `errors` fields. Use `node:readline/promises` only when
`io.isTTY` is true.

**Step 4: Implement help/version without side effects**

`agent-ops --help` and `agent-ops --version` MUST NOT load user/project config,
touch the filesystem, or query the network.

**Step 5: Run tests**

Run: `npm run typecheck && npm run test:compile && node scripts/run-tests.mjs .tmp/test-dist/tests/cli`

Expected: PASS.

**Step 6: Commit**

```bash
git add packages/cli/src tests/cli
git commit -m "feat: add deterministic CLI interface"
```

### Task 4: Implement path policy, managed blocks, and transactional writes

**Files:**
- Create: `runtime/src/fs/paths.ts`
- Create: `runtime/src/fs/hash.ts`
- Create: `runtime/src/fs/managed-block.ts`
- Create: `runtime/src/fs/transaction.ts`
- Create: `runtime/src/fs/manifest.ts`
- Test: `tests/fs/managed-block.test.ts`
- Test: `tests/fs/transaction.test.ts`

**Step 1: Write failing conflict and rollback tests**

Cover create, update, remove, repeated idempotent apply, malformed marker,
precondition-hash mismatch, write failure after one file, and rollback. Use only
temporary directories.

```ts
await assert.rejects(
  transaction.apply(planAfterExternalEdit),
  (error: AgentOpsError) => error.code === "PRECONDITION_CHANGED"
);
assert.equal(await readFile(target, "utf8"), externallyEditedContent);
```

**Step 2: Verify red**

Run: `npm run test:compile && node scripts/run-tests.mjs .tmp/test-dist/tests/fs`

Expected: FAIL.

**Step 3: Implement path containment and marker operations**

Resolve canonical paths, reject traversal/symlink escapes, and use markers:

```md
<!-- agent-ops:start core-routing v1 -->
...
<!-- agent-ops:end core-routing -->
```

Only one exact marker pair is valid. Never repair ambiguous markers
automatically.

**Step 4: Implement per-file atomic replacement plus operation rollback**

Stage content in the destination directory, fsync where supported, replace one
file at a time, and retain backups until post-apply validation succeeds. Be
explicit that multi-file operations are transactional through rollback, not an
impossible cross-filesystem atomic rename.

**Step 5: Run tests and inspect permissions**

Run: `npm run typecheck && npm run test:compile && node scripts/run-tests.mjs .tmp/test-dist/tests/fs`

Expected: PASS; backup/state files use owner-only permissions where the OS
supports them.

**Step 6: Commit**

```bash
git add runtime/src/fs tests/fs
git commit -m "feat: add reversible managed file transactions"
```

### Task 5: Add config layering, migrations, and provenance explanation

**Files:**
- Create: `runtime/src/config/load.ts`
- Create: `runtime/src/config/merge.ts`
- Create: `runtime/src/config/migrate.ts`
- Create: `runtime/src/config/explain.ts`
- Create: `packages/cli/src/commands/config.ts`
- Test: `tests/config/merge.test.ts`
- Test: `tests/config/migrate.test.ts`

**Step 1: Write failing precedence and monotonic-security tests**

Assert project values override normal user defaults by stable ID, but project
config cannot disable a user guardrail. Assert migration preview is pure and an
unknown future schema refuses to load.

**Step 2: Verify red**

Run: `npm run test:compile && node scripts/run-tests.mjs .tmp/test-dist/tests/config`

Expected: FAIL.

**Step 3: Implement provenance-aware merge**

Return both effective config and provenance:

```ts
interface EffectiveValue<T> {
  value: T;
  source: "default" | "user" | "project";
  sourcePath: string;
}
```

Security arrays merge monotonically; verifier commands and mappings merge by
stable ID; conflicting duplicate IDs are errors.

**Step 4: Implement migration registry and `config explain`**

Migrations are pure `N → N+1` functions with fixture snapshots. Never mutate a
file before preview/backup. `config explain --json` includes no secret values.

**Step 5: Run tests**

Run: `npm run typecheck && npm run test:compile && node scripts/run-tests.mjs .tmp/test-dist/tests/config`

Expected: PASS.

**Step 6: Commit**

```bash
git add runtime/src/config packages/cli/src/commands/config.ts tests/config
git commit -m "feat: merge and migrate layered configuration"
```

### Task 6: Implement repository trust, redaction, and local retention

**Files:**
- Create: `runtime/src/security/trust.ts`
- Create: `runtime/src/security/redact.ts`
- Create: `runtime/src/security/permissions.ts`
- Create: `runtime/src/logging/local-log.ts`
- Create: `packages/cli/src/commands/trust.ts`
- Test: `tests/security/trust.test.ts`
- Test: `tests/security/trust-command.test.ts`
- Test: `tests/security/redact.test.ts`
- Test: `tests/logging/local-log.test.ts`

**Step 1: Write failing trust lifecycle, invalidation, and secret tests**

Trust must bind canonical path, normalized Git remote identity, config hash, and
managed-runtime hash. Moving a repo or changing any bound value invalidates it.
Redaction fixtures include tokens, authorization headers, URLs with query
credentials, private keys, and benign lookalikes.
Exercise `agent-ops trust status`, `agent-ops trust grant`, and
`agent-ops trust revoke` through injected paths and identity calculators.
`grant` must print or return the complete calculated binding before it records
the user-local decision. Non-interactive grant requires the dedicated
`agent-ops trust grant --yes` action; `init --yes`, config discovery, and hook
execution must never infer or silently grant trust.

**Step 2: Verify red**

Run: `npm run test:compile && node scripts/run-tests.mjs .tmp/test-dist/tests/security .tmp/test-dist/tests/logging`

Expected: FAIL.

**Step 3: Implement the explicit trust lifecycle and local-only stores**

Use injected home/state paths for tests. Trust records, logs, and failure
artifacts are never written inside tracked project paths by default. Apply
owner-only permissions and bounded retention by age and bytes.
Status compares every bound field and reports `TRUSTED`, `UNTRUSTED`, or
`STALE` with the mismatched field names. Grant requires a positive user action;
revoke is idempotent and removes only the exact calculated repository binding.

**Step 4: Implement allowlisted log events**

Reject arbitrary object logging. Define event-specific fields and redact before
serialization. Do not persist prompts, full command strings, environment, or
raw stdout/stderr.

**Step 5: Run tests**

Run: `npm run typecheck && npm run test:compile && node scripts/run-tests.mjs .tmp/test-dist/tests/security .tmp/test-dist/tests/logging`

Expected: PASS.

**Step 6: Commit**

```bash
git add runtime/src/security runtime/src/logging packages/cli/src/commands/trust.ts tests/security tests/logging
git commit -m "feat: add repository trust and private local state"
```

### Task 7: Add bounded technology-stack discovery adapters

**Files:**
- Create: `runtime/src/discovery/types.ts`
- Create: `runtime/src/discovery/node.ts`
- Create: `runtime/src/discovery/python.ts`
- Create: `runtime/src/discovery/go.ts`
- Create: `runtime/src/discovery/rust.ts`
- Create: `runtime/src/discovery/make.ts`
- Create: `runtime/src/discovery/index.ts`
- Test: `tests/discovery/*.test.ts`
- Test fixtures: `tests/fixtures/discovery/**`

**Step 1: Create one Node adapter exemplar test**

Assert package-manager selection follows lockfiles and proposed commands retain
`confirmed: false`. Do not infer test success or execute package scripts.

**Step 2: Verify red and implement the Node exemplar**

Run: `npm run test:compile && node scripts/run-tests.mjs .tmp/test-dist/tests/discovery/node.test.js`

Expected before implementation: FAIL. Implement minimal Node discovery, rerun,
and expect PASS.

**Step 3: Add bounded adapters in independent batches**

After exemplar review, implement Python/`pyproject.toml`, Go, Rust/Cargo, and
Make fixtures. Each adapter returns proposals with source evidence and
confidence; it never runs commands.

**Step 4: Add ambiguity and no-match tests**

Multiple package managers or unknown scripts produce a user decision, not a
silent default. Unsupported stacks still allow manual config.

**Step 5: Run all discovery tests**

Run: `npm run typecheck && npm run test:compile && node scripts/run-tests.mjs .tmp/test-dist/tests/discovery`

Expected: PASS.

**Step 6: Commit**

```bash
git add runtime/src/discovery tests/discovery tests/fixtures/discovery
git commit -m "feat: discover verifier command candidates"
```

### Task 8: Implement profile planning and `init`

**Files:**
- Create: `runtime/src/install/types.ts`
- Create: `runtime/src/install/profiles.ts`
- Create: `runtime/src/install/plan.ts`
- Create: `runtime/src/install/apply.ts`
- Create: `runtime/src/install/harness.ts`
- Create: `packages/cli/src/commands/init.ts`
- Create: `templates/common/AGENTS.block.md`
- Create: `templates/common/CLAUDE.block.md`
- Test: `tests/install/plan.test.ts`
- Test: `tests/install/init.test.ts`

**Step 1: Write failing dry-run and idempotency tests**

Cover project/user scope, core/advisory/guardrails, existing instruction files,
malformed markers, untrusted repo, `--json`, and non-TTY missing flags. Inject
fake Codex/Claude adapters to test harness selection here; native settings and
event semantics are tested only in Tasks 14 and 15.

**Step 2: Verify red**

Run: `npm run test:compile && node scripts/run-tests.mjs .tmp/test-dist/tests/install`

Expected: FAIL.

**Step 3: Implement composable profiles**

Profiles resolve to capabilities, not copied files:

```ts
const PROFILE_CAPABILITIES = {
  core: ["rules", "task", "verify", "review"],
  advisory: ["lifecycle-summary", "local-log"],
  guardrails: ["command-policy", "optional-stop-verify"]
} as const;
```

Guardrails imply core; advisory remains separately selectable.

**Step 4: Implement pure plan generation and explicit apply**

`init --dry-run` returns the complete operation plan without writing. Apply
requires a complete non-interactive plan or TTY approval. `--yes` cannot infer
`--scope user`, trust, shell acknowledgement, or a security exception.

**Step 5: Run tests**

Run: `npm run typecheck && npm run test:compile && node scripts/run-tests.mjs .tmp/test-dist/tests/install`

Expected: PASS.

**Step 6: Commit**

```bash
git add runtime/src/install packages/cli/src/commands/init.ts templates/common tests/install
git commit -m "feat: plan and apply profile installations"
```

### Task 9: Implement `doctor`, `update`, and `uninstall`

**Files:**
- Create: `packages/cli/src/commands/doctor.ts`
- Create: `packages/cli/src/commands/update.ts`
- Create: `packages/cli/src/commands/uninstall.ts`
- Create: `runtime/src/install/doctor.ts`
- Create: `runtime/src/install/update.ts`
- Create: `runtime/src/install/uninstall.ts`
- Create: `runtime/src/registry/npm.ts`
- Test: `tests/install/lifecycle.test.ts`
- Test: `tests/install/network-policy.test.ts`

**Step 1: Write failing lifecycle tests**

Assert `init → doctor → update → uninstall` preserves unmanaged content,
restores clean markers, retains rollback evidence, and is idempotent. Inject a
registry client and assert only explicit `update` can call it.

**Step 2: Verify red**

Run: `npm run test:compile && node scripts/run-tests.mjs .tmp/test-dist/tests/install/lifecycle.test.js .tmp/test-dist/tests/install/network-policy.test.js`

Expected: FAIL.

**Step 3: Implement deterministic doctor checks**

Check Node version, config/schema, paths, marker integrity, hook registration,
runtime hashes, trust, verifier references, and smoke-test availability. Do not
repair unless the user invokes an explicit repair/apply flow.

**Step 4: Implement explicit update and managed uninstall**

Update accepts a supplied target version in tests, previews migrations, and
rolls back on validation failure. Uninstall removes only manifest-owned files
and blocks; backups are retained according to policy.

**Step 5: Run tests**

Run: `npm run typecheck && npm run test:compile && node scripts/run-tests.mjs .tmp/test-dist/tests/install`

Expected: PASS.

**Step 6: Commit**

```bash
git add packages/cli/src/commands runtime/src/install runtime/src/registry tests/install
git commit -m "feat: manage the installation lifecycle"
```

### Task 10: Implement independent task state

**Files:**
- Create: `runtime/src/task/store.ts`
- Create: `runtime/src/task/service.ts`
- Create: `runtime/src/task/render.ts`
- Create: `packages/cli/src/commands/task.ts`
- Test: `tests/task/task.test.ts`
- Test: `tests/task/session-attachment.test.ts`

**Step 1: Write failing task lifecycle tests**

Cover `create/status/attach/complete/archive`, 2–5 criterion limits, evidence
requirements, concurrent sessions, stale historical tasks, and export.

**Step 2: Verify red**

Run: `npm run test:compile && node scripts/run-tests.mjs .tmp/test-dist/tests/task`

Expected: FAIL.

**Step 3: Implement task records and session binding**

Use generated task IDs and an injected session identity. A historical task can
be read but is never attached to a new request without an explicit command.

**Step 4: Implement human and JSON output**

Markdown is a view/export of structured state, not a second writable source.
Completion requires evidence references for every criterion.

**Step 5: Run tests**

Run: `npm run typecheck && npm run test:compile && node scripts/run-tests.mjs .tmp/test-dist/tests/task`

Expected: PASS.

**Step 6: Commit**

```bash
git add runtime/src/task packages/cli/src/commands/task.ts tests/task
git commit -m "feat: persist independent acceptance tasks"
```

### Task 11: Implement scoped verification and evidence

**Files:**
- Create: `runtime/src/verify/change-surface.ts`
- Create: `runtime/src/verify/scope.ts`
- Create: `runtime/src/verify/spawn.ts`
- Create: `runtime/src/verify/test-count.ts`
- Create: `runtime/src/verify/evidence.ts`
- Create: `runtime/src/verify/fingerprint.ts`
- Create: `runtime/src/verify/service.ts`
- Create: `packages/cli/src/commands/verify.ts`
- Test: `tests/verify/*.test.ts`
- Test: `tests/verify/fingerprint.test.ts`

**Step 1: Write failing change-surface and fallback tests**

Fixtures must distinguish staged, unstaged, and untracked files. Known mappings
select bounded commands; unknown/shared/conflicting mappings select all required
checks.

**Step 2: Write failing process and evidence tests**

Assert argv execution uses `shell: false`, shell commands require explicit
acknowledgement, timeout kills the process tree, zero tests fail, missing tools
are UNKNOWN, and evidence does not contain raw secrets.
Normalize failures into a stable fingerprint without raw secret-bearing output.
The first occurrence records the failure; the second consecutive occurrence for
the same task emits `CHANGE_APPROACH_REQUIRED`. A different fingerprint resets
the consecutive count, and no fingerprint path may weaken or rewrite verifier
commands, required checks, timeouts, or guardrail configuration.

**Step 3: Verify red**

Run: `npm run test:compile && node scripts/run-tests.mjs .tmp/test-dist/tests/verify`

Expected: FAIL.

**Step 4: Implement the verifier**

Inject process and Git runners. Return explicit statuses:

```ts
type VerificationStatus = "PASS" | "FAIL" | "UNKNOWN";
```

Only all required `PASS` results produce a total PASS. Persist structured
evidence after redaction and config-hash calculation. Store per-task failure
fingerprints in local task state. Fingerprints contain only check identity,
normalized failure class, exit/timeout category, and redacted bounded
diagnostics. On the second consecutive match, return the stable
`CHANGE_APPROACH_REQUIRED` signal while preserving the original FAIL or UNKNOWN
status and all required checks.

**Step 5: Run tests**

Run: `npm run typecheck && npm run test:compile && node scripts/run-tests.mjs .tmp/test-dist/tests/verify`

Expected: PASS with non-zero tests.

**Step 6: Commit**

```bash
git add runtime/src/verify packages/cli/src/commands/verify.ts tests/verify
git commit -m "feat: verify changed scopes with explicit evidence"
```

### Task 12: Implement deterministic guardrails

**Files:**
- Create: `runtime/src/guardrails/types.ts`
- Create: `runtime/src/guardrails/secrets.ts`
- Create: `runtime/src/guardrails/destructive.ts`
- Create: `runtime/src/guardrails/exceptions.ts`
- Create: `runtime/src/guardrails/evaluate.ts`
- Test: `tests/guardrails/secrets.test.ts`
- Test: `tests/guardrails/destructive.test.ts`
- Test fixtures: `tests/fixtures/guardrails/*.json`

**Step 1: Write positive and negative fixture tests**

Include broad deletion targets, resolved environment/glob uncertainty, force
push, destructive reset, private keys, high-entropy credentials, benign hashes,
documentation examples, and already-redacted values.

**Step 2: Verify red**

Run: `npm run test:compile && node scripts/run-tests.mjs .tmp/test-dist/tests/guardrails`

Expected: FAIL.

**Step 3: Implement confidence-tiered decisions**

```ts
type GuardrailDecision =
  | { action: "allow" }
  | { action: "warn"; ruleId: string; reason: string }
  | { action: "block"; ruleId: string; reason: string; saferAlternative?: string };
```

Only high-confidence fixtures block. Exceptions bind rule, scope, expiry, and
reason; expired or broad exceptions are invalid.

**Step 4: Run tests and scan fixture output**

Run: `npm run typecheck && npm run test:compile && node scripts/run-tests.mjs .tmp/test-dist/tests/guardrails`

Expected: PASS; no test output contains literal credential material.

**Step 5: Commit**

```bash
git add runtime/src/guardrails tests/guardrails tests/fixtures/guardrails
git commit -m "feat: enforce confidence-tiered local guardrails"
```

### Task 13: Build the normalized hook engine

**Files:**
- Create: `runtime/src/hooks/events.ts`
- Create: `runtime/src/hooks/normalize.ts`
- Create: `runtime/src/hooks/dispatch.ts`
- Create: `runtime/src/hooks/output.ts`
- Create: `runtime/src/hooks/hook-entry.ts`
- Create: `runtime/src/hooks/stop-verify.ts`
- Test: `tests/hooks/engine.test.ts`
- Test: `tests/hooks/stop-verify.test.ts`

**Step 1: Write failing event/failure-mode tests**

Cover advisory fail-open, guardrail block, verifier UNKNOWN, output size limits,
invalid JSON stdin, untrusted project, unsupported event, and Stop recursion
prevention.

**Step 2: Verify red**

Run: `npm run test:compile && node scripts/run-tests.mjs .tmp/test-dist/tests/hooks/engine.test.js .tmp/test-dist/tests/hooks/stop-verify.test.js`

Expected: FAIL.

**Step 3: Implement a harness-neutral internal contract**

Adapters normalize only fields used by policy. Never persist transcripts or
unknown payload fields. Dispatch capabilities according to installed profiles.

**Step 4: Implement opt-in Stop verification**

Require confirmed config, trusted repo, scope mapping, and a recursion marker.
Emit the exact executed command IDs, test counts, exit codes, config hash, and
timestamp. Do not mark the task complete.

**Step 5: Run tests**

Run: `npm run typecheck && npm run test:compile && node scripts/run-tests.mjs .tmp/test-dist/tests/hooks`

Expected: PASS.

**Step 6: Commit**

```bash
git add runtime/src/hooks tests/hooks
git commit -m "feat: add portable lifecycle hook engine"
```

### Task 14: Implement and smoke-test the Codex adapter

**Files:**
- Create: `runtime/src/adapters/codex/config.ts`
- Create: `runtime/src/adapters/codex/input.ts`
- Create: `runtime/src/adapters/codex/output.ts`
- Create: `runtime/src/adapters/codex/events.ts`
- Create: `tests/fixtures/codex/hooks-existing.json`
- Test: `tests/adapters/codex.test.ts`
- Create: `research/protocols/codex-hook-smoke.md`

**Step 1: Capture the official contract in fixtures**

Document the verified source/date for hook locations, cumulative layers,
definition-hash trust, matcher support, command-only handlers, default timeout,
`commandWindows`, common stdin fields, supported output fields, and output-size
limits. The current official manual explicitly establishes that exit `0` with
no output means success/continue. It does not establish a portable non-zero
exit contract, so record non-zero exit behavior as `UNKNOWN` rather than
inferring Claude Code's semantics. Do not encode undocumented event parity.

**Step 2: Write failing merge/input/output tests**

Assert the adapter merges only its own hook groups, preserves unrelated groups,
uses one representation per layer, emits portable project/user commands, and
does not claim project hooks run before Codex trusts the project. Fixture tests
may assert documented exit-0 and JSON behavior only; they must not turn an
unobserved non-zero outcome into a normative contract.

**Step 3: Verify red**

Run: `npm run test:compile && node scripts/run-tests.mjs .tmp/test-dist/tests/adapters/codex.test.js`

Expected: FAIL.

**Step 4: Implement Codex-native semantics**

Support the documented common subset needed by profiles. Treat concurrent
matching hooks and specialized tool paths as limitations. Never use Claude
exit-2 or event-specific JSON semantics in this adapter. Preserve
`UNKNOWN` for undocumented non-zero exit behavior until a version-stamped
bounded smoke observes it, and keep observed behavior in the research protocol
rather than promoting it to the normative spec without official documentation.

**Step 5: Run fixture tests and bounded CLI smoke**

Run: `npm run typecheck && npm run test:compile && node scripts/run-tests.mjs .tmp/test-dist/tests/adapters/codex.test.js`

Then, only when the current Codex CLI exposes hooks, run the protocol in
`research/protocols/codex-hook-smoke.md`; otherwise record UNKNOWN without
changing the unit-test expectation.

**Step 6: Commit**

```bash
git add runtime/src/adapters/codex tests/adapters/codex.test.ts tests/fixtures/codex research/protocols/codex-hook-smoke.md
git commit -m "feat: integrate Codex lifecycle hooks"
```

### Task 15: Implement and smoke-test the Claude Code adapter

**Files:**
- Create: `runtime/src/adapters/claude/config.ts`
- Create: `runtime/src/adapters/claude/input.ts`
- Create: `runtime/src/adapters/claude/output.ts`
- Create: `runtime/src/adapters/claude/events.ts`
- Create: `tests/fixtures/claude/settings-existing.json`
- Test: `tests/adapters/claude.test.ts`
- Create: `research/protocols/claude-hook-smoke.md`

**Step 1: Capture the official Claude contract in fixtures**

Record settings locations/precedence, cumulative instruction behavior, hook
locations, event matchers, JSON stdin, event-specific output/exit behavior,
direct exec form, shell fallback, and Windows PowerShell behavior. Explicitly
record that Claude has no standalone `.claude/hooks.json`.

**Step 2: Write failing merge/input/output tests**

Assert project install edits `.claude/settings.json`, user install edits
`~/.claude/settings.json`, unrelated settings survive, `CLAUDE.md` receives a
bounded routing block, direct exec is preferred, and event-specific exit/JSON
decisions are preserved.

**Step 3: Verify red**

Run: `npm run test:compile && node scripts/run-tests.mjs .tmp/test-dist/tests/adapters/claude.test.js`

Expected: FAIL.

**Step 4: Implement Claude-native semantics**

Do not model `CLAUDE.md` as a hard policy override. Do not reuse Codex trust,
matcher, output, or blocking semantics. In non-interactive `-p` environments,
surface Claude's trust limitation rather than claiming protection.

**Step 5: Run fixture tests and bounded CLI smoke**

Run: `npm run typecheck && npm run test:compile && node scripts/run-tests.mjs .tmp/test-dist/tests/adapters/claude.test.js`

Run the smoke protocol only when a compatible authenticated Claude CLI is
available; otherwise record UNKNOWN.

**Step 6: Commit**

```bash
git add runtime/src/adapters/claude tests/adapters/claude.test.ts tests/fixtures/claude research/protocols/claude-hook-smoke.md
git commit -m "feat: integrate Claude Code lifecycle hooks"
```

### Task 16: Implement reviewer packets and role-based model dispatch

**Files:**
- Create: `runtime/src/review/packet.ts`
- Create: `runtime/src/review/result.ts`
- Create: `runtime/src/review/runner.ts`
- Create: `runtime/src/review/codex-runner.ts`
- Create: `runtime/src/review/claude-runner.ts`
- Create: `runtime/src/review/roles.ts`
- Create: `packages/cli/src/commands/review.ts`
- Test: `tests/review/*.test.ts`

**Step 1: Write failing packet-isolation tests**

Assert packets contain request, criteria, artifact references, and evidence
requirements but omit implementation rationale, hidden reasoning, raw logs, and
secrets.
Assert aggregation requires exactly one result for every requested criterion:
any `FAIL`, missing criterion, duplicate criterion, or unknown criterion ID
produces total `FAIL`. Total `PASS` is possible only when every expected
criterion appears exactly once with `PASS` and non-empty evidence.

**Step 2: Write failing runner fallback tests**

Inject process runners. Missing CLI/login/quota returns `NOT_RUN` plus a
copyable prompt. Running a reviewer requires explicit authorization and
read-only mode. No test may invoke a real model.

**Step 3: Verify red**

Run: `npm run test:compile && node scripts/run-tests.mjs .tmp/test-dist/tests/review`

Expected: FAIL.

**Step 4: Implement structured review and roles**

Require criterion-level results:

```ts
interface ReviewCriterionResult {
  criterionId: string;
  status: "PASS" | "FAIL";
  evidence: string[];
}
```

Role mappings are user-configured and resolved before execution. Display the
actual harness/model/effort or platform limitation; never hardcode transient
model names in the spec. Implement the strict criterion-set aggregation in
`result.ts`; `NOT_RUN` runner outcomes cannot be converted into review PASS.

**Step 5: Run tests**

Run: `npm run typecheck && npm run test:compile && node scripts/run-tests.mjs .tmp/test-dist/tests/review`

Expected: PASS.

**Step 6: Commit**

```bash
git add runtime/src/review packages/cli/src/commands/review.ts tests/review
git commit -m "feat: prepare independent reviewer packets"
```

### Task 17: Write the English normative specification

**Files:**
- Create: `docs/en/spec/README.md`
- Create: `docs/en/spec/loop-engineering.md`
- Create: `docs/en/spec/acceptance-and-evidence.md`
- Create: `docs/en/spec/judgment.md`
- Create: `docs/en/spec/delegation.md`
- Create: `docs/en/spec/review.md`
- Create: `docs/en/spec/troubleshooting.md`
- Create: `docs/en/spec/guardrails.md`
- Create: `docs/en/spec/maintenance.md`
- Create: `docs/en/spec/harness-adapters.md`
- Test: `tests/docs/spec.test.ts`

**Step 1: Write the failing specification-lint test**

Assert every rule has a stable ID, normative keyword, trigger, action, evidence,
positive example, and negative example. Assert links resolve and dated facts
include a revalidation condition.

**Step 2: Create and review one exemplar**

Write `loop-engineering.md` from the approved design. Use IDs such as
`LOOP-START-001`. Run:

`npm run test:compile && node scripts/run-tests.mjs .tmp/test-dist/tests/docs/spec.test.js`

Expected: FAIL only for the not-yet-created modules; the exemplar itself passes.

**Step 3: Write remaining modules in bounded batches**

Use the exemplar structure and progressive-disclosure routing. Keep volatile
harness/model facts in the adapter or research docs. Do not duplicate a full
rule across modules.

**Step 4: Run specification checks**

Run: `npm run test:compile && node scripts/run-tests.mjs .tmp/test-dist/tests/docs/spec.test.js`

Expected: PASS with every module and link present.

**Step 5: Commit**

```bash
git add docs/en/spec tests/docs/spec.test.ts
git commit -m "docs: publish the Loop Engineering specification"
```

### Task 18: Add Traditional Chinese translations, guides, and clean research scaffolding

**Files:**
- Create: `docs/zh-TW/spec/*.md` mirroring every English spec file
- Create: `docs/en/guides/quickstart.md`
- Create: `docs/en/guides/configuration.md`
- Create: `docs/en/guides/security.md`
- Create: `docs/zh-TW/guides/*.md` mirroring every English guide
- Create: `research/README.md`
- Create: `research/schemas/result.schema.json`
- Create: `research/fixtures/README.md`
- Test: `tests/docs/translation.test.ts`
- Test: `tests/research/research.test.ts`

**Step 1: Write failing parity and research-safety tests**

Assert identical rule-ID sets, translation source-version markers, paired guide
paths, no broken relative links, no claimed results without a result file, and
no source-project/internal identifiers.

**Step 2: Verify red**

Run: `npm run test:compile && node scripts/run-tests.mjs .tmp/test-dist/tests/docs/translation.test.js .tmp/test-dist/tests/research/research.test.js`

Expected: FAIL.

**Step 3: Translate one exemplar and review it**

Translate the spec index and loop-engineering module. Preserve normative force
and rule IDs. Mark the English source version explicitly.

**Step 4: Complete bounded translation batches and guides**

Use fresh review between batches. Research contains protocols, schemas, and
sanitized fixtures only; do not fabricate or import historical results.

**Step 5: Run checks**

Run: `npm run typecheck && npm run test:compile && node scripts/run-tests.mjs .tmp/test-dist/tests/docs .tmp/test-dist/tests/research`

Expected: PASS.

**Step 6: Commit**

```bash
git add docs/en/guides docs/zh-TW research tests/docs tests/research
git commit -m "docs: add bilingual guides and research protocols"
```

### Task 19: Add end-to-end lifecycle and npm package verification

**Files:**
- Create: `tests/e2e/project-lifecycle.test.ts`
- Create: `tests/e2e/user-lifecycle.test.ts`
- Create: `tests/e2e/harness-matrix.test.ts`
- Create: `tests/e2e/rollback.test.ts`
- Create: `scripts/package-check.mjs`
- Create: `scripts/scan-release.mjs`
- Create: `packages/cli/src/commands/index.ts`
- Modify: `packages/cli/src/cli.ts`
- Modify: `packages/cli/src/bin.ts`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `SECURITY.md`

**Step 1: Write failing packed-package and lifecycle tests**

Install `npm pack` output into temporary consumer repos. Exercise both scopes,
harnesses, all profiles, managed/unmanaged config, trust, update, doctor,
uninstall, and rollback. Inject temporary home directories; never touch the
developer's real user settings. Execute commands through the binary installed
from the packed tarball—not by importing command modules—and assert every
documented command routes to its real implementation. A placeholder,
unregistered command, or success exit without the expected state transition is
a failing test.

**Step 2: Verify red**

Run: `npm run build && npm pack --dry-run --json`

Then run: `npm run test:compile && node scripts/run-tests.mjs .tmp/test-dist/tests/e2e`

Expected: FAIL until package inspection and CLI lifecycle are wired.

**Step 3: Wire the packaged CLI and implement package inspection**

Create one explicit command registry that binds the parser's complete command
set to the modules implemented in earlier tasks. `cli.ts` dispatches only
through that registry; `bin.ts` supplies production services and propagates the
returned exit code. `package:check` creates a temporary tarball, lists files,
rejects unexpected paths/runtime dependencies/banned patterns, installs it into
a fixture, and runs `agent-ops --version`, `trust status`,
`init --dry-run --scope project --harness both --profile core`, `doctor`,
`task status`, `verify`, and `review` using safe prepared fixtures. It deletes
only its validated temporary directory.

**Step 4: Update public status documentation**

README documents the pre-1.0 CLI accurately, includes no npm install claim
until publication, and links to English/Traditional Chinese docs. SECURITY
lists the pre-1.0 support policy without promising an SLA.

**Step 5: Run the full local gate**

Run: `npm ci && npm run typecheck && npm test && npm run build && npm run package:check`

Expected: all exit 0; test count is non-zero; no network telemetry occurs.

**Step 6: Commit**

```bash
git add tests/e2e scripts packages/cli/src/commands/index.ts packages/cli/src/cli.ts packages/cli/src/bin.ts package.json README.md SECURITY.md
git commit -m "test: verify installed lifecycle and package contents"
```

### Task 20: Add CI, protected release workflow, and final independent verification

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/release.yml`
- Create: `.github/ISSUE_TEMPLATE/bug.yml`
- Create: `.github/ISSUE_TEMPLATE/feature.yml`
- Create: `.github/ISSUE_TEMPLATE/security.yml`
- Create: `.github/pull_request_template.md`
- Modify: `CONTRIBUTING.md`
- Create: `CHANGELOG.md`
- Test: `tests/release/workflow-policy.test.ts`

**Step 1: Write workflow policy tests**

Extend package/repository checks to parse workflow YAML as text and assert:

- CI has a blocking macOS, Ubuntu, and Windows cross-product matrix.
- Every OS runs exact `22.14.0`, latest `22.x`, `24.x`, and a `26.x`
  compatibility entry while Node 26 is Current.
- Every matrix entry runs build/package checks, installs the packed tarball in
  a temporary consumer, and successfully invokes the installed
  `agent-ops --version`,
  `init --dry-run --scope project --harness both --profile core`, and `doctor`
  commands; `doctor` receives a prepared valid fixture rather than relying on
  state from the dry-run.
- PR workflows have no npm publish command and no `id-token: write`.
- Release uses `workflow_dispatch`, a protected environment, `id-token: write`,
  Node 24, npm ≥11.5.1, full verification, and version/tag consistency checks.
- Ordinary push/merge cannot publish.

**Step 2: Verify red**

Run: `npm run test:compile && node scripts/run-tests.mjs .tmp/test-dist/tests/release`

Expected: FAIL until workflows exist.

**Step 3: Implement CI and release workflow**

CI runs `npm ci`, type-check, tests, build, package check, docs, translation,
source scans, and a packed-CLI smoke in every OS/Node matrix entry. Release
remains unusable while `package.json` is private and until the maintainer
configures the GitHub Environment and npm trusted publisher. Do not add an npm
token secret. Removing `private: true` and setting the first public SemVer
require a separate approved release-preparation change.

**Step 4: Add governance templates and changelog**

Security issue template must redirect reporters away from public exploit
details. PR template requires commands/results and explicit breaking,
performance, telemetry, and migration notes.

**Step 5: Run final local verification**

Run:

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run package:check
git diff --check
```

Expected: all PASS with a non-zero test count and a clean diff check.

**Step 6: Commit the release and governance boundary**

```bash
git add .github CONTRIBUTING.md CHANGELOG.md
git diff --cached --check
git commit -m "ci: gate cross-platform agent-ops releases"
```

**Step 7: Run a fresh-context review of the committed branch**

Provide the reviewer only the approved design, the seven delivery acceptance
criteria, `origin/main...HEAD`, and committed disk state. Require criterion-level
PASS/FAIL evidence and active attempts to find source-project identifiers,
secret material, unsafe config writes, false verification, and undocumented
harness assumptions.

Expected: all criteria PASS. Fix every CRITICAL/IMPORTANT finding and rerun.

**Step 8: Re-run the complete branch proof and push**

```bash
git diff --check origin/main...HEAD
npm ci
npm run typecheck
npm test
npm run build
npm run package:check
git push -u origin feat/loop-engineering-toolkit
```

Expected: all commands PASS, the fresh reviewer reports criterion-level PASS,
and the remote branch matches the reviewed commit. If review fixes are needed,
commit them and repeat Steps 7–8 before push.

**Step 9: Create the implementation PR**

Create a PR targeting `main` with the exact validation commands and results.
Do not merge and do not publish npm as part of this task.

## Known external prerequisites

- The current GitHub CLI token in the development environment may need
  re-authentication before PR creation; SSH Git access is available for pushes.
- The maintainer must enable GitHub private vulnerability reporting.
- The maintainer must confirm ownership of the npm scope before first publish.
- A separate approved release-preparation change must remove `private: true`
  and set the first public SemVer.
- npm trusted publishing and the protected GitHub release environment are
  configured only after the implementation PR is reviewed.
- Harness schemas are version-sensitive; official docs and bounded smoke tests
  must be re-read when current CLI behavior differs from checked fixtures.
