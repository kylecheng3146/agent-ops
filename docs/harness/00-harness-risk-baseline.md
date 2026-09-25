# Harness Risk Baseline: Top Three Issues and Concrete Repairs

Baseline ID: `HARNESS-BASELINE-2026-09-21`; Version: v1. Subject: agent-ops 0.2.6, Git HEAD `27203152ddf04e167f8c8ec7ff2b4cf139477765`, and active local harness settings. This document records diagnostics and proposed repairs; it does not claim that repairs have been implemented.

Subsequent designs, implementations, PRs, and acceptance criteria should reference this document and `H-01` / `H-02` / `H-03`, stating which issue is being addressed and what acceptance criteria are adopted. Re-evaluate conclusions when code or configuration changes; do not treat this baseline as permanently authoritative.

## Priority and Evidence Boundaries

This is a comprehensive repair priority across the three root causes, not three items per category. Priority is determined by impact scope, recurrence risk, and currently verifiable evidence.

| Priority | Stable ID | Root Cause | Primary Cost |
| --- | --- | --- | --- |
| 1 | H-01 | Task state is not reconnected to startup and compaction recovery flows | Loss of focus, re-reading, rework, missed constraints |
| 2 | H-02 | Fixed double-review cost for every change without token cost telemetry | Token waste risk, latency, and retry overhead |
| 3 | H-03 | `--base` comparison range is not supplied to actual reviewers | Reviewing the wrong scope while potentially obtaining a nominal PASS |

H-01 and H-03 have verified state and code citations; H-02 has confirmed fixed execution costs, but "most token-intensive" is a structural judgment with no per-stage model usage available for empirical ranking. Existing loop telemetry logs only timestamp, event, result, and code; event count cannot be translated to token count, and byte size is not model token count. Memory savings percentages from claude-mem are likewise not an overall cost measurement for this harness.

Local `AGENTS.md`, `.agent-ops/config.json`, `.codex/loop-goal.md`, etc., are Git-ignored installation/runtime state; references to them below reflect field observations and do not claim existence in the commit above or a clean clone. All code links point to tracked source files.

## H-01: Files Are Saved, but Executable Task State Is Not Restored

### Confirmed Evidence

