# Verification Freshness and Automatic Review Handoff Implementation Plan

**PR:** 3 of 3

**Depends on:**
`2026-08-14-detailed-independent-review-report.md` and
`2026-08-14-deterministic-review-scope-isolation.md`.

**Goal:** Bind machine evidence to the exact source under review, reject stale
or failed required checks before spending reviewer tokens, and make the managed
completion workflow invoke one detailed independent review after verification
PASS.

**Architecture:** Keep `verify` as the only machine-check runner and `review` as
the semantic reviewer. Verification writes immutable evidence v2 files and, on
overall PASS, attaches their references to the active task. Review preflight
loads those references, recomputes the current source fingerprint, checks the
current config and required verifier results, and only then calls the isolated
executor from PR 2. The main agent or CI performs two explicit commands;
`verify` never hides a model invocation.

```text
agent-ops verify [--base <ref>]
  -> resolve source scope and fingerprint A
  -> run configured verifiers
  -> recompute fingerprint B
  -> A == B and every required result PASS
  -> attach all results from this passing run to the active task

completion checkpoint
  -> agent-ops review [--base <same-ref>] --yes
  -> policy/scope preflight from PR 2
  -> verification evidence preflight from this PR
  -> one fresh isolated semantic reviewer
  -> show complete report; write review evidence only on PASS
```

## Decisions

### Required and optional machine checks

- Only commands whose current configuration has `required: true` affect overall
  verification status and reviewer eligibility.
- When no selected command is required, machine status is PASS. Optional
  failures and UNKNOWN results remain visible for semantic review.
- A mapped optional command still runs. A fallback with no required commands may
  select no command instead of throwing; the reviewer owns the semantic check.
- On overall verification PASS, attach every result from that run, including
  failed or UNKNOWN optional results, so the reviewer and human can see them.
- On overall FAIL or UNKNOWN, attach none of that run's evidence references.
- A required result must be explicit PASS. Exit code zero alone is insufficient
  for test-count or unsupported file-evidence contracts.

### Evidence freshness

- Evidence schema advances independently from v1 to v2.
- Evidence v2 adds `status`, `failureClass`, and `sourceFingerprint`; all current
  fields stay in place.
- `status` and `failureClass` come directly from the final
  `ConfiguredCommandExecution` classification. They are never reconstructed
  from `exitCode`, because test-count and file-evidence checks can turn an exit
  code zero into UNKNOWN or FAIL.
- New writes are v2-only. Evidence v1 remains safely readable for diagnostics
  but is always `stale-verification` for review.
- `configHash` must equal the current effective config hash.
- `sourceFingerprint` must equal a fresh calculation for the same scope mode.
- Evidence task, criterion, and command IDs must match the selected task and
  current config.
- The task's existing `failureFingerprint` must be null. A completed required
  verification failure therefore blocks reuse of an older same-source PASS.
- Do not add a task evidence-clearing API or latest-run history object. Existing
  failure-fingerprint state plus source/config matching closes the identified
  stale-PASS path with less persistence.

### Source fingerprint

Use Node's standard `crypto.createHash("sha256")` over `JSON.stringify()` of a
known, sorted object shape. Do not add a canonical-JSON dependency.

Worktree snapshot:

```json
{
  "domain": "agent-ops-source-v1",
  "mode": "worktree",
  "head": "<resolved HEAD OID>",
  "base": null,
  "paths": [
    {
      "path": "src/example.ts",
      "kind": "file",
      "executable": false,
      "hash": "<file SHA-256>"
    },
    {
      "path": "src/removed.ts",
      "kind": "deleted"
    }
  ]
}
```

- Hash only the authoritative changed paths, not the repository.
- Include current HEAD, normalized path, entry kind, regular-file bytes, and
  executable state.
- Hash a symlink's target text without following it outside the repository.
- Represent deletions explicitly.
- Reject special files and unstable reads rather than guessing.
- Classify an unsupported or unstable source entry as
  `source-snapshot-unavailable`; verification cannot PASS or attach evidence.
- Sort paths before serialization so input order does not change the digest.

Clean base snapshot:

```json
{
  "domain": "agent-ops-source-v1",
  "mode": "base",
  "head": "<resolved HEAD OID>",
  "base": "<resolved base OID>",
  "paths": ["src/example.ts"]
}
```

