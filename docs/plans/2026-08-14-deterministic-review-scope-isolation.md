# Deterministic Review Scope and Fresh Isolation Implementation Plan

**PR:** 2 of 3

**Depends on:**
`2026-08-14-detailed-independent-review-report.md`.

**Goal:** Make every external review operate on one deterministic change
surface and run in a fresh, read-only execution context that cannot inherit the
host conversation, repository instructions, user customization, or session
persistence.

**Architecture:** Resolve and validate review scope before target selection.
Reject policy-bearing changes before any capability probe. Probe required
target flags without spending model tokens. Run an eligible target from a new
OS temporary directory with explicit read-only, repository-access, structured
output, and context-isolation flags. Validate the model's changed-file
declaration against the runtime scope before accepting a verdict.

PR 2 does not create source-bound machine evidence or require verification
evidence before review. PR 3 adds that final gate. It does capture the task's
policy config hash now so future review can distinguish an unchanged policy
from a policy changed during development.

## Decisions

### Deterministic scope

- Without `--base`, review exactly the union of staged, unstaged, and
  non-ignored untracked paths already produced by `collectChangeSurface()`.
- With `--base <git-ref>`, require a clean worktree and review the committed
  `<resolved-base>...HEAD` range.
- Resolve a user ref to a commit OID before constructing the range. Pass every
  Git argument directly with `shell: false`.
- Use NUL-delimited Git output and the existing portable-path validation.
- Before target probing, inspect every changed path component without following
  links: use `lstat`/`realpath` for present worktree entries and Git tree modes
  for committed or deleted entries. A changed symlink, a symlinked parent, or a
  path whose canonical location escapes the root is
  `NOT_RUN / unsafe-review-path`.
- Add `--no-renames`, so a rename is represented by an old deleted path and a
  new path instead of relying on similarity heuristics.
- Empty worktree and empty base range are `NOT_RUN / no-change-surface`; never
  guess the latest commit.
- A dirty worktree in base mode is `NOT_RUN / dirty-worktree`; never mix local
  changes with a committed comparison.
- If the rendered packet would exceed 64 KiB, return
  `NOT_RUN / scope-too-large`. Do not add batching or a configurable limit.
- After a target returns, resolve scope and current config hash again before
  accepting either verdict. Changed paths, base/HEAD identity, or policy hash
  movement produces terminal `NOT_RUN / source-changed-during-review`, no
  fallback, and no evidence write. PR 3 extends this postflight from path/commit
  identity to exact content fingerprints.

### Coverage

- `changedFilesInspected` must contain the authoritative changed paths exactly
  once. Missing, invented, or duplicate changed paths are
  `NOT_RUN / incomplete-scope`.
- `supportingFilesInspected` may contain only safe, unique, repo-relative,
  symlink-free paths whose canonical location remains inside the repository.
- Finding locations must refer to a declared changed or supporting path.
- The prompt permits bounded inspection of direct callers/callees, shared
  types, relevant configuration, and related tests. It does not request a
  whole-repository audit or AST call graph.

Expose the authoritative result additively:

```ts
export type ReviewScope =
  | {
      readonly mode: "worktree";
      readonly changedFiles: readonly string[];
    }
  | {
      readonly mode: "base";
      readonly baseRef: string;
      readonly resolvedBase: string;
      readonly changedFiles: readonly string[];
    };
```

Add optional `scope` to `ReviewInvocation` and `ReviewRunResult` for exported
TypeScript compatibility. The native CLI path resolved by `runReviewCommand()`
always supplies it; `runIndependentReview()` copies it unchanged into the
result. An injected legacy caller may omit it and must render scope as unknown.

### Reviewer policy

Automatic review is ineligible when the Git change surface contains:

- any `AGENTS.md` or `CLAUDE.md`, at any depth;
- any path with a `.codex` or `.claude` segment;
- `.agent-ops/config.json`.

Return `NOT_RUN / reviewer-policy-changed` before probing or spawning a target.
The caller must route that change to a neutral manual or otherwise externally
controlled review; automatic self-review is not an override path.

