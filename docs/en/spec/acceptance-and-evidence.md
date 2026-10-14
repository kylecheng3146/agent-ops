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
- Native Jest JSON and Vitest task errors lack complete test-call versus
  hook/fixture-cleanup provenance. Failed rows MUST remain UNKNOWN unless a
  reviewed repository collector supplies explicit assertion classification;
  AssertionError names, matcher details and passing hook states are insufficient.
  Green requires explicit single-attempt evidence: attempts, Jest invocations,
  or both Vitest retryCount and repeatCount. Native Vitest JSON omits these
  counters and cannot supply mechanical proof by itself. Pytest requires one
  ordered setup/call/teardown lifecycle per nodeid; the Rust protocol requires
  explicit attempts. Missing metadata MUST NOT default to a successful attempt.
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

## EVIDENCE-SURFACE-001

Every new task MUST record a surface audit of where else its change lands before writing criteria, and review MUST NOT run while discovery finds an unclassified place.

- Trigger: Creating a task (`task create`, a run plan, or before a DEBUG task's first repair), revising its surface, or reviewing it.
- Action: Search four axes with recorded fixed-string queries or `n/a: reason`, classify every hit as included, excluded (glob + reason) or UNKNOWN, give every surface row an observable `behavior`, and declare each shared contract compatible or breaking. Pass it with `task create|revise --surface-file <json>`.
- Evidence: The surface is stored on the task, bound into its contract hash with revision history, replayed by `git grep -F` before review, and handed to both reviewers under the `surface-coverage` criterion.
- Positive: `A diff token hits three copy-pasted sibling pages; the audit includes them with their behavior before review runs.`
- Negative: `Exclude src/** because it is "out of scope", or list only the files the diff already touches.`

- Axes: `dependents` (importers, callers, readers), `duplicates` (copied
  markup, strings, logic that imports nothing), `otherPaths` (other routes,
  modes, entry points or re-entries to the same concept) and `sharedState`
  (storage, cache, messages, external APIs, client storage, issued URLs). The
  design is stack-agnostic: the same axes cover frontend, backend, database,
  cache and message flows.
- `included` rows carry `id`, `path` glob and `behavior`; `excluded` rows carry
  `glob` and a reason saying why the surface is unaffected ("out of scope" is
  not a reason); `unknown` rows name a reader the repository cannot see.
  `contracts` declare `compatible` or `breaking`. A single surface is allowed.
- `valueChanges` `[{producer, kind, change, consumers, indirectConsumers}]`
  list two hops whenever a value's semantics change (clear, redact, default,
  normalize, unit/format).
- `scenarios` cover five generic dimensions — `initialState` (empty vs
  existing), `redo` (reload, retry, redelivery, idempotency), `timeBoundary`
  (day, TTL, timezone), `identitySwitch` (store, role, tenant) and
  `concurrency` — each `{applies: true, behavior}` or `{na: reason}`.
- A parent holds the surface; its children declare `{"covers": [surface-id]}`
  and their union must equal the parent's included list.
- Before any reviewer runs, discovery replays with `git grep -F` through argv
  (never a shell or a regex built from task text), cheapest source first:
  recorded queries; enclosing function names from diff hunk headers;
  template-literal fixed fragments (at least 4 characters, separator-bounded,
  such as `order:`, `user_`, `menu.`); compound identifiers (snake_case,
  camelCase or containing digits, so prose words are not queries) and string
  literals from added and removed lines (at least 6 characters; skipped as too
  generic above 30 file hits). Every hit outside the diff and the surface lists stops review.
  Results are cached by HEAD, base, diff, query set and config hash.
