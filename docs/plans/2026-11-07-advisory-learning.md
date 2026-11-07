# Evidence-backed advisory learning: research and scope

Reference: google-research/harness2 commit
`6868817518876de8fd170c6a8354daca273b6191` (read 2026-11-07).

| Reference surface | Observation | Decision |
| --- | --- | --- |
| `harness2/core/recursion.py:354` | k=1 probes two proposals, composes and executes the composition | One round, at most two proposals, re-execute composition |
| `harness2/core/selection.py:93` | Final selection deliberately excludes baseline | Keep baseline eligible; strict external quality threshold |
| `harness2/core/selection.py:402` | Reflection reads edits, trajectories and adoption reasoning | Preserve source/diff/verify/review and execution contrasts |
| `harness2/core/prompts.py:1105` | Adoption alone does not prove an edit helped; decline confounded lessons | Keep trigger proof, measured improvement and causal claims distinct |
| `harness2/core/library.py:58` | Domain library is read before each task, appended afterwards | Repository-scoped private version library; scoped retrieval |
| `harness2/substrate/codex.py:149` | Executor disables sandbox/approval and hook trust | Reuse agent-ops read-only invocations; do not integrate dependency |

Existing agent-ops call paths were audited before editing:

| Capability | Before this change | Source |
| --- | --- | --- |
| Escape reflection | Present; at most two JSON proposals from escape/fix/task data | `runtime/src/escape/reflect.ts:125` |
| Trigger replay | Present; escaped diff hit and 200-commit backtest at <=30% | `runtime/src/escape/reflect.ts:93` |
| Lesson persistence | Present; tracked escape-only records | `runtime/src/escape/lessons.ts:106` |
| Later retrieval | Present; task notice → pathMatchedLessons → criteria advisory | `packages/cli/src/commands/task.ts:133`, `runtime/src/review/criteria.ts:62` |
| Trigger usage | Partial; fires/applies/na, not improved task quality | `runtime/src/logging/local-log.ts:75`, `packages/cli/src/commands/escapes.ts:80` |
| Isolated replay | Partial; verifies code versions, not strategy versions | `runtime/src/verify/acceptance-replay.ts:127` |
| Safe invocation/metrics | Present; read-only target flags, isolated env, optional usage | `runtime/src/review/invocation.ts:93`, `runtime/src/review/usage.ts:9` |
| Delivered evidence | Present; receipt + note digest + contracts + two reviews | `runtime/src/followup/receipt.ts:31` |
| Promotion, composition, holdouts, library recovery | Missing in inspected learning paths | New opt-in `learn` controller and private store |

Fixed-string searches recorded in the task surface audit:
`criteriaReviewPrompt`, `pathMatchedLessons`, `BEGIN UNTRUSTED DATA`,
`runCriteriaReview`, `COMMAND_NAMES`, `readDeliveredReceipt`, `FileFollowupStore`.
Callers and independent prompts were inspected/classified separately.

Observed before implementation: `agent-ops escapes --json` returned three lessons,
zero rules and lesson fire counts 0/1/1, all `insufficient-data`. This proves
neither usefulness nor a quality increase. Existing trigger tests remain trigger
tests. New fixture experiments test the mechanism; they do not establish real
model improvement.

User decisions: optimize advisory omission detection first; share only within
the local repository across sessions/worktrees; use existing subscription CLI
quota, capped by extra invocations rather than invented API bills. No new
dependency or configuration/trust/schema migration is needed. Escape lesson
contracts and formal verify/review/completion gates remain unchanged.

Five acceptance slices: persistent reuse and exact citations; paired repeated
comparison plus independent holdouts and composition revalidation; conservative
retention; provenance/version recovery and stale-baseline protection; untrusted
data/redaction/unchanged formal gates and source fingerprints. See the linked
task contract and tests under `tests/learning/`.

Write timing: learning reads sealed completed receipts; experiments, adopted
versions, active pointers, recovery and use records live only in Git common dir.
They cannot change a verified source tree. New shipped code/docs are committed
before formal verify/review. Prior advisory attempts retain their exact context;
new attempts load current adopted guidance.

Out of scope: end-to-end coding success optimization, cross-machine sharing,
multiple recursion rounds, model training, executable candidate code, automatic
rewrite/removal of old lessons without their original regression cases, and
claims of long-term/generalized performance improvement. Real model experiment
results must be reported independently; unexecuted experiments are NOT_RUN.