`.agent-ops/config.json` may be ignored by Git, so every newly created task also
captures `policyConfigHash = calculateConfigHash(effectiveConfig)`. A mismatch
at review time is `reviewer-policy-changed`. A legacy task with no trusted
baseline is readable but returns `reviewer-policy-baseline-missing`.

Ignored `.codex` and `.claude` files do not require a new manifest inventory:
the isolated reviewer must ignore repository rules and user customization.
Only control files that are part of the actual Git delivery surface are blocked.

### Fresh isolated process

- Every model attempt is a new process without resume, continue, conversation,
  or session identifiers.
- The model process runs from a new `mkdtemp()` directory outside the repository.
- Repository access is granted only with a target-native allowed-directory
  boundary plus native read-only/plan mode. The boundary must canonicalize
  paths and reject traversal through symlinks outside the repository.
- Target-native controls must demonstrably suppress session persistence,
  project instructions, user configuration, skills, plugins, hooks, memory,
  and slash commands where applicable. A neutral cwd or a suggestive flag name
  alone is not proof.
- The child environment is rebuilt from a small cross-platform execution
  allowlist plus the selected target's documented authentication inputs. It
  uses the attempt directory as HOME/config/cache state and never forwards
  unrelated credentials, host/session markers, or another target's auth.
- The process layer gains an additive `replaceEnv?: boolean` option. Its default
  remains the current merge behavior for verification; review passes a complete
  allowlisted environment with `replaceEnv: true`. Passing `undefined` values
  is not treated as deletion because the existing Node runner merges
  `process.env`.
- The exact temporary path is removed in `finally` after PASS, FAIL, timeout,
  spawn failure, or parse failure.
- Existing process-tree termination and output truncation remain authoritative;
  no second spawner is introduced.

### Capability policy

Probe `--help` before model execution. The probe is local, zero-token, bounded,
runs from a neutral temporary cwd with the sanitized environment, and runs at
most once per target per review command. Exact flags establish only documented
capabilities; target-specific semantic gaps remain hardcoded as ineligible
until an implementation change and regression test close them.

| Target | Required capabilities |
|---|---|
| Codex | stdin prompt mode, read-only sandbox, canonical allowed-directory boundary, `--skip-git-repo-check`, `--ephemeral`, user-config isolation, project-instruction isolation, `--output-schema` |
| Claude | stdin prompt mode, plan permission mode, canonical `--add-dir` boundary, `--no-session-persistence`, `--safe-mode`, `--disable-slash-commands`, `--json-schema` |
| Agy | stdin prompt mode, sandbox/plan, `--add-dir`, `--disable-slash-commands`, `--json-schema`, plus a native equivalent for persistence and user-customization isolation |

The CLIs inspected on 2026-08-14 leave two strict gaps:

- Codex has `--ignore-rules`, but its help limits that flag to execpolicy
  `.rules`; it does not provide a native guarantee that `AGENTS.md` discovery is
  disabled. Mark Codex ineligible in PR 2 even though its other flags exist.
- Agy does not expose the complete persistence and user-customization
  isolation contract. Mark it ineligible as well.

Keep both as valid configured targets for forward compatibility. Enabling
either later requires an explicit capability-table/code change and tests for
the newly documented native control; do not infer eligibility from a version
number or weaken the requirement. The currently inspected Claude safe mode
explicitly disables `CLAUDE.md`, skills, plugins, hooks, MCP servers, memory,
and other customizations, so Claude is the initial eligible target. Enterprise
policy remains authoritative and is not treated as user/session context.

Capability unavailable, missing executable, spawn failure, and timeout may move
to the next configured target because no verdict was obtained. PASS, FAIL,
malformed output, and semantic protocol violations are terminal.

### Independence metadata

The result reports the target that actually returned the verdict, not the first
configured target. `independence` means target relationship:

- `different-target` when the host and reviewer are both known and differ;
- `same-target` when they are known and match;
- `unknown` when the host cannot be detected reliably.

The configured host target moves to the end of the chain but is not removed. A
same-target review is still a fresh isolated conversation and is allowed when
no other target is available.

