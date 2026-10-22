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
- The baseline is the commit the task was created on.
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
