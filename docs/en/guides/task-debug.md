# Task DEBUG investigations

Project `init` and `update` add `features.debug` by default:
`{"enabled":true,"budgetMs":3600000,"maxRounds":5}` (sixty minutes). Explicit disabled and custom
settings survive subsequent installs. Old configurations and ordinary tasks
remain readable. DEBUG is an optional task intake field, not a new run mode.

Claude and Codex native prompt hooks conservatively recognize investigation and
bug-fix requests. They retain the issue verbatim as `goal`, record uncertain
facts/unknowns, and create an existing isolated task. Explain, feature and
refactor requests retain their ordinary behavior. A reliable native session ID
is required; agy does not provide this prompt intake. Its native agent can use
`task create --debug --goal '<original issue>'` with two to five criteria, which
starts the same foreground clock when the native session is available.
An original dirty checkout is refused before any worktree snapshot is created.

The intake criteria are provisional. The native agent investigates via trusted
configured commands, records hypotheses, replaces the criteria with relevant
behavioral acceptance, fixes the product, and uses existing `verify`, `review`
and worktree finish commands. There is no additional model or background worker.
The default is the full repair loop. A clean HEAD fixes the baseline automatically;
do not request redundant approval or offer diagnosis-only as a fallback. Failure
to reproduce alone does not permit Stop: continue discriminating checks within
the original budget.

## Human control

Native human transcript events control the existing task; CLI actor/text fields,
assistant messages and injected instructions cannot authorize a scope change.
Codex supports current `response_item` human messages and native async answers,
as well as legacy `event_msg` transcripts.

- `只診斷` / `diagnosis only`: investigate without product repairs. Non-success
  Stop requires a confirmed hypothesis supported by a current sealed baseline
  assertion FAIL for the original regression, or an existing runtime blocker/limit.
- `暫停` / `pause`: save progress and stop immediately. Native Codex `Interrupt`
  also pauses, with a three-second hook timeout; it never blocks or restarts an interrupt.
- `繼續` / `continue`: resume the same task and scope. An exhausted time budget
  still needs the existing native time grant; other blockers remain authoritative.
- `繼續修復` / `resume repair`: restore the full repair loop on the existing task.

Pauses retain evidence, consumed time and rounds, exclude waiting time, and do not
reset budgets. Diagnosis and pause cannot complete a repair task. Ambiguous free
text is not inferred as permission; use an explicit command above.

Use `task debug --task <id> --debug-action <action>`:

- `status` displays root-wide hypotheses, receipts and remaining state.
- `investigate --command-id <id>` runs a trusted configured verifier. Actual
  subprocess outcomes/time are recorded; reproduction-only work is not a fix round.
- `hypothesis --payload-file <json>` records `id`, `statement`, `method`,
  `expected`, `checkId`, `expectedStatus` (`PASS` or `FAIL`). Add `reference` to
  resolve it from actual sealed acceptance evidence. `--action investigate` may
  only run a declared unresolved behavioral red check; `--action observe` may
  only classify the current matching runtime `UNKNOWN` receipt as inconclusive.
  Neither action lets an agent assign a status. A rejected hypothesis needs a
  new reference and `reason`.
- `strategy --payload-file <json>` records a different `from`/`to` method,
  substantive `reason` and discriminating `reference`. Only one switch is allowed.
- `origin --payload-file <json>` declares where the bug came from once a
  hypothesis is confirmed: `{"kind": "escape-of", "commit": "<commit>", "label":
  "<earliest gate>"}` (optional `"receipt"`) or `{"kind": "pre-existing" |
  "external", "reason": "..."}`. It revises the contract, so re-verify and
  re-record the confirmed hypothesis before review; finish refuses
  `ESCAPE_ORIGIN_MISSING` without it. `escape-of` prints the link state and
  `git blame` hints and writes `.agent-ops-escapes/<task-id>.json`, which is
  committed with the fix (see `EVIDENCE-ESCAPE-001`). A surface label also
  needs a tracked `.agent-ops-escapes/rules/<rule-id>.json` rule that replays
  at the escaped commit, and a criteria/verify label needs `"promote":
  "<runnerId:checkId>"`; finish refuses `ESCAPE_RULE_UNPROVEN` otherwise (see
  `EVIDENCE-ESCAPE-002`).