## Acceptance criteria

1. Default and base review modes produce deterministic, symlink-free,
   non-empty path sets; base mode rejects every dirty-worktree and invalid-ref
   case before model execution.
2. Policy path changes, policy config mismatch, missing legacy baseline, and an
   oversized packet all return a specific NOT_RUN reason with zero target
   probes or model spawns.
3. The accepted report declares exactly the runtime changed-file set and only
   safe supporting/location paths.
4. Every executed reviewer uses a fresh temporary cwd and all target-native
   read-only, repository-access, structured-output, and isolation capabilities;
   otherwise that target is unavailable.
5. The result and human output identify the actual target, deterministic scope,
   and provable independence level; postflight scope/config movement invalidates
   the verdict, and all temporary directories are cleaned.

## Task 1: Capture the task policy baseline

**Files:**

- Modify: `runtime/src/task/store.ts`
- Modify: `runtime/src/task/service.ts`
- Modify: `packages/cli/src/commands/task.ts`
- Modify: `packages/cli/src/bin.ts`
- Modify: `tests/task/task.test.ts`

### Step 1: Write failing tests

Cover:

- CLI task creation stores the current lowercase SHA-256 config hash;
- task creation through the existing service API remains source-compatible when
  no hash is supplied, but stores a missing baseline;
- a stored task record accepts a valid `policyConfigHash`;
- legacy records without the field remain readable and normalize it to `null`;
- malformed hash values fail task-state validation;
- clone, status, list, archive, attach, and complete preserve the field;
- no task command exposes raw effective configuration.

Run:

```sh
npm run test:compile
node scripts/run-tests.mjs .tmp/test-dist/tests/task/task.test.js
```

Expected before implementation: FAIL.

### Step 2: Implement the additive record field

- Add `policyConfigHash: string | null` to `StoredTaskRecord`, not `AgentTask`.
- Add optional `policyConfigHash` to `CreateTaskInput` so existing programmatic
  callers compile unchanged; the CLI always supplies the effective config hash.
- Add the hash to `TaskCommandOptions`; in `bin.ts`, load the same effective
  project/user config used by verify and review before dispatching task create.
- Follow the existing optional-record migration pattern used by
  `failureFingerprint`: parse old exact-key forms, normalize missing data to
  `null`, and write the new field on the next mutation.
- Do not bump the public task document schema or invent a general migration
  framework for one internal metadata field.

### Step 3: Re-run the focused tests

```sh
npm run typecheck
npm run test:compile
node scripts/run-tests.mjs .tmp/test-dist/tests/task/task.test.js
```

### Step 4: Commit boundary

```text
feat(task): capture review policy baseline
```

## Task 2: Resolve worktree and base review scopes

**Files:**

- Create: `runtime/src/review/scope.ts`
- Modify: `runtime/src/verify/change-surface.ts`
- Modify: `packages/cli/src/args.ts`
- Modify: `packages/cli/src/cli.ts`
- Create: `tests/review/scope.test.ts`
- Modify: `tests/review/cli.test.ts`
- Modify: `tests/cli/args.test.ts`

### Step 1: Write failing tests

Cover:

- staged, unstaged, and untracked paths are normalized, deduplicated, and
  sorted in default mode;
- deleted, renamed, binary, and lockfile paths remain represented;
- changed symlinks, symlinked path components, and canonical paths outside the
  repository return `unsafe-review-path` before any target probe;
- empty default scope returns `no-change-surface`;
- base mode first verifies that staged, unstaged, and untracked are empty;
- clean base mode resolves `<base>^{commit}`, then diffs
  `<resolved-oid>...HEAD`;
- invalid or ambiguous base ref fails closed;
- empty base range returns `no-change-surface`;
- malformed NUL output, invalid UTF-8, absolute paths, traversal, and unsafe
  portable names fail closed;
- a packet beyond 64 KiB returns `scope-too-large`;
- `--base` is accepted once for `review`, with missing, duplicate, and
  unrelated-command cases rejected as CLI argument errors.

Run:

