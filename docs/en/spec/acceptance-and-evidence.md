# Acceptance and Evidence

## EVIDENCE-CONTRACT-001

Executable acceptance MUST bind the current contract to immutable replay evidence.

- Trigger: Verifying or completing a typed acceptance contract.
- Action: Replay trusted checks against the immutable baseline and current candidate, then obtain fresh review.
- Evidence: Digest-bound phase results and current contract coverage enter both reviewer packets.
- Positive: Baseline assertion FAIL and candidate PASS prove a behavioral check.
- Negative: A fixture error is counted as red, or an old review proves revised criteria.

- `behavioral`: every designated red check fails by assertion on the baseline;
  every required candidate check passes. `invariant`: required candidate checks
  pass; baseline PASS is valid. `review-only`: two fresh reviewers discharge the
  requirement against the original goal; no mechanical proof is claimed.
- Trusted repository `verification.acceptanceRunners` define argv, setup, product
  build and test build. Tasks provide stable check IDs and explicit committed
  test/fixture/helper materials. Each checkout installs and builds its own version
  before candidate materials are overlaid. Tasks cannot override runner commands.
- Fixture, collection, build, timeout, cancellation, truncated output, missing or
  duplicate IDs, retries and skips MUST NOT establish red or green. Complete raw
  execution artifacts are digest-bound to the contract, materials and commits.
- Baselines are immutable creation commits, or failed candidates for finding pins.
  Revise/replan preserve the original goal, every mapped requirement and previous
  contracts/evidence. New contracts require new proof and both fresh reviews.
- `task pin-finding` validates saved report digest/index provenance. Recurrence
  explicitly names an existing pin. A sixth criterion returns a replan obligation
  without changing state; the mapped replan must retain the pin and all requirements.
- Reviewer packets include original goal, revision history, coverage and verifier
  materials. Review checks the assertions themselves and explicit fallback reasons.
  Mechanical green never removes mandatory policy commands or either fresh review.

Task state writes version 2 and reads version 1. Evidence version 4 reads earlier
evidence; attestation version 3 binds contracts and coverage. Legacy criteria keep
the verifier rules below; typed or revised contracts cannot reuse an old review.
Coverage separates mechanical proof, review-only and legacy; a runner binding alone
is not proof. Explicit no-change proof names existing committed regular source files
at the frozen candidate; integration re-resolves them. Ordinary empty-diff review
and empty-branch direct finish remain rejected.

## EVIDENCE-CRITERION-001

Every acceptance criterion MUST map to observable evidence.

- Trigger: Defining or reviewing task completion.
- Action: Name a command, read-back, or artifact for each criterion.
- Evidence: The final report contains one evidence reference per criterion.
- Positive: `criterion tests → npm test (354 passing tests)`.
- Negative: `The implementation looks correct, so no evidence is needed.`

## EVIDENCE-INTENT-001

Each child worktree MUST record its modification intent before editing.

- Trigger: A subagent will edit in its own worktree.
- Action: Use `task create --intent <text>` to record the user-approved behavior, constraints and integration points. The coordinator imports the intent with the child task and re-runs verification on the integrated candidate.
- Evidence: The child task and final receipt contain the intent, with final verifier evidence bound to the integrated candidate.
- Positive: `A child records its planned API change, commits it, and the final receipt includes that intent and integrated verification.`
- Negative: `A child edits first and supplies a retrospective one-line intent at delivery.`

## EVIDENCE-AGGREGATE-001

The verifier MUST return FAIL when a criterion is missing, duplicated, unknown, or has empty evidence.

- Trigger: Combining independent verifier results.
- Action: Require the exact requested criterion set once each; require non-empty evidence.
- Evidence: The aggregate lists the criterion IDs and their evidence references.
- Positive: `tests PASS [report.json]; scope PASS [diff.txt]`.
- Negative: `tests PASS; tests PASS; extra PASS`.

## EVIDENCE-COMPLETION-001

`agent-ops task complete` MUST validate completion independently of the host, active profiles, and Stop hooks.

- Trigger: Completing a task, including repeated completion requests.
- Action: Check required verifiers, current evidence, whole-task review, and subtask completion before writing state.
- Evidence: `TASK_COMPLETED` is returned only after these checks pass; rejected requests preserve state.
- Positive: Current verification evidence plus a task-bound review allows an otherwise complete task to finish.
- Negative: Supplying `criterion=PASS`, an old review, or archiving an unfinished child to bypass completion.