- `checkpoint --session <id>` saves the current bound source/policy/stop cause.
- `resume --session <id>` recovers a matching owned worktree checkpoint. Mismatches
  require human confirmation and remain preserved; this command cannot waive them.
- `extend --session <native-id> --event-id latest` reads the current native human
  continue or resume-repair event. After time exhaustion it grants a full twenty
  minutes from that event, retaining consumed time and overrun in the grant snapshot
  without waiving any other blocker. No actor/text flag can
  authorize a grant. Missing native transcripts fail closed as unsupported.

Limits belong to the original root across revisions, children and sessions.
Repeating an active issue's text from a new session reattaches that root (or
resumes the worktree holding it) instead of starting a fresh budget. A
resolved hypothesis cannot return under a new id with the same statement and
method; reopen the original with new discriminating evidence.
Controlled investigation, verification and acquired review execution consume
active time; observable review-slot waiting is excluded. Claude, Codex, and agy
use their native session lifecycle to account foreground reasoning, tool use,
and edits. Accepted idle Stop closes the foreground clock. Rejected Codex Stop
keeps the clock running, including repeated Stop (`stop_hook_active: true`). OpenCode has no supported
foreground lifecycle and remains unsupported. Time between stopped turns is
paused. An interrupted unsealed operation remains blocked until its persisted process
identity proves death; only then is an UNKNOWN environment receipt sealed and
the elapsed interval retained.

Only changed product candidates followed by verification count toward repair
rounds. Test/fixture edits do not. New paired original-regression outcomes or
new discriminating hypothesis outcomes count as progress; renaming a task or
hypothesis does not. Two stagnant rounds require the strategy switch; two more
stop, subject to the global round/time ceilings.
The switch may cite this issue's own sealed regression evidence from an earlier
contract revision, because a scope revision stales current evidence while
verification stays stopped; hypotheses and delivery still need fresh evidence.
At the round limit the unchanged candidate may still be re-verified and
reviewed; only a changed product needs another round.

Success requires baseline assertion red and candidate green for the original
regression, required related checks, a supported confirmed hypothesis, and two
fresh independent reviews bound to the current source, contract, config and
meaningful DEBUG proof. Missing IDs, setup failure, skip, timeout and UNKNOWN
never prove reproduction. Proof changes invalidate review. Completed tasks and
worktree finish retain the existing attestation/integration requirements.

On Claude, agy and native Codex, Stop checks an active DEBUG issue even without Git net diff,
with or without the completion gate. Without the gate this check alone runs,
with one targeted task/config reload on a gate fault. A second failure emits an
explicit `UNKNOWN` / incomplete diagnostic with `agent-ops doctor` recovery,
permits non-success Stop and preserves the task, evidence and budgets. It never
attests completion or retries indefinitely.
A valid runtime stop checkpoint permits non-success Stop while retaining the
active task. `allow-stop` cannot waive DEBUG. Gates are never automatically
enabled for unsupported hosts: the generic Codex completion gate remains
unsupported, while its DEBUG-specific Stop uses native `decision: "block"`
with a continuation reason. `continue: false` would stop the harness and is not
used to continue DEBUG. OpenCode Stop is unsupported. This feature
persists foreground progress, and does not promise
execution after the native conversation closes. Native transcripts are trusted
host evidence, not protection against an attacker with the same filesystem
authority.

An explicit native human `no time limit` / `取消時間限制` instruction removes the
original issue time cap via the same native-only `extend --event-id latest`
authority. The grant records `grantedMs: null` and the spent snapshot; original
budget, consumption, prior grants, iteration limits and evidence gates remain.
Ordinary command and review stall timeouts remain in force.