```sh
npm run test:compile
node scripts/run-tests.mjs .tmp/test-dist/tests/review/scope.test.js .tmp/test-dist/tests/review/cli.test.js .tmp/test-dist/tests/cli/args.test.js
```

Expected before implementation: FAIL.

### Step 2: Extend the existing Git surface seam

- Reuse and export the current NUL parser and safe path normalization rather
  than duplicating them under review.
- Add clean-state, commit-resolution, and base-range helpers to
  `change-surface.ts`.
- Use `--full-name --no-renames --no-ext-diff --no-textconv -z` where applicable.
- Define `ReviewScope` in `review/scope.ts` with worktree and base variants,
  resolved base OID, and sorted changed files.
- Validate worktree entries with `lstat`/`realpath` and base/deleted entries with
  Git tree modes, without following symlinks. Reject a symlink at any path
  component and map it to `unsafe-review-path`.
- Convert scope failures into explicit NOT_RUN reasons in the review command;
  do not turn Git errors into an empty scope.
- Extend `ReviewUnavailableReason` with `unsafe-review-path` for symlink and
  canonical-containment failures.
- Calculate the final serialized packet byte size before spawning.

### Step 3: Add the review CLI option

- Add `base?: string` to `ParsedArgs`.
- Permit it only for `review` in this PR. PR 3 expands the same option to
  `verify` so both commands can bind one CI range.
- Update help text without changing existing task/session target rules.

### Step 4: Re-run the focused tests

```sh
npm run typecheck
npm run test:compile
node scripts/run-tests.mjs .tmp/test-dist/tests/review/scope.test.js .tmp/test-dist/tests/review/cli.test.js .tmp/test-dist/tests/cli/args.test.js
```

### Step 5: Commit boundary

```text
feat(review): resolve deterministic review scope
```

## Task 3: Block reviewer-policy changes and enforce file coverage

**Files:**

- Modify: `runtime/src/review/scope.ts`
- Modify: `runtime/src/review/packet.ts`
- Modify: `runtime/src/review/report.ts`
- Modify: `runtime/src/review/runner.ts`
- Modify: `packages/cli/src/commands/review.ts`
- Create: `tests/review/policy.test.ts`
- Create: `tests/review/coverage.test.ts`
- Modify: `tests/review/runner.test.ts`
- Modify: `tests/cli/review-task-context.test.ts`

### Step 1: Write failing tests

Policy cases:

- root and nested `AGENTS.md`;
- root and nested `CLAUDE.md`;
- `.codex` and `.claude` path segments;
- `.agent-ops/config.json`;
- similarly named normal source paths remain eligible;
- current config hash differs from the task baseline;
- legacy task has no baseline;
- every rejection performs zero capability probes and zero model spawns.

Coverage cases:

- exact changed set in any order passes;
- missing, invented, or duplicate changed path returns `incomplete-scope`;
- supporting paths must be safe, unique, and repository-relative;
- supporting paths with a symlink component or canonical escape return
  `unsafe-review-path`;
- finding locations must occur in changed or supporting declarations;
- coverage comparison happens before output redaction;
- changed and supporting files render in separate sections.

Run:

```sh
npm run test:compile
node scripts/run-tests.mjs .tmp/test-dist/tests/review/policy.test.js .tmp/test-dist/tests/review/coverage.test.js .tmp/test-dist/tests/review/runner.test.js .tmp/test-dist/tests/cli/review-task-context.test.js
```

Expected before implementation: FAIL.

### Step 2: Implement the policy predicate in `scope.ts`

- Match policy filenames and path segments after portable normalization; keep
  the normalized original path for diagnostics.
- Compare `policyConfigHash` with `calculateConfigHash(effectiveConfig)`.
- Return `reviewer-policy-baseline-missing` for `null`, and
  `reviewer-policy-changed` for a mismatch or matching policy path.
- Do not enumerate all ignored files or add manifest state. Native isolation is
  the boundary for ignored `.codex`/`.claude` content.
- Do not create a separate policy service for this one pure path predicate.

### Step 3: Add scope-aware semantic validation