- Every criterion needs at least one required verifier and current PASS evidence for every required verifier it names. Verify always includes those task-required commands, even when path mappings select a narrower set. Supply the evidence file references produced by `agent-ops verify --task <id>`, not command strings or a written assertion of PASS.
- The task's config baseline and evidence must match the current effective config and source fingerprint in the selected scope. Outstanding verification failures block completion. A newer failing result cannot be replaced by an older PASS; contradictory results at the same timestamp fail closed.
- Run `agent-ops review --task <id> --yes` for the whole task. Completion requires its current, task-bound PASS attestation; generic reviews and partial-criterion reviews do not satisfy it.
- An unchanged task, source, criteria and config may reuse its recorded PASS review after fresh verification. Starting a fresh authorized review (`--rerun`) invalidates the previous attestation for that source fingerprint. If the reviewer cannot run or does not pass, run a fresh successful whole-task review before completion.
- All subtasks and descendants must have completed without an outstanding failure. Archiving unfinished work does not satisfy this requirement. A completed or archived parent cannot accept new subtasks. If a subtask is abandoned, recreate the parent task without that cancelled branch and verify/review the new task tree.
- Evidence, source and config validation run outside the task store lock. After rechecking source and config, completion briefly locks state, rejects a changed task snapshot (`TASK_COMPLETION_STATE_CHANGED`), rechecks descendants, and writes completion atomically. Slow validation does not block task reads or other task mutations; a concurrent mutation remains intact when completion is rejected.

`test-count.minimum` counts explicitly passed tests, excluding skipped, todo, expected failures and discovery totals. Zero passed tests fail even with minimum zero; an unrecognizable passed summary is UNKNOWN. Explicit failed, error or cancelled outcomes fail even when the process exits zero. Exit-code verifiers retain their existing behavior. Task verify returns `VERIFICATION_UNKNOWN`, names uncovered criteria and runs no verifier commands when any criterion lacks a required verifier; optional-only results cannot establish formal task verification.

New verification evidence uses schema 3. Schema 2 remains readable and its exit-code evidence remains valid; schema 2 test-count evidence cannot establish PASS and requires fresh verification. Old references are retained. A completed task may append fresh verification only for its original source, criteria and config, preserving completedAt and review references. Its entire state snapshot is compared atomically before appending and clearing failure; concurrent changes are preserved and rejected. Fresh FAIL or UNKNOWN blocks completion until resolved; archived tasks remain immutable. Source or config changes require a new task.

Existing task files remain readable without migration. Legacy tasks without a config baseline, arbitrary evidence references, or unfinished archived children must be recreated and verified/reviewed before completion. Repeating completion also revalidates the evidence; an old completed status alone is insufficient. Runtime callers must supply `TaskServiceOptions.completion`; omitting this repository context fails closed for completion while leaving read-only task operations available.

Before committing, use the default worktree scope for verify, review and completion. After committing, use the same `--base <git-ref>` on all three commands to produce fresh proof for that committed range; `TaskServiceOptions.completion.base` selects it for runtime callers. Base mode requires a clean worktree. Without a worktree change surface or an explicit base, completion returns `TASK_COMPLETION_SCOPE_REQUIRED`. The agy Stop gate still checks worktree-scoped proof: complete and stop before committing, or use its user-approved one-time permit after inspecting a completed base-scoped task.

This enforces the toolkit's completion command, not a host's natural-language completion claim. It does not prevent a process with the same filesystem authority from editing task/evidence files directly, and it does not lock Git or external source writers.

Project init/update installs `.agent-ops/.gitignore` for `/tasks/` and `/reviews/` on every harness and profile. An existing user-owned `.agent-ops/.gitignore` blocks init/update with `UNMANAGED_INSTALL_PATH`: first back it up outside that path and move its custom rules to the root `.gitignore` (prefix them with `/.agent-ops/`), then retry. Git collection fails with `CHANGE_SURFACE_TRACKED_RUNTIME` if these directories contain indexed files (even clean tracked files), or staged runtime removals. Move any real source files out of the runtime directories, install ignore rules, then use `git rm -r --cached --ignore-unmatch -- .agent-ops/tasks/ .agent-ops/reviews/` to keep local files while removing them from the index. Commit any staged removals before producing fresh verification/review evidence. The active completion Stop gate also blocks this condition with `COMPLETION_GATE_TRACKED_RUNTIME` and the recovery message. Run verify/review from the Git repository root; nested project roots are not supported by the current path/fingerprint collector. Uninstall removes the managed ignore file but preserves runtime output.
