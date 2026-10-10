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
- `checkpoint --session <id>` saves the current bound source/policy/stop cause.
- `resume --session <id>` recovers a matching owned worktree checkpoint. Mismatches
  require human confirmation and remain preserved; this command cannot waive them.
- `extend --session <native-id> --event-id latest` reads the current native human
  continue event. It grants exactly twenty additional minutes once, only after
  time exhaustion and without waiving any other blocker. No actor/text flag can
  authorize a grant. Missing native transcripts fail closed as unsupported.

Limits belong to the original root across revisions, children and sessions.
Controlled investigation, verification and acquired review execution consume
active time; observable review-slot waiting is excluded. Claude, Codex, and agy
use their native session lifecycle to account foreground reasoning, tool use,
and edits. Codex Stop remains advisory for completion-gate purposes, but an
accepted idle Stop is still a trusted clock boundary. OpenCode has no supported
foreground lifecycle and remains unsupported. Time between stopped turns is
paused. An interrupted unsealed operation remains blocked until its persisted process
identity proves death; only then is an UNKNOWN environment receipt sealed and
the elapsed interval retained.

Only changed product candidates followed by verification count toward repair
rounds. Test/fixture edits do not. New paired original-regression outcomes or
new discriminating hypothesis outcomes count as progress; renaming a task or
hypothesis does not. Two stagnant rounds require the strategy switch; two more
stop, subject to the global round/time ceilings.

Success requires baseline assertion red and candidate green for the original
regression, required related checks, a supported confirmed hypothesis, and two
fresh independent reviews bound to the current source, contract, config and
meaningful DEBUG proof. Missing IDs, setup failure, skip, timeout and UNKNOWN
never prove reproduction. Proof changes invalidate review. Completed tasks and
worktree finish retain the existing attestation/integration requirements.

An installed Claude/agy completion gate checks DEBUG even without Git net diff.
A valid runtime stop checkpoint permits non-success Stop while retaining the
active task. `allow-stop` cannot waive DEBUG. Gates are never automatically
enabled for unsupported hosts: Codex Stop is advisory for completion but still
closes its foreground clock; opencode Stop is unsupported. This feature
persists foreground progress, and does not promise
execution after the native conversation closes. Native transcripts are trusted
host evidence, not protection against an attacker with the same filesystem
authority.