The base and HEAD commits are immutable, so their OIDs plus the deterministic
range paths are sufficient; do not reread every Git blob.

Compute the snapshot immediately before commands and again after all commands.
If they differ, verification is UNKNOWN with
`source-changed-during-verification`, attaches no references, and records the
existing failure signal.

Each snapshot call must recollect the authoritative scope; it must not reuse the
first call's path array. This catches a verifier that creates a new untracked
file, deletes a path, changes HEAD, or dirties a base-mode checkout. A changed
path set is a changed snapshot even when every originally known file is
unchanged.

### Explicit handoff

- `verify` never calls an LLM.
- The generated managed completion rule instructs the host agent to call
  `review --yes` exactly once after verify PASS when external review is enabled.
- Interactive use requires explicit token-spend authorization when not already
  provided. CI always supplies `--yes`.
- The main agent must surface the complete renderer output, not summarize it to
  a verdict line.
- Review PASS with non-blocking findings still passes and the findings remain
  visible.
- Review FAIL or NOT_RUN stops completion and writes no review evidence.
- Recollect scope and source fingerprint after the reviewer exits and before
  accepting PASS or FAIL. If another process changed the source during review,
  return terminal `NOT_RUN / source-changed-during-review` and write no review
  evidence; never retry the model against the moving target automatically.
- `task complete` remains an explicit task mutation. This PR does not add a
  second completion-state store or make `verify` complete a task.

## Evidence v2 contract

```ts
export interface VerificationEvidence {
  readonly schemaVersion: 2;
  readonly taskId: string;
  readonly criterionId: string;
  readonly commandId: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly scope: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly status: "PASS" | "FAIL" | "UNKNOWN";
  readonly failureClass: string;
  readonly exitCode: number | null;
  readonly testCount: number | null;
  readonly toolVersions: Readonly<Record<string, string>>;
  readonly configHash: string;
  readonly sourceFingerprint: string;
}
```

`scope` retains its current project/user installation meaning. Do not repurpose
it for worktree/base source mode; the source fingerprint binds that mode.

## Review preflight

For the selected criteria, derive criterion/command pairs whose current command
is required. Each pair needs at least one attached evidence v2 record that:

- is inside `.agent-ops/tasks/evidence/` and passes private-file safety checks;
- matches task ID, criterion ID, and command ID;
- has status PASS, a compatible exit code, and the current test-count contract;
- matches current config hash and source fingerprint.

Optional evidence is never required. When present, load and pass a bounded
summary of its status and evidence reference to the reviewer. Ignore
`review:<target>:` references while locating machine evidence.

Preflight also requires `failureFingerprint === null`. It returns one of:

- `verification-not-passed`
- `missing-verification-evidence`
- `unreadable-verification-evidence`
- `stale-verification`

Scope, policy, capability, and coverage reasons remain owned by PR 2. Every
preflight failure returns NOT_RUN before a model process is created.

On success, preflight produces this bounded runtime-owned summary:

```ts
export interface ReviewVerificationCommandSummary {
  readonly criterionId: string;
  readonly commandId: string;
  readonly required: boolean;
  readonly status: "PASS" | "FAIL" | "UNKNOWN";
  readonly evidenceReference?: string;
}

export interface ReviewVerificationSummary {
  readonly status: "PASS";
  readonly sourceFingerprint: string;
  readonly commands: readonly ReviewVerificationCommandSummary[];
}
```

Add optional `verification` to `ReviewInvocation` and `ReviewRunResult` for
exported TypeScript compatibility. The native CLI path always sets it after
successful preflight; `runIndependentReview()` copies it into the result and
the packet renderer derives its machine-check context from the same object.
Injected legacy callers may omit it and must render verification as unknown.

## Acceptance criteria

1. Every new evidence file is strict schema v2 and is bound to the exact
   worktree or base source snapshot; v1 remains readable but cannot authorize
   review.
2. Overall verification status depends only on required commands. Optional
   outcomes are attached and displayed after an overall PASS but never gate
   reviewer spawn.
3. Verification detects source mutation during the run, attaches no references
   on FAIL/UNKNOWN, and never mutates a completed task record.
4. Review starts only when every current required criterion/command pair has
   readable matching PASS evidence and the task has no current failure
   fingerprint; it recollects source after model execution and rejects an
   otherwise valid verdict if the scope or fingerprint moved during review.