- Extend `validateReviewReport()` with expected changed files.
- Require exact set equality and reject duplicates before redaction.
- Reuse existing portable-path validation, then perform component-wise
  `lstat`/`realpath` containment checks for supporting paths and locations.
- Treat a reported symlink or canonical escape as `unsafe-review-path`, not as
  a generic parse error. The eligible CLI's native allowed-directory boundary
  is still the enforcement that prevents dereference while the model runs.
- Change a structurally valid but incomplete declaration from generic
  `unparseable-output` to `NOT_RUN / incomplete-scope`, with bounded path-level
  diagnostics.

### Step 4: Re-run the focused tests

```sh
npm run typecheck
npm run test:compile
node scripts/run-tests.mjs .tmp/test-dist/tests/review/policy.test.js .tmp/test-dist/tests/review/coverage.test.js .tmp/test-dist/tests/review/runner.test.js .tmp/test-dist/tests/cli/review-task-context.test.js
```

### Step 5: Commit boundary

```text
feat(review): reject policy changes and incomplete coverage
```

## Task 4: Probe native reviewer capabilities

**Files:**

- Modify: `runtime/src/review/probe.ts`
- Modify: `runtime/src/review/invocation.ts`
- Modify: `runtime/src/review/execute.ts`
- Modify: `runtime/src/install/doctor.ts`
- Modify: `tests/review/invocation.test.ts`
- Create: `tests/review/capability.test.ts`
- Modify: `tests/install/doctor-review-targets.test.ts`
- Add: bounded `--help` fixtures for Codex, Claude, and Agy

### Step 1: Write failing tests

Assert:

- capability checks use only local `--help`, never a model prompt;
- help probes run from a neutral temporary cwd with the same sanitized
  environment used for attempts and clean that directory on every outcome;
- required flags are checked by exact token, not by CLI version guessing;
- truncated, non-zero, or malformed help output is unavailable;
- each configured target is probed at most once per review command;
- unsupported target advances to the next target;
- all unsupported targets produce NOT_RUN/capability-unavailable;
- the current Codex fixture remains unavailable because no flag suppresses
  `AGENTS.md`; `--ignore-rules` alone is insufficient;
- the current Agy fixture is unavailable and never reaches model execution;
- the current Claude fixture is eligible only when every safe-mode,
  allowed-directory, persistence, read-only, and schema flag is present;
- doctor reports installed-but-ineligible separately from missing executable and
  login state, with upgrade guidance;
- malformed model output and a real FAIL remain terminal.

Run:

```sh
npm run test:compile
node scripts/run-tests.mjs .tmp/test-dist/tests/review/capability.test.js .tmp/test-dist/tests/review/invocation.test.js .tmp/test-dist/tests/install/doctor-review-targets.test.js
```

Expected before implementation: FAIL.

### Step 2: Implement a fixed capability table

- Keep required flags beside each target invocation definition so probe and
  spawn cannot drift.
- Represent target-specific semantic requirements explicitly. Set Codex's
  project-instruction-isolation capability to false for the currently
  supported CLI; do not reinterpret `--ignore-rules` as `AGENTS.md` isolation.
- Classify unsupported required flags as `capability-unavailable`.
- Preserve the current deep authentication probe as a separate, explicitly
  authorized doctor operation.
- Do not parse provider version strings or add automatic upgrades.

### Step 3: Re-run the focused tests

```sh
npm run typecheck
npm run test:compile
node scripts/run-tests.mjs .tmp/test-dist/tests/review/capability.test.js .tmp/test-dist/tests/review/invocation.test.js .tmp/test-dist/tests/install/doctor-review-targets.test.js
```

### Step 4: Commit boundary

```text
feat(review): require native isolation capabilities
```

## Task 5: Run reviewers in clean temporary contexts

**Files:**

- Modify: `runtime/src/review/invocation.ts`
- Modify: `runtime/src/review/execute.ts`
- Modify: `runtime/src/review/roles.ts`
- Modify: `runtime/src/verify/spawn.ts`
- Create: `tests/review/isolation.test.ts`
- Modify: `tests/review/chain.test.ts`
- Modify: `tests/verify/spawn.test.ts`

