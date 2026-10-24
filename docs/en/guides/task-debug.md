# Task DEBUG investigations

A DEBUG task is an ordinary task whose acceptance proves the original
regression: a behavioral criterion whose `redCheckIds` fail with an assertion at
the baseline commit and pass on the candidate. Nothing else is special about it.

```sh
agent-ops task create --debug --title "Fix cart scroll" \
  --goal '<the issue, verbatim>' \
  --surface-file surface.json \
  --criterion-file regression.json --criterion-file related.json
```

- `--debug` needs `--goal` and at least one behavioral criterion with
  `redCheckIds`; otherwise creation fails with `TASK_DEBUG_RED_CHECK_REQUIRED`.
  The surface audit is required as for any task.
- The baseline is the commit the task was created on; `task revise --baseline
  <ref>` moves it (for example off the wrong branch) and voids earlier evidence.
- Then fix, commit, `verify`, two-round `review` and `worktree finish` exactly
  as for any task. Setup failure, skip, timeout and UNKNOWN never prove
  reproduction; the red check must fail on an assertion at the baseline.

## Escape origin (advisory)

If you know where the bug came from, record it like any task:
`task revise --escape-of <commit> --escape-label <label>`. It writes `.agent-ops-escapes/<task-id>.json` and
prints the link state, `git blame` hints and any rule proof
(`ESCAPE_RULE_UNPROVEN` and friends). None of it blocks finish; see
`EVIDENCE-ESCAPE-001` and `EVIDENCE-ESCAPE-002`.

## Removed in 0.11.0

`task debug` (hypotheses, strategy switches, investigate, checkpoint, resume,
extend, origin), the 60-minute budget and five-round limit, native control
words (只診斷, 暫停, 繼續, 繼續修復, 取消時間限制), automatic DEBUG intake from
prompt hooks, the DEBUG-specific Stop block and the Codex `Interrupt` hook are
gone. `task debug` now fails with `TASK_DEBUG_REMOVED`.

Older state still loads: tasks keep their `debug` tag, stored budget and
hypothesis state is ignored, `originRequired` no longer blocks finish, and a
config's `features.debug` is accepted and dropped by the next `update`.

## Retained review followups

After finish, inspect `agent-ops followup list` and `followup show <followup-id>`
(add `--json` for agents). `followup import` / `followup sync` retries metadata-only local
history collection without models or repairs. Ledger state is private in the
Git common directory and shared by linked worktrees. Collection warnings leave
original completion intact; retry after fixing the reported source/state problem.

A free-text observation needs explicit clarification first:

```sh
agent-ops followup clarify <followup-id> --finding-file finding.json --reason 'Concrete claim and supporting source'
agent-ops followup defer <followup-id> --reason 'Revisit after the dependency upgrade'
agent-ops followup accept <followup-id> --reason 'Accepted tradeoff for this release'
agent-ops followup reopen <followup-id>
env -u CODEX_SANDBOX_NETWORK_DISABLED agent-ops followup process <followup-id> --host codex
```

`finding.json` is an ordinary nonblocking ReviewFinding: severity, blocking=false,
title, details, locations (`path`, `line`), evidence, recommendation and criterionIds.
Accept/defer require reasons and never mean resolved. Reopen and process again
preserve source/proof history. Process is an explicit authorization for two fresh
isolated read-only current-source reviews and, on conclusive PRESENT only, a new
bounded production repair run. UNKNOWN, drift or reviewer errors stay unresolved.
Native macOS/clean main/checked-out target/trust/run-policy controls remain; a
refusal preserves its exact code and never triggers a nested-run workaround.

Use the trusted outer host for process; `update --auto-run on` can propose scoped
run-profile permissions. Do not modify trust or installed settings to bypass a
refusal. A non-executable claim may use `--review-only-reason 'specific reason'`;
ABSENT then needs two fresh reasoned reviews. Reproducible bugs need corresponding
behavioral red-to-green checks. Repair closure uses the exact original finding,
`followup-resolution` contract, delivered receipt, exact commit and evidence
digests; generic suite PASS, changed paths or run completion alone cannot close it.
This workflow adds no DEBUG investigation ceremony or SessionStart summary.