5. Managed development and CI flows execute explicit verify then one review,
   surface the full result, and stop completion on review FAIL or NOT_RUN.

## Task 1: Add evidence v2 and safe stored-evidence reads

**Files:**

- Modify: `runtime/src/contracts.ts`
- Modify: `runtime/src/verify/evidence.ts`
- Modify: `runtime/src/schema/validate.ts`
- Modify: `schemas/evidence.schema.json`
- Modify: `tests/verify/evidence.test.ts`
- Modify: `tests/schema/validate.test.ts`
- Modify: `tests/fixtures/schema/valid-evidence.json`
- Create: `tests/fixtures/schema/legacy-evidence-v1.json`

### Step 1: Write failing tests

Cover:

- current evidence requires schema version 2, status, failure class, and a
  lowercase 64-character source fingerprint;
- missing, invalid, extra, and contradictory fields fail validation;
- a PASS record cannot carry a failing process classification;
- a FAIL/UNKNOWN record retains enough classification for diagnostics;
- `FileEvidenceStore.save()` accepts only current v2;
- `FileEvidenceStore.load()` accepts only a bounded safe relative reference
  beneath `.agent-ops/tasks/evidence/`;
- traversal, absolute, NUL-containing, symlink, non-regular, oversized, missing,
  and malformed evidence files fail closed;
- the stored reader identifies valid v1 as legacy without rewriting it;
- schema fixtures and package contents include the updated evidence schema.

Run:

```sh
npm run test:compile
node scripts/run-tests.mjs .tmp/test-dist/tests/verify/evidence.test.js .tmp/test-dist/tests/schema/validate.test.js
```

Expected before implementation: FAIL.

### Step 2: Implement the contract and reader

- Set `EVIDENCE_SCHEMA_VERSION = 2` and add the three required fields.
- Add required `status`, `failureClass`, and `sourceFingerprint` inputs to
  `BuildVerificationEvidenceInput`; callers must supply the post-classification
  `ConfiguredCommandExecution` values rather than raw spawn conclusions.
- Keep `validateEvidence()` strict for current writes.
- Add `validateStoredEvidence()` returning a discriminated current/legacy
  result; do not weaken the current schema validator.
- Implement `load(reference)` using existing contained-path and private-file
  helpers. Reject symlinks and non-regular files before JSON parsing.
- Do not add update, delete, retention, or migration methods.

### Step 3: Re-run the focused tests

```sh
npm run typecheck
npm run test:compile
node scripts/run-tests.mjs .tmp/test-dist/tests/verify/evidence.test.js .tmp/test-dist/tests/schema/validate.test.js
```

### Step 4: Commit boundary

```text
feat(verify): define source-bound evidence v2
```

## Task 2: Calculate stable worktree and base fingerprints

**Files:**

- Create: `runtime/src/verify/source-fingerprint.ts`
- Modify: `runtime/src/verify/change-surface.ts`
- Create: `tests/verify/source-fingerprint.test.ts`
- Modify: `tests/verify/change-surface.test.ts`

### Step 1: Write failing tests

Cover:

- identical snapshots hash identically regardless of input path order;
- file edit, addition, deletion, executable-bit change, symlink target, HEAD,
  base, and mode each change the digest;
- worktree and base snapshots never collide for the same visible path list;
- rename is represented by deleted old path plus new file path;
- absolute repository location is not part of the digest;
- path escape, special file, symlink traversal, unstable file identity, invalid
  Git output, and missing HEAD fail closed;
- a second capture discovers verifier-created, removed, or renamed paths instead
  of hashing only the original path set;
- hashing reads only changed worktree files;
- source contents never appear in the snapshot's public diagnostic form.

Run:

```sh
npm run test:compile
node scripts/run-tests.mjs .tmp/test-dist/tests/verify/source-fingerprint.test.js .tmp/test-dist/tests/verify/change-surface.test.js
```

Expected before implementation: FAIL.

### Step 2: Implement with Node and existing Git helpers

- Construct objects in a fixed key order, sort normalized paths, serialize with
  `JSON.stringify()`, and hash with `createHash("sha256")`.
- For worktree regular files, compare file identity before and after the read;
  use no-follow semantics where supported and fail closed on instability.