### Step 1: Write failing tests

Assert:

- each actual model attempt receives a unique temporary cwd outside repo root;
- repository root is passed only through `--add-dir`;
- Claude receives every required isolation, allowed-directory, structured
  output, and read-only flag;
- current Codex and Agy capability failures create no model-attempt directory
  and invoke no model;
- no target receives resume, continue, session, or project-cwd arguments;
- PATH/platform execution keys and only the selected target's documented auth
  variables remain; unrelated credentials, cross-target auth, and
  host/session markers are absent, while HOME/config/cache point at the exact
  attempt directory;
- the default process-runner path still merges environment overrides, while
  `replaceEnv: true` does not reintroduce removed inherited keys;
- PASS, FAIL, malformed output, timeout, and spawn failure all remove the exact
  temporary directory;
- help-probe success, failure, and truncation also remove their exact neutral
  temporary directory;
- timeout/process-tree teardown finishes before directory removal;
- commands remain `shell: false` on POSIX and Windows;
- a fallback creates a new directory rather than reusing the failed attempt's
  directory;
- the actual target is returned after fallback;
- target independence is `different-target`, `same-target`, or `unknown` only
  when justified by host detection.

Run:

```sh
npm run test:compile
node scripts/run-tests.mjs .tmp/test-dist/tests/review/isolation.test.js .tmp/test-dist/tests/review/chain.test.js .tmp/test-dist/tests/verify/spawn.test.js
```

Expected before implementation: FAIL.

### Step 2: Add an additive environment replacement mode

- Add `replaceEnv?: boolean` to `RunVerificationCommandOptions` and the internal
  process request.
- In `NodeVerificationProcessRunner`, retain
  `{ ...process.env, ...request.env }` by default. When replacement is true, use
  the supplied environment object directly.
- Review constructs a fixed platform allowlist and a fixed per-target auth
  allowlist, points home/config/cache variables at the attempt directory, and
  uses replacement mode. Unknown environment keys are omitted rather than
  guessed safe.
- Existing verification and hook callers omit the option and retain byte-for-
  byte environment behavior.

### Step 3: Implement the lifecycle around the existing runner

- Build the child env from documented platform essentials and per-target auth
  names only. Do not forward arbitrary `process.env`; if an installation needs
  an unrecognized auth input, report `login-required` and update the reviewed
  allowlist instead of leaking the parent environment.
- Run each `--help` probe under that same environment from its own neutral
  temporary directory, without granting repository access.
- Create the temporary cwd immediately before one eligible target attempt.
- Build the target invocation with the repo root as an added read-only
  directory, while keeping the prompt free of diff contents and transcripts.
- Reuse `runVerificationCommand()` for timeout, output cap, and process-tree
  termination.
- Remove only the exact `mkdtemp` result in `finally`; never use repository root,
  `$HOME`, or an unresolved environment variable as a cleanup target.
- Populate result metadata from the actual attempt.

### Step 4: Re-run the focused tests

```sh
npm run typecheck
npm run test:compile
node scripts/run-tests.mjs .tmp/test-dist/tests/review/isolation.test.js .tmp/test-dist/tests/review/chain.test.js .tmp/test-dist/tests/verify/spawn.test.js
```

### Step 5: Commit boundary

```text
feat(review): isolate fresh reviewer processes
```

## Task 6: Wire scope, policy, capabilities, and output

**Files:**

- Modify: `packages/cli/src/bin.ts`
- Modify: `packages/cli/src/commands/review.ts`
- Modify: `runtime/src/review/runner.ts`
- Modify: `tests/review/command.test.ts`
- Modify: `tests/cli/review-task-context.test.ts`
- Modify: `tests/e2e/project-lifecycle.test.ts`

### Step 1: Write failing integration tests

Cover the ordering explicitly:

```text
authorization
  -> task and policy baseline
  -> deterministic scope
  -> policy path check
  -> capability probe
  -> isolated model attempt
  -> detailed report/coverage validation
```