- Review returns NOT_RUN with: `SURFACE_MISSING` (no or unparseable surface;
  also refused at create for non-DEBUG tasks), `SURFACE_UNCLASSIFIED`,
  `SURFACE_QUERY_TOO_BROAD` (one recorded query over 200 files),
  `SURFACE_EXCLUSION_TOO_BROAD` (one glob over 10 files, or any file in the
  diff), `SCENARIO_MISSING`, `SURFACE_BUDGET_EXCEEDED` (120 s total, never
  silently skipped) or `SURFACE_UNASSIGNED` (children's covers differ from the
  parent's included list; checked by every review, including advance and batch).
- A surface revision is a contract revision: fresh evidence and two fresh
  reviews. Exclusions added after an `SURFACE_UNCLASSIFIED` block are flagged
  to reviewers as post-block exclusions.
- Tasks created before this rule shipped are grandfathered. Advisory local-log
  metrics per discovery source are fail-open and never evidence.
- Plain `worktree finish` writes the same local receipt as advance, including
  both rounds' residual risks and non-blocking findings, references it in the
  git note and prints the residual risks.

## EVIDENCE-ESCAPE-001

Every DEBUG fix MUST declare where its bug came from before review, and a declared escape MUST be linked, labelled and recorded mechanically.

- Trigger: A DEBUG hypothesis is confirmed, or a normal task fixes a bug that passed earlier gates.
- Action: Declare `origin` with `task debug --debug-action origin --payload-file <json>`: `{"kind": "escape-of", "commit": "<commit>", "label": "<label>"}` (optional `"receipt"`), or `{"kind": "pre-existing" | "external", "reason": "..."}`. A normal task may opt in with `task create|revise --escape-of <commit> --escape-label <label> [--escape-receipt <id>]`. Commit the `.agent-ops-escapes/<task-id>.json` record with the fix.
- Evidence: `origin` is bound into the task contract hash; finish, `task complete` and the completion gate refuse a DEBUG task created after this rule without it as `ESCAPE_ORIGIN_MISSING`; both reviewers receive the link state, labels, facts and residual risks under the `escape-label` criterion.
- Positive: `Hypothesis confirmed; origin escape-of 864dbbe2 label surface; replay marks the missed page surface-unseen; the record is committed with the fix.`
- Negative: `Finish a DEBUG fix without an origin, or relabel a surface-excluded miss as review because the reviewer "should have noticed".`

- The declaration comes after a confirmed hypothesis (`ESCAPE_ORIGIN_EARLY`
  otherwise), inside the DEBUG budget. It is a contract revision: re-verify,
  re-record the confirmed hypothesis with the new evidence, then review.
  Re-declaring replaces the record. The output lists `git blame` hint commits
  for lines the fix changed or removed; blame is a hint only, because an
  omission bug lives in lines nobody wrote.
- Finish receipts stay local in the Git common directory. Schema 2 records
  every commit in target..candidate and a per-file diff fingerprint (blob ids
  and hunk positions dropped, so a squash merge keeps it); schema 1 receipts
  still load and link by exact head only.
- Link states are counted separately: `gated` (a receipt matched),
  `unresolved` with a reason (`receipt-not-local` when a Git note or
  `--escape-receipt` names a receipt this machine lacks, `ambiguous-receipt`,
  `link-unavailable`) and `ungated` (no receipt and no note). Resolution
  order: `--escape-receipt` override, the commit inside a receipt's recorded
  range (schema 1: exact head), per-file fingerprint match, then unresolved or
  ungated.
- Label: one primary label, the earliest gate that could have caught the
  escape — `requirement`, `surface`, `scenario`, `criteria`, `verify`,
  `review` — or `flagged` (a residual risk or finding already said it) or
  `out-of-model`. The agent proposes it; `git grep -F` replay of the linked
  receipt's recorded surface queries at its candidate marks each file the fix
  touched as included, excluded, hit, unseen or absent, and `surface-excluded`
  or `surface-unseen` overrides any later label. The two reviewers adjudicate.
- The ledger is git-tracked and data only (commits, paths, labels, reasons,
  counts; never file contents or transcripts), one file per task so parallel
  worktrees never conflict. Gate catches (`SURFACE_*` and `SCENARIO_MISSING`
  review blocks, review FAIL, verify red to green) append advisory local-log
  `gate-catch` events with only the code and task id; logging fails open,
  while the origin requirement fails closed.
- Scope R1 records. Rules learned from escapes, replay proof, backtests,
  `--escape-fix` and an `agent-ops escapes` report are R2
  ([EVIDENCE-ESCAPE-002](#evidence-escape-002)).

## EVIDENCE-ESCAPE-002

A surface escape MUST become a proven, tracked rule before its fix finishes, and learned rules MUST only tighten the surface gate.

- Trigger: A declared escape-of origin (EVIDENCE-ESCAPE-001), or a past escape backfilled with `task create --escape-of <commit> --escape-label <label> --escape-fix <fix-commit>`.
- Action: For a `surface`, `surface-unseen` or `surface-excluded` label, commit a rule `.agent-ops-escapes/rules/<rule-id>.json` shaped `{"id", "escape", "label", "trigger": {"paths", "tokens"}, "expand": {"paths", "queries"}, "noExclude"}` and re-declare the origin. For `criteria` or `verify`, name the fixing task's red-to-green check with `--escape-promote <runnerId:checkId>` (DEBUG payload `"promote"`). Other labels record a lesson.
- Evidence: Finish, `task complete` and the completion gate re-run the proof and refuse `ESCAPE_RULE_UNPROVEN`, `ESCAPE_RULE_TOO_BROAD` or `SURFACE_BUDGET_EXCEEDED`; the ledger record stores the proving rule, its content hash and its backtest fires, commits and rate.
- Positive: `Escape surface-unseen; rule image-size-siblings fires on the escaped commit, its query hits both missed sibling pages there, and fires on 2 of the last 200 commits.`
- Negative: `Finish a surface escape whose rule never fires on the escaped commit, or add a rule field that excludes paths.`

- Rules are data only and need no trust: triggers and expands become argv
  `git grep -F` queries and path globs, never shell or regex. The strict schema
  has no field that removes a query, adds an exclusion or relaxes any gate.
  An invalid rule fails closed as review NOT_RUN `ESCAPE_RULE_INVALID`; a
  symlinked or non-regular rules directory or file as `ESCAPE_RULE_UNSAFE`.
- Surface gate: a rule fires only when the task diff matches a trigger path
  glob or a changed line contains a trigger token. Every expand hit of a fired
  rule must be in the diff, included, UNKNOWN or excluded, else
  `SURFACE_UNCLASSIFIED`; with `noExclude` an excluded hit is
  `ESCAPE_RULE_NO_EXCLUDE`. Fires and included/excluded counts per rule go to
  local-log `escape-rule` events (fail-open).
- Proof: the rule must name the escaped commit, fire on that commit's own diff
  and, replayed at that commit, hit every missed path that existed there.
  Missed paths come from the fix commit with `--escape-fix`, otherwise from
  the task diff. A `criteria`/`verify` escape needs its promoted check to be a
  `redCheckIds` entry of a proven behavioral criterion of the fixing task
  (red baseline, green candidate); the output prints a config proposal for a
  new required verifier, and agent-ops never writes `.agent-ops/config.json`.
  `scenario`, `review`, `requirement`, `flagged` and `out-of-model` record an
  unproven lesson with a reason and do not block. No review or test ever runs
  at the escaped commit.
- Backtest: the trigger is matched against the diffs of the last 200
  first-parent commits in one argv `git log`; a fire rate above 30% is
  `ESCAPE_RULE_TOO_BROAD`. It is time-budgeted (over budget is
  `SURFACE_BUDGET_EXCEEDED`, never a silent pass) and cached by HEAD and rule
  hash. Editing a proving rule makes the ledger record stale until re-declared.
- `agent-ops escapes [--json]` is a read-only, fail-open report: misses per
  label from the ledger, `gate-catch` codes from the local log, origin mix,
  link-state mix with unresolved reasons, and per-rule fire/included/excluded
  counts with time windows, as raw counts with n and `insufficient-data`
  when n < 10. Rules with at least 10 fires and no included hit are listed as
  retirement candidates; removal is always a reviewed commit, never automatic.
- R2 supersedes the phase-2 `surface.aliases` config (now tracked rules) and
  `surface stats` (now `agent-ops escapes`).

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