- Stream regular-file bytes through the hash instead of buffering whole changed
  files in memory.
- Read symlink target text rather than following it.
- Reuse the base ref, clean-worktree, NUL parsing, and path validation helpers
  added by PR 2.
- Expose a capture function that accepts root, Git runner, and source mode/base,
  and recollects scope internally on every call. Do not expose an API that lets
  `VerificationService` pass a stale path array for the after-snapshot.
- Return the digest plus safe source metadata needed by review output; never
  return file bytes.

### Step 3: Re-run the focused tests

```sh
npm run typecheck
npm run test:compile
node scripts/run-tests.mjs .tmp/test-dist/tests/verify/source-fingerprint.test.js .tmp/test-dist/tests/verify/change-surface.test.js
```

### Step 4: Commit boundary

```text
feat(verify): fingerprint reviewable source snapshots
```

## Task 3: Support the same base scope in verification

**Files:**

- Modify: `packages/cli/src/args.ts`
- Modify: `packages/cli/src/cli.ts`
- Modify: `packages/cli/src/commands/verify.ts`
- Modify: `packages/cli/src/bin.ts`
- Modify: `runtime/src/verify/service.ts`
- Modify: `tests/cli/args.test.ts`
- Modify: `tests/verify/command.test.ts`
- Modify: `tests/verify/service.test.ts`

### Step 1: Write failing tests

Cover:

- `--base` is now accepted by both verify and review, and still rejected by all
  unrelated commands;
- verify base mode uses the same clean-worktree and resolved OID semantics as
  review;
- dirty base mode, invalid ref, and empty range fail before executing a verifier;
- default verify mode remains staged + unstaged + untracked;
- explicit base never silently falls back to worktree;
- verify and review calculate identical source metadata for the same mode/ref.

Run:

```sh
npm run test:compile
node scripts/run-tests.mjs .tmp/test-dist/tests/cli/args.test.js .tmp/test-dist/tests/verify/command.test.js .tmp/test-dist/tests/verify/service.test.js
```

Expected before implementation: FAIL.

### Step 2: Thread one additive option

- Expand the PR 2 argument legality check from review-only to verify-or-review.
- Add optional base to `VerifyCommandOptions` and
  `VerificationServiceOptions`.
- Reuse the PR 2 low-level Git scope helpers; do not introduce another Git
  runner or a different base-range definition.
- Return source mode and resolved base in the public verification report.

### Step 3: Re-run the focused tests

```sh
npm run typecheck
npm run test:compile
node scripts/run-tests.mjs .tmp/test-dist/tests/cli/args.test.js .tmp/test-dist/tests/verify/command.test.js .tmp/test-dist/tests/verify/service.test.js
```

### Step 4: Commit boundary

```text
feat(verify): share explicit base review scope
```

## Task 4: Produce fresh evidence and attach complete optional context

**Files:**

- Modify: `runtime/src/verify/command-executor.ts`
- Modify: `runtime/src/verify/scope.ts`
- Modify: `runtime/src/verify/service.ts`
- Modify: `runtime/src/task/service.ts`
- Modify: `packages/cli/src/commands/verify.ts`
- Modify: `tests/verify/command-executor.test.ts`
- Modify: `tests/verify/scope.test.ts`
- Modify: `tests/verify/service.test.ts`
- Create: `tests/verify/handoff.test.ts`

### Step 1: Write failing tests

Cover:

- required PASS + optional FAIL yields overall PASS;
- required PASS + optional UNKNOWN yields overall PASS;
- no required commands yields PASS, including fallback scope;
- required FAIL/UNKNOWN still gates normally;
- every evidence file contains its actual status, failure class, and one shared
  pre-run source fingerprint;
- file-evidence-unsupported, zero-test, and below-minimum classifications stay
  non-PASS even when the spawned process exited zero;
- unchanged before/after fingerprint allows normal aggregation;
- source change during execution returns UNKNOWN and attaches nothing;
- a verifier that creates an untracked path, deletes a path, changes HEAD, or
  dirties base mode is detected by the post-run scope recollection;
- overall PASS on an active task attaches all current-run refs, including
  non-PASS optional evidence;
- overall FAIL/UNKNOWN attaches no current-run refs;
- complete task verification may emit immutable command evidence as it does
  today, but neither attaches refs nor mutates the completed task's failure
  state;