Assert zero probes and zero spawns for authorization, context, baseline, scope,
or policy failures. Assert one verdict-producing model at most. Assert that a
capability-unavailable first target can advance, while FAIL and malformed output
cannot.

Also simulate an external path/base/config change while the reviewer runs and
assert the returned verdict becomes `source-changed-during-review`, with no
fallback and no task evidence write.

Run:

```sh
npm run test:compile
node scripts/run-tests.mjs .tmp/test-dist/tests/review/command.test.js .tmp/test-dist/tests/cli/review-task-context.test.js .tmp/test-dist/tests/e2e/project-lifecycle.test.js
```

Expected before implementation: FAIL.

### Step 2: Wire the existing seams

- Extract the existing inline Git runner from `packages/cli/src/bin.ts` into one
  local helper used by verify and review; do not introduce a new Git service.
- Pass repo root, Git runner, effective config hash, task policy baseline,
  optional base, and capability probe into the review command/executor.
- Pass an injected `loadCurrentConfigHash()` callback from `bin.ts`; the native
  path reloads effective config for postflight while tests provide a pure fake.
- Add authoritative scope and independence metadata to JSON and human output.
- Resolve scope in `runReviewCommand()`, pass it through `ReviewInvocation`, and
  have `runIndependentReview()` copy it to `ReviewRunResult`. The executor must
  not independently calculate a second, potentially different scope.
- After executor return, recollect scope and config hash in `runReviewCommand()`
  before accepting PASS/FAIL. Do not retry a reviewer after postflight movement.
- When postflight moves, discard the stale report/results from the public
  verdict envelope and return only the safe NOT_RUN reason and current scope
  metadata, so consumers cannot mistake an old-snapshot finding for a current
  verdict.
- Keep the report transient and retain PASS-only evidence write-back from PR 1.

### Step 3: Re-run the integration tests

```sh
npm run typecheck
npm run test:compile
node scripts/run-tests.mjs .tmp/test-dist/tests/review/command.test.js .tmp/test-dist/tests/cli/review-task-context.test.js .tmp/test-dist/tests/e2e/project-lifecycle.test.js
```

### Step 4: Commit boundary

```text
feat(review): wire deterministic isolated review
```

## Task 7: Document deterministic and isolated review

**Files:**

- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/en/spec/review.md`
- Modify: `docs/zh-TW/spec/review.md`
- Modify: `docs/en/guides/configuration.md`
- Modify: `docs/zh-TW/guides/configuration.md`
- Modify: `tests/docs/spec.test.ts`
- Modify: `tests/docs/translation.test.ts`

### Step 1: Write failing documentation tests

Require both language variants to document default worktree scope, review-only
`--base`, clean-worktree rule, no-change behavior, policy fail-closed behavior,
task config baseline, exact coverage, neutral cwd, native capability policy,
symlink fail-closed behavior, Codex and Agy's current ineligibility, fallback
limits, and independence metadata.

Run:

```sh
npm run test:compile
node scripts/run-tests.mjs .tmp/test-dist/tests/docs/spec.test.js .tmp/test-dist/tests/docs/translation.test.js
```

### Step 2: Update documentation

Document PR 2 behavior as shipped. State that verification freshness and the
automatic verify-to-review handoff still require PR 3.

### Step 3: Re-run documentation tests

```sh
npm run test:compile
node scripts/run-tests.mjs .tmp/test-dist/tests/docs/spec.test.js .tmp/test-dist/tests/docs/translation.test.js
```

### Step 4: Commit boundary

```text
docs(review): document deterministic isolated review
```

## Final PR verification

Run:

```sh
npm run typecheck
npm test
npm run build
npm run package:check
git diff --check
```

Use injected process runners for automated tests. After the suite passes, run
one explicitly authorized manual smoke per eligible installed target to confirm
that the native controls provide repository read access from a neutral cwd,
reject an outside-root sentinel reached through a symlink, and do not load
project or user customization. Under the 2026-08-14 capability table this means
Claude only; do not run Codex or Agy until an implementation change supplies and
tests their missing strict capability.