1. Local `.codex/loop-goal.md` and `.claude/loop-goal.md` both remain `Describe the current objective, acceptance criteria, and important constraints.`. This matches the [install-time GOAL_SEED](../../runtime/src/install/codex-loop.ts#L34); this conversation's startup message also marked it as Current goal.
2. [writeCompactSnapshot](../../runtime/src/hooks/codex-loop.ts#L420) updates only timestamps and Git status, without recording task ID, verified criteria, incomplete items, or next steps. The local historical snapshot still reports `Status: idle`, timestamped 2026-09-17.
3. The [SessionStart branch](../../runtime/src/hooks/codex-loop.ts#L545) reads only goal and telemetry count, ignoring `loop-state.md` and the task store. Although `PostCompact` is listed among registered events, it leads to empty output with no restoration branch. [TaskService.create](../../runtime/src/task/service.ts#L178) provides tasks and session attachments, but the two state mechanisms are never joined here.
4. Invoking the compiled `runProjectLoop` directly: SessionStart returns 186 characters containing placeholders and omitting existing snapshots; PostCompact returns 0 characters. This confirms an agent-ops recovery gap, without asserting that all host harnesses lack native conversation summarization.

There is an additional field issue amplifying loss of focus: `docs/harness/10-session-protocol.md`, required by local `AGENTS.md:10`, does not exist. This is a broken local routing entry, not a bug inherent to all installations.

### Why Ranked First

Across sessions or after compaction, an agent knows that "the loop is running", but cannot learn via this path "what is being done, what has been proven, or what comes next". Re-exploration, re-runs, and dropped constraints originate here; adding rules or extra review rounds cannot restore missing execution state.

### Minimal Repair

- Use task/session attachments in the existing task store as the source of truth; at startup, resolve the current session's task and output task ID, goal, unmet criterion IDs, and evidence citations. Do not substitute "the most recent task in the repository" for the current task.
- Retain only a brief checkpoint in existing `loop-state.md`: task ID, next action, blocker reason, and accepted critical constraints; discard state when mismatched with the active task. Do not introduce a third task database, and do not treat natural-language summaries as PASS evidence.
- Read the summary back at recovery entry points where hosts reliably support context injection; at minimum connect to existing SessionStart. Whether PostCompact supports injection must be verified by adapter testing rather than assumed from event registration.
- Treat an unedited GOAL_SEED as "no goal set". Retain the 1,200 character ceiling, redaction, private-file, and fail-open boundaries; prioritize task/next action over event counts.
- Restore the short session entry point required locally, linking to valid judgment/delegation/review/maintenance specifications with verified paths; do not preload the whole playbook or invent non-existent model dispatch rules. This baseline document does not substitute for session protocol.

Touch surface: `runtime/src/hooks/codex-loop.ts`, existing task query/render interfaces, and `tests/hooks/codex-loop.test.ts`; entry point absence is resolved separately by a small routing document. New persistence fields or adapter behavioral changes require project contract approval; this proposal authorizes neither.

### Acceptance Criteria for Resolution

- When the same task undergoes checkpoint → compaction → recovery, context identifies unmet criteria and next steps; completed work is not re-listed as pending.
- Switching to another session/task does not import state from the prior task; the seed goal clearly indicates unset.
- Oversized content, secret-shaped content, corrupt files, and missing files satisfy character limit, privacy, and fail-open tests; no verification evidence is fabricated from text summaries.

## H-02: Double Review Is a Fixed Cost, but Cost Controls Track Only Time and Bytes

### Confirmed Evidence

1. [managedRules](../../runtime/src/install/harness.ts#L603) mandates independent review for every change; [subtask rules](../../runtime/src/install/harness.ts#L639) demand separate verification and review. [planReviewTargets](../../runtime/src/review/roles.ts#L55) systematically schedules two fresh sessions; even with a single target, it runs twice. A first FAIL/NOT_RUN halts execution and avoids a second round.
2. The [second-round prompt](../../runtime/src/review/runner.ts#L238) carries the original task, verification summary, and the complete redacted report from round one, demanding verification against the codebase and refutation of PASS. This provides genuine independent protection, but lacks cost tiering between documentation updates and high-risk runtime changes.
3. Packet limits are [64 KiB](../../runtime/src/review/packet.ts#L26), adversarial prompts are capped at [128 KiB](../../runtime/src/review/runner.ts#L229), and each reviewer defaults to [15 minutes and 90 seconds inactivity timeout](../../runtime/src/review/execute.ts#L42). These are transmission and procedural guardrails, not token budgets; continuous output does not guarantee continued progress.
4. [ReviewAttempt](../../runtime/src/review/runner.ts#L26) tracks no token usage; [LoopLogEvent](../../runtime/src/logging/local-log.ts#L29) does not either. The current "508 recent events" cannot indicate which reviewer incurred cost, whether duplicate content was read, or how many tokens were spent.
5. [Each attempt](../../runtime/src/review/execute.ts#L528) receives a separate full timeout, and [the second round](../../runtime/src/review/execute.ts#L811) consumes another; there is no shared deadline across the chain. Nearing limits, two rounds can total ~30 minutes plus probe/clone costs; this is an upper bound permitted by code, not observed benchmark time.

### Non-Issues That Should Not Be Misdiagnosed

The [review prompt](../../runtime/src/review/runner.ts#L212) intentionally avoids embedding full diffs; review operates on a changed-file scope, and round two is an adversarial counter-check against PASS, not a forced repository-wide rescan. Identical verifiers bound to multiple criteria are deduplicated in [VerificationService](../../runtime/src/verify/service.ts#L261). These existing safeguards must not be treated as bugs.

### Minimal Repair

- Retain dual review, fresh sessions, read-only isolation, and full evidence contracts. Narrow reviewer reading order to "changed files → direct callers / necessary supporting files", requiring minimal sufficient evidence per finding while preserving full criterion and file coverage; avoid importing historical reports or the full playbook into every round.
- When source, config, and task are unchanged and a valid attestation already exists, reuse verified evidence directly; do not re-invoke review merely to restate a summary. Any evidence reuse must validate against existing fingerprint/policy checks, never file name or timestamp alone.
- Introduce a shared deadline for the entire review in `createReviewExecutor`, clearly distinguishing it from single-target timeouts; capability probe, snapshot, and both review rounds share remaining budget, exiting with NOT_RUN when exhausted. Preserve stall detection; heartbeat activity must not reset the global budget. Document compatibility when adjusting budget interfaces; do not silently alter existing `timeoutMs` semantics.
- Record per-round prompt bytes, elapsed time, target, and exit reason at existing review boundaries; log input/output tokens when the CLI reports reliable usage, otherwise set unknown. Store only numerical and identity data, omitting raw dialog and credentials. External/persistent format changes require approval.
- Evaluate whether low-risk changes can reduce review rounds only after telemetry is in place; this alters the mandatory dual-review policy and requires a separate decision, not an ad-hoc omission to save tokens.

Touch surface: prompts in `runtime/src/review/runner.ts`, measurement boundaries in `runtime/src/review/execute.ts`, and corresponding review tests. If rules change, update source in `runtime/src/install/harness.ts`, not generated `.agent-ops/AGENTS.md`.

### Acceptance Criteria for Resolution

- Compare pre-repair and post-repair on an identical set of small doc changes and runtime changes: report prompt bytes, model usage availability, elapsed time, duplicate call counts, and results; do not claim percentage savings without usage metrics.
- Round one FAIL halts; round two refuting PASS yields FAIL; missing round two, source drift, or incomplete output cannot yield a PASS attestation.
- Every criterion and changed path remains fully covered; reusable evidence avoids redundant reviews, and invalidated evidence cannot be mistakenly reused.
- Simulated heartbeat tests demonstrate termination within the overall deadline plus bounded cleanup, with round two not receiving a refreshed full budget.

## H-03: `--base` Identifies the Correct Range, but Reviewers Do Not Receive the Comparison Baseline

### Confirmed Evidence

1. [resolveReviewScope](../../runtime/src/review/scope.ts#L114) requires a clean worktree for `--base`, resolves `resolvedBase`, and calculates base→HEAD changed files; the CLI [retrieves this scope](../../packages/cli/src/commands/review.ts#L539) before passing it to the review invocation.
2. [executor](../../runtime/src/review/execute.ts#L699) passes only `scope.changedFiles` into the attempt; [snapshotRepository](../../runtime/src/review/execute.ts#L328) clones current HEAD and overwrites changed files. For a clean committed range, overwriting yields existing HEAD content; standard `git diff` is empty.
3. [buildReviewPrompt](../../runtime/src/review/runner.ts#L217) and [buildAdversarialPrompt](../../runtime/src/review/runner.ts#L238) do not serialize `scope.mode`, `baseRef`, or `resolvedBase`. While reviewers have Git history, they lack a reliable basis to know the requested comparison origin; viewing the latest commit does not match a multi-commit range.
4. [Report verification](../../runtime/src/review/execute.ts#L598) checks criteria and changed files, but does not verify whether reviewers received the correct baseline. Two reviewers can share the same scope blind spot; fresh sessions cannot remedy omitted inputs.
5. Direct testing of the executor on six changed paths against `HEAD~1` using a real Git runner and simulated PASS reviewers: both snapshots remained at HEAD, standard diffs were empty, explicit base diffs showed six paths, neither prompt contained base SHA or `HEAD~1`, yet the executor returned PASS. This reproduced the contract gap without calling real models or saving simulated results as official evidence.

### Failure Mode

This path risks treating "inspected current file contents" as "reviewed changes against the specified range", especially overlooking deleted code, multi-commit regressions, and compatibility breaks. The defect is confined to committed `--base` review; it does not imply that worktree review fails or that models have approved broken code.

### Minimal Repair

- Retain the read-only, isolated HEAD snapshot; pass `ReviewScope` mode and resolved base commit into both prompts, explicitly directing `git diff <resolvedBase> HEAD -- <changed paths>`. This is smaller than designing diff storage formats and preserves supporting file versions.
- Verify in snapshot that the required commit object exists; return NOT_RUN if unresolvable. Pass arguments safely; do not trust arbitrary task text, and never silently fall back to HEAD~1 or empty diffs.
- Test executor with a small Git repository and mock reviewers: intercept reviewer cwd and prompt, verifying specified base, diff output, and modified/added/deleted paths. Checking `changedFilesInspected` strings alone is insufficient.
- Retain before-and-after fingerprints, scope signatures, policy, read-only isolation, full criteria checks, and second-round adversarial checks; they prevent source drift but cannot substitute for correct diff ranges.

Touch surface: `runtime/src/review/runner.ts`, `runtime/src/review/execute.ts`, and `tests/review/chain.test.ts`; reuse existing `ReviewScope` without new dependencies.

### Acceptance Criteria for Resolution

- Specifying the first of three commits as base in a clean repo ensures both reviewers receive the resolved SHA, with the specified diff covering the entire range rather than the final commit.
- Modifications, additions, and deletions/renames are locatable in reviewer diffs; missing base objects are not treated as clean.
- Existing dirty-worktree, invalid-base, and source-changed validations and worktree review behaviors remain effective.

## Execution Order and Shared Boundaries

If the next change uses `--base`, resolve H-03 first to avoid generating review evidence against an incorrect scope. For general tasks, address H-01 first, restoring the missing short entry point. Address H-02 by narrowing review context, adding shared deadlines, and measuring before deciding on policy changes. Ranking reflects operational reach; while H-03 has a narrower trigger surface, correctness takes precedence.

Follow Ponytail minimal-change principles: reuse task stores, checkpoints, ReviewScope, fingerprints, and attestations. None of the three repairs require new dependencies, new frameworks, repo-wide refactors, or another memory subsystem. Redaction, trust, read-only isolation, source/config fingerprints, and conservative FAIL/NOT_RUN semantics must not be removed.

Document drift noted during inspection is deferred as a separate effort: [English](../en/spec/harness-adapters.md#L111) and [Traditional Chinese](../zh-TW/spec/harness-adapters.md#L95) still describe Claude completion-gate as unsupported, contradicting [code implementation](../../runtime/src/adapters/claude/events.ts#L54). Doctor checks passing only validates installed items against configured rules, not the correctness of these files or local routing tables.

## Verification Record and Boundaries

- `npm run test:compile`: PASS.
- `node scripts/run-tests.mjs .tmp/test-dist/tests/hooks/codex-loop.test.js .tmp/test-dist/tests/docs/spec.test.js .tmp/test-dist/tests/review/runner.test.js .tmp/test-dist/tests/review/chain.test.js .tmp/test-dist/tests/hooks/completion-gate.test.js`: 76 tests, 76 pass, 0 fail.
- Direct invocation of `runProjectLoop` on SessionStart/PostCompact: reproduced H-01 results with normal telemetry appended and no goal/checkpoint modifications.
- Invocation of `createReviewExecutor` with `NodeVerificationProcessRunner` and mock runners: reproduced H-03 behavior with empty standard diffs and missing base in prompts across disposable clones without modifying sources.
- `git ls-files --error-unmatch AGENTS.md .agent-ops/AGENTS.md .agent-ops/config.json .codex/loop-goal.md docs/en/spec/harness-adapters.md`: first four unversioned, last tracked, validating boundaries between local state and tracked source.
- `node dist/packages/cli/src/bin.js doctor --json`: loopback/write restrictions caused sandbox failure; outside sandbox, CLI probed agy and review CLIs with environment marks returning DEGRADED (DOCTOR_UNKNOWN) without `--check-auth`.

Existing test passes validate covered behaviors, not the resolution of gaps documented here, nor that all host hooks operate in practice. Token usage was unmeasured; cross-host end-to-end enforcement remains unverified. This document does not infer capabilities from external product updates.