- a required failure sets `failureFingerprint`; a subsequent full PASS clears
  it;
- evidence references group deterministically by criterion and do not duplicate
  on one handoff.

Run:

```sh
npm run test:compile
node scripts/run-tests.mjs .tmp/test-dist/tests/verify/command-executor.test.js .tmp/test-dist/tests/verify/scope.test.js .tmp/test-dist/tests/verify/service.test.js .tmp/test-dist/tests/verify/handoff.test.js
```

Expected before implementation: FAIL.

### Step 2: Make required-only aggregation literal

- Change `aggregateVerificationStatus()` so an empty required-result set is
  PASS instead of falling back to optional results.
- Let unknown/ambiguous scope with zero configured required commands produce an
  empty fallback selection rather than `VERIFICATION_SCOPE_EMPTY`.
- Do not hide optional results from the public report.

### Step 3: Bind and attach the run

- Resolve one source snapshot before executing commands and pass its digest and
  the exact `ConfiguredCommandExecution.status`/`failureClass` to every
  `buildVerificationEvidence()` call. The evidence builder must not infer
  semantic status from the exit code.
- Persist every command's v2 evidence for diagnostics, as today.
- Recompute the source snapshot, including a new change-surface collection,
  after the command loop and before task mutation.
- On unchanged overall PASS for an active task, group and attach all evidence
  references produced by this run. This includes non-PASS optional evidence.
- On source change, required FAIL, or required UNKNOWN, attach none and use the
  existing failure-fingerprint mechanism.
- Do not clear old evidence. Review preflight rejects it when the failure
  fingerprint is non-null or source/config fingerprints do not match.
- Do not modify completed task records.

### Step 4: Re-run the focused tests

```sh
npm run typecheck
npm run test:compile
node scripts/run-tests.mjs .tmp/test-dist/tests/verify/command-executor.test.js .tmp/test-dist/tests/verify/scope.test.js .tmp/test-dist/tests/verify/service.test.js .tmp/test-dist/tests/verify/handoff.test.js
```

### Step 5: Commit boundary

```text
feat(verify): attach fresh verification context
```

## Task 5: Gate reviewer spawn with current required evidence

**Files:**

- Create: `runtime/src/review/preflight.ts`
- Modify: `runtime/src/review/packet.ts`
- Modify: `runtime/src/review/runner.ts`
- Modify: `packages/cli/src/commands/review.ts`
- Modify: `packages/cli/src/bin.ts`
- Create: `tests/review/preflight.test.ts`
- Modify: `tests/review/packet.test.ts`
- Modify: `tests/review/command.test.ts`
- Modify: `tests/cli/review-task-context.test.ts`

### Step 1: Write failing tests

Allow cases:

- every selected criterion/required-command pair has current PASS v2 evidence;
- optional evidence is missing;
- optional evidence is present and failed or UNKNOWN;
- selected criteria have no required verifier, leaving semantic judgment to the
  reviewer.

Reject cases before model spawn:

- task failure fingerprint is non-null;
- required evidence is missing or not PASS;
- evidence reference is outside the allowed directory, missing, unreadable,
  symlinked, oversized, malformed, or legacy v1;
- task, criterion, or command ID mismatch;
- config hash or source fingerprint mismatch;
- exit code contradicts PASS;
- current test-count minimum is not met;
- file-evidence result is not an explicit supported PASS;
- PR 2 scope or policy preflight has already failed.

Also assert:

- reviewer does not rerun configured machine commands;
- source or scope changed by another process during reviewer execution produces
  `source-changed-during-review`, no retry, and no review evidence;
- prompt receives bounded required and optional verification summaries;
- raw command stdout/stderr and evidence JSON do not enter the prompt;
- preflight failure invokes zero capability/model processes;
- review PASS alone writes review evidence; FAIL and NOT_RUN write nothing.

Run:

```sh
npm run test:compile
node scripts/run-tests.mjs .tmp/test-dist/tests/review/preflight.test.js .tmp/test-dist/tests/review/packet.test.js .tmp/test-dist/tests/review/command.test.js .tmp/test-dist/tests/cli/review-task-context.test.js
```

Expected before implementation: FAIL.

### Step 2: Implement one preflight seam

`preflightReview()` receives task record, selected criteria, current config,
evidence store, authoritative scope/source snapshot, and returns either a safe
verification summary or a typed NOT_RUN reason.

- Filter criterion verifier IDs through current commands with `required: true`.
- Ignore `review:` references when locating machine evidence.
- Load references with the safe evidence-store reader.
- Require one current valid PASS per required criterion/command pair.
- Select deterministically when multiple old references exist; accept a matching
  current record, not simply the last string. For each criterion/command pair,
  choose the matching record with the greatest validated `finishedAt`, using the
  reference string only as a deterministic tie-breaker. Apply the same rule to
  optional context so a newer optional failure is not hidden by an older PASS.
- Include optional records only as non-gating report context.
- Check `failureFingerprint === null` before accepting old references.
- Run preflight after authorization, task, policy, and scope checks but before
  target capability probing.
- Pass the successful `ReviewVerificationSummary` through
  `ReviewInvocation.verification`; do not make the executor reread evidence or
  synthesize a second summary.
- After the executor returns either verdict, recapture the current source using
  the same scope mode and compare it to the preflight fingerprint before
  returning or writing evidence. Convert any mismatch to terminal NOT_RUN.
- Drop the stale `report` and legacy `results` projection from that converted
  NOT_RUN envelope; retain only safe reason/scope metadata.

Extend `ReviewUnavailableReason` additively with the four evidence reasons.
Expose only safe reference/status summaries in the prompt and rendered output.

### Step 3: Re-run the focused tests

```sh
npm run typecheck
npm run test:compile
node scripts/run-tests.mjs .tmp/test-dist/tests/review/preflight.test.js .tmp/test-dist/tests/review/packet.test.js .tmp/test-dist/tests/review/command.test.js .tmp/test-dist/tests/cli/review-task-context.test.js
```

### Step 4: Commit boundary

```text
feat(review): require fresh machine evidence
```

## Task 6: Make the completion handoff explicit and visible

**Files:**

- Modify: `runtime/src/install/harness.ts`
- Modify: `runtime/src/install/plan.ts`
- Modify: `runtime/src/install/doctor.ts`
- Modify: `tests/install/harness.test.ts`
- Modify: `tests/install/plan.test.ts`
- Modify: `tests/install/doctor.test.ts`
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/en/spec/review.md`
- Modify: `docs/zh-TW/spec/review.md`
- Modify: `docs/en/spec/acceptance-and-evidence.md`
- Modify: `docs/zh-TW/spec/acceptance-and-evidence.md`
- Modify: `docs/en/guides/configuration.md`
- Modify: `docs/zh-TW/guides/configuration.md`
- Modify: `tests/docs/spec.test.ts`
- Modify: `tests/docs/translation.test.ts`

### Step 1: Write failing rule and documentation tests

Require managed instructions and both language specs to state:

- run verification for the active task at the completion checkpoint;
- use the same explicit base for verify and review in clean CI;
- invoke one review only after verify PASS and only when review is configured;
- obtain explicit token-spend authorization before passing `--yes`;
- treat review FAIL and NOT_RUN as not complete;
- surface the complete report, including non-blocking findings and risks;
- do not imply that `verify` itself invokes an LLM;
- absent `reviewRoles` means external review is disabled, not implicitly PASS;
- install/update and doctor derive the same enabled/disabled managed-rule
  content from the effective `reviewRoles` configuration;
- evidence v1 is stale and full report history is not persisted.

Run:

```sh
npm run test:compile
node scripts/run-tests.mjs .tmp/test-dist/tests/install/harness.test.js .tmp/test-dist/tests/install/plan.test.js .tmp/test-dist/tests/install/doctor.test.js .tmp/test-dist/tests/docs/spec.test.js .tmp/test-dist/tests/docs/translation.test.js
```

Expected before implementation: FAIL.

### Step 2: Replace the generic managed sentence

- Add `independentReviewEnabled?: boolean` to `HarnessPlanContext`, defaulting to
  false for source compatibility. In `install/plan.ts`, derive it from an
  effective `independent-review` role with at least one target and pass it to
  every harness contribution.
- Pass the same derived value when doctor reconstructs expected managed-rule
  hashes; otherwise a healthy installed artifact would be reported stale.
- When the value is false, omit the current unconditional “obtain independent
  review” sentence. When true, update `managedRules()` to require this sequence
  without adding a Stop hook:

```text
At the completion checkpoint:
1. Run agent-ops verify for the active task.
2. In clean CI, pass the same --base <git-ref> to verify and review.
3. If independent review is configured and verification passes, obtain token
   authorization if needed and run agent-ops review --yes exactly once.
4. Surface the complete review result. Treat FAIL or NOT_RUN as not complete.
5. Claim completion only after required verification and configured review pass.
```

Document the CI sequence as two commands whose existing exit codes form the
gate. Do not add automatic PR comments, issue creation, saved reports, or task
auto-completion.

### Step 3: Re-run the focused tests

```sh
npm run typecheck
npm run test:compile
node scripts/run-tests.mjs .tmp/test-dist/tests/install/harness.test.js .tmp/test-dist/tests/install/plan.test.js .tmp/test-dist/tests/install/doctor.test.js .tmp/test-dist/tests/docs/spec.test.js .tmp/test-dist/tests/docs/translation.test.js
```

### Step 4: Commit boundary

```text
docs(loop): enforce visible verify-review handoff
```

## Task 7: Lock the end-to-end contract

**Files:**

- Modify: `tests/e2e/project-lifecycle.test.ts`
- Modify: `tests/e2e/user-lifecycle.test.ts`
- Modify: `tests/e2e/rollback.test.ts`
- Modify: `tests/review/chain.test.ts`
- Modify: `tests/verify/service.test.ts`
- Modify: `tests/cli/review-task-context.test.ts`

### Step 1: Add integration coverage

One injected, no-network lifecycle must prove:

1. create and attach a task with policy config baseline;
2. verify a source snapshot containing required PASS and optional FAIL;
3. confirm every v2 result reference is attached because overall verify passed;
4. run review and confirm preflight happens before exactly one model invocation;
5. return PASS with a minor finding and confirm full output plus PASS evidence;
6. edit source and confirm the next review is stale with zero model invocations;
7. rerun verification and return a blocking review FAIL;
8. confirm no fallback target and no FAIL review evidence write;
9. confirm task state contains evidence references but no full review report.

Add a separate race case where the injected runner simulates an external source
mutation before the reviewer returns: the command must convert the verdict to
`source-changed-during-review`, invoke no fallback, and write no review evidence.

The clean-CI case must use one resolved base for both commands, then dirty the
worktree and prove both commands stop before verifier/reviewer spawn.

Run:

```sh
npm run test:compile
node scripts/run-tests.mjs .tmp/test-dist/tests/e2e/project-lifecycle.test.js .tmp/test-dist/tests/e2e/user-lifecycle.test.js .tmp/test-dist/tests/e2e/rollback.test.js .tmp/test-dist/tests/review/chain.test.js .tmp/test-dist/tests/verify/service.test.js .tmp/test-dist/tests/cli/review-task-context.test.js
```

Expected before integration coverage: FAIL.

### Step 2: Make only wiring fixes exposed by the lifecycle

Do not refactor unrelated task, install, or process code. Any missing behavior
belongs in Tasks 1–6; this task adds regression coverage and the smallest wiring
correction only.

### Step 3: Run the full validation set

```sh
npm run typecheck
npm test
npm run build
npm run package:check
git diff --check
```

No automated test may invoke a real reviewer CLI, network, credential, or paid
model. Use the existing injected Git runner, process runner, and review executor.

### Step 4: Independent review

After the suite passes, run one configured eligible target against the PR 3
change surface. Use the same explicit base in CI. The report must account for
every changed file and display optional verification failures without treating
them as a machine gate.

### Step 5: Commit boundary

```text
test(review): lock verification freshness handoff
```

## Risks and explicit deferrals

- Fingerprinting cost is proportional to changed worktree bytes. It must never
  become a whole-repository scan.
- Base refs must already exist locally; verification never fetches from a
  remote.
- A model's inspected-file declaration is enforceable as a set, but not proof
  of semantic comprehension; human report review remains required.
- An externally killed verification process cannot record a failure signal.
  This plan does not add a transactional run journal for that rare case.
- Evidence retention, garbage collection, report history, PR comments,
  notifications, retry, voting, batching, and task auto-completion remain out
  of scope.
