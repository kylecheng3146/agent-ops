# Changelog

All notable changes to this unreleased project are documented here.

## [Unreleased]

## [0.2.7] - 2026-09-22

- Review now records what each round cost: prompt bytes, wall-clock duration
  and the token usage each target already reports in its own transport
  envelope. A target that reports none is recorded as unknown rather than
  given an invented number. One chain on this repository measured 0.7-1.5M
  tokens over five to eight minutes, which had previously been a structural
  guess with no measurement behind it.
- An authorized review whose source fingerprint, task, review policy and
  verification evidence all still match a recorded PASS now completes from
  that evidence without invoking a reviewer. `--rerun` forces a fresh chain.
  Every other check runs first, so a policy change or a verification failure
  recorded after the review still stops the command.
- One absolute deadline now covers the whole execution: target preflight, the
  capability probe, the repository snapshot and both rounds. It is recomputed
  before each subprocess rather than captured once, the authentication probe
  keeps its own shorter ceiling, a verdict that lands after the deadline is
  not accepted, and a reviewer that keeps emitting heartbeats is still cut
  off. Previously each round held a full timeout and preflight held none.
- A `--base` review now sends the resolved base commit to both rounds with an
  explicit range diff, and the executor confirms that commit exists inside the
  snapshot. A committed range previously reached the reviewer as an empty
  worktree diff, so a PASS could be returned for a range nobody had seen.
- Task state is restored after compaction. `SessionStart` branches on its
  `source`: a compaction receives the checkpoint, a resumed transcript
  receives nothing, and a fresh or cleared session is offered the previous
  task rather than handed its contents. Required fields are never truncated,
  and every interpolated task string passes the existing guardrail and
  redaction before it is shortened.
- `SessionStart` records the session id the host tells it, so
  `agent-ops task attach` works in a session that was never told its own
  identifier.

## [0.2.6] - 2026-09-18

- `COMPLETION_GATE_TASK_REQUIRED` now names the session and the commands that
  clear it. The block previously read only "Attach this conversation to a formal
  task", and an agent that had never been told the session id could not attach,
  so the only exit was a one-time permit. The remedy now carries `task create`
  with the two-to-five criteria the schema demands and `task attach --session`,
  shell-quoted because a session id may contain shell metacharacters. It omits
  `allow-stop` on purpose: naming the escape hatch in the block invites routing
  around the gate instead of through it.
- The reviewer-interrupt end-to-end test no longer reads a half-written pid
  file. Polling `existsSync` alone could observe the path before the fake
  reviewer's pid landed, and `Number("")` is 0, so the survival check signalled
  the test's own process group and could never see ESRCH. Under parallel suite
  runs this failed reproducibly. The poll now waits for a positive integer.

## [0.2.5] - 2026-09-18

- `agent-ops task attach` now accepts a completed task and rejects only an
  archived one. The completion gate requires the session to be attached to a
  completed task, so refusing attachment after completion left "complete, then
  attach" unrecoverable and forced a one-time permit.

- Managed rules now tell the agent when and how to delegate a subtask to a
  subagent, naming the native mechanism per harness (Task tool on Claude Code,
  `invoke_subagent` on agy, the harness task tool or sequential steps on
  AGENTS.md harnesses), and state the one-writer-per-worktree constraint that
  `agent-ops verify` and `agent-ops review` fingerprinting imposes. New spec
  rule `DELEGATE-ISOLATION-001` records the constraint.

## [0.2.4] - 2026-09-17

- Managed review instructions now require the trusted host handoff before the
  first review invocation when network or loopback capability is restricted,
  so a sandboxed attempt is not spent before the elevated run. The CLI still
  fails closed as `REVIEW_NOT_RUN / host-required` when no such host is
  available.

## [0.2.2] - 2026-09-16

- The completion gate no longer deadlocks on a clean worktree. Work that is
  committed leaves nothing for the worktree fingerprint to measure, so `verify`,
  `review` and `task complete` are run with `--base`; the gate now records that
  base on the completed task and recomputes the same range at Stop instead of
  demanding worktree evidence that can never exist. The range is recomputed, not
  trusted: evidence for a range that no longer ends at HEAD still fails.
- The command-policy guardrail reads the commands it used to skip. One
  quote-aware pass now decides what is structure and what is text: `$VAR` and
  `${VAR}` are ordinary word characters, `$(...)` and backtick substitutions are
  parsed and policed as commands of their own rather than abandoning the whole
  line, a subshell contributes its commands, and a quoted `)` or `<<EOF` is
  text. A heredoc body is data, not commands — but an unquoted delimiter
  expands its body, so the substitutions in one are policed while its literal
  text is not. Unreadable input — an unterminated heredoc, quote or
  substitution — is still reported as unsupported and still allowed.
- Claude no longer shows an advisory PreToolUse line with nothing to act on.
  `HOOK_EVENT_UNSUPPORTED` fired on every command the old parser could not read,
  and a hook that talks constantly about commands it allowed is a hook whose
  refusals get skimmed. A PreToolUse result carrying a remedy still speaks, as
  does every other event.

## [0.2.1] - 2026-09-16

- A review stopped by the task's own verification evidence now says what to run
  next. `stale-verification`, `missing-verification-evidence`,
  `unreadable-verification-evidence` and `verification-not-passed` each print
  `agent-ops verify --task <id>` with the task that owns the evidence, and the
  stale case says outright that the source moved after the evidence was
  recorded — any edit to a changed file after the verifier ran, including a
  document a later step rewrote, voids it. `verification-not-passed` names the
  verifier alone: its evidence records a failure, so it says to fix that first
  and never invites another review. Previously the run ended on the bare reason
  line, and the caller re-ran the review it had just been refused.

## [0.2.0] - 2026-09-15

- Independent review abandons a reviewer that produces no output for 90 seconds
  and reports `stalled`, instead of waiting out the full 15-minute timeout on
  each target. Progress bytes on either stream and growth of the target's own
  log file both count as a heartbeat, so a slow reviewer is never cut off. The
  remediation names the host sandbox rather than authentication: escalating
  permission and retrying does not revive a stalled reviewer.
- The completion gate now enforces on Claude Code as well as agy. Enabling
  `features.completionGate.enabled` and running `agent-ops update` installs a
  gated Claude Stop hook that refuses a stop with Claude's own blocking
  decision, and the one-time `allow-stop` permit is surfaced as a
  `permissionDecision: ask` so an agent still cannot authorize its own stop.
  Claude's Stop payload is mapped onto the gate's contract: `session_id` keys
  the per-session baseline, a Stop is the equivalent of agy's `model_stop`, and
  Claude's recursion marker is the not-yet-idle case the gate lets through. A
  dispatch exception on a gated Claude Stop fails closed rather than returning
  empty output. Under the loop profile the gate also registers its own
  SessionStart and PreToolUse handlers beside the loop launcher's, which runs a
  different process: without them the gate never records a baseline and never
  sees the `allow-stop` it must put to the user.
  codex and opencode remain advisory: measured here, codex never fires its Stop
  hook under `codex exec` and rejects `permissionDecision: ask`, and opencode's
  plugin can only deny a tool call, never a stop.
- `doctor` no longer reports an installation whose Stop hook carries
  `--completion-gate` as unmanaged. The probe matched the whole command tail as
  one string, so enabling the project loop produced an `UPDATE_REQUIRED` that
  `agent-ops update` could never clear — update installs exactly the command
  being rejected.
- agy is told to answer the review instead of planning the work. Its only
  read-only mode is plan mode, whose default job is to write an implementation
  plan and ask whether to proceed; under `--print` that question ends the one
  turn it gets, and the review came back empty after minutes of work.
- An installation that ends with no verification command now says so. `init`
  warns at the moment of install — naming the discovery decision that stopped
  detection — and `doctor` reports a `verification-commands` check, because a
  loop with no required verifier can never complete a task and previously
  reported itself entirely healthy.
- A task carrying a recorded verification failure makes review report
  `verification-not-passed` instead of `stale-verification`. The old label sent
  the caller to re-run the verifier that had just failed.
- Review asks what the surrounding host withholds before it spends the target
  chain. A host that declares no network (`CODEX_SANDBOX_NETWORK_DISABLED=1`)
  ends the review immediately as `host-sandboxed` without invoking a single CLI;
  a host that merely refuses a loopback listener runs the targets that need one
  last instead of first. `doctor` reports the same restriction as its own
  `host-sandbox` check, so a sandboxed CLI's "not logged in" is no longer read
  as a credential problem.
- `task complete` with no `--evidence` now uses the references the task already
  carries, instead of refusing until the caller copies them back out of the task
  store. Supplied references are still unioned with the recorded ones, so naming
  less evidence can never drop any; a task with no recorded evidence is still
  refused.
- `agent-ops <command> --help` now prints that command's own usage, including
  the `--criterion` JSON shape, instead of failing as a conflicting action.
  `--version` still cannot be combined with a command.

## [0.1.24] - 2026-09-07

- Breaking: Project init/update now ignores task/review runtime output on every harness and
  profile. Indexed runtime files and staged runtime removals fail closed with
  recovery instructions instead of allowing self-invalidating fingerprints.
  Untrack runtime files and commit staged removals before verifying/reviewing.
- Completion performs expensive validation outside the task lock, then compares
  the task snapshot and rechecks descendants under the lock before writing.
  Concurrent task changes are preserved and require retrying completion.

- Breaking: `task complete` now requires a Git change scope, current required-verifier
  evidence, a whole-task review attestation, and completed descendants on every host.
  Legacy tasks without a config baseline or valid evidence must be recreated and
  verified/reviewed. Runtime callers must supply `TaskServiceOptions.completion`.
- Added `task complete --base` and enabled `verify --base` for committed ranges.
  Use the same base for verify, review and completion; the agy Stop gate still uses
  worktree-scoped evidence.
- Required verifiers declared by task criteria now run even when path mappings
  select a narrower set. Completion preserves recorded evidence, rejects invalid
  references and cannot replace a newer failure with an older PASS.
- Parent completion checks all descendants under the task-state lock. Archiving
  unfinished children does not satisfy completion, and completed parents cannot
  accept new subtasks.
- Trust grants are scoped by canonical worktree path, so trusting a second clone
  of the same remote no longer revokes the first clone's independent grant.
- Ignore generated `.agents/hooks.json` registration state in this repository.

## [0.1.22]

- Fixed independent review observability and lifecycle handling. Explicit
  `--harness` selection now runs one configured reviewer, JSON output keeps
  stdout machine-readable while progress goes to stderr, and interruptions
  terminate the reviewer process tree without writing a false attestation.
- Added planned reviewer ordering, explicit target validation, timeout versus
  capability diagnostics, and English/Traditional Chinese review guidance.

## [0.1.21]

- Added agy hard completion gating with mandatory review evidence and a
  one-time explicit stop allowance for exceptional exits.
- Added config schema v3, native project `GEMINI.md` routing, headless `agy-run`,
  and lifecycle-aware docs, migration, doctor, and test coverage.

## [0.1.20]

- Added first-class agy harness integration, including native rules, hooks,
  doctor probes, degraded loop support, Windows command handling, and
  selective uninstall that preserves other harnesses.
- Review now prefers a different CLI in a fresh disposable clone, records
  `sessionIsolation: "fresh"`, renders same-target self-review as degraded,
  and treats malformed reviewer output as `NOT_RUN` with bounded diagnostics.

- A passing independent review is now handed to a second, different target
  asked to refute it. A successful refutation makes the run `FAIL` and keeps
  both reports; the challenge appears as `adversarial` in JSON and in the
  rendered report. With only one usable target the primary verdict stands, and
  the host target is never used as the challenger.
- `agent-ops task create --parent <task-id>` records a subtask and
  `agent-ops task status --parent <task-id>` lists a task's subtasks. Subtasks
  keep their own criteria, verification, and review; completing one never
  completes its parent. Task state written before this release still loads.
- Review attempts now carry the target's own redacted complaint as
  `diagnostic`, so a rejected call is distinguishable from a missing login in
  JSON output and not only in progress text. The capability gate names the
  help-output flags it could not find, and an adversarial challenger that never
  ran is recorded on the attempt list rather than only reported.
- `agy` review now passes its prompt as the value of `--print` instead of
  letting a bare `-p` consume the next flag. It runs in sandboxed plan mode,
  operates on a disposable repository clone, remains in the default target
  chain, and never receives
  `--dangerously-skip-permissions`.
- Fixed: `claude` could not review on an interactively authenticated install.
  Its credential home was replaced and `USER` was absent from the reviewer
  environment, so it reported "not logged in". Isolation now rests on
  `--safe-mode`, which disables user customization while keeping auth. The
  schema handed to a reviewer also drops its `$schema` declaration, which
  claude rejected outright.
- Fixed: bounded command output kept its head rather than its tail, discarding
  the trailing summary line that carries the test count. A suite whose output
  exceeded the limit could never produce `test-count` evidence.

## [0.1.16]

- `agent-ops review` now runs configured Codex and Agy targets with their
  native read-only modes instead of skipping them for incomplete context
  isolation. Existing login state is preserved, Codex ignores user config and
  persistence, and Agy disables slash-command expansion.
- Review fallback now continues after any attempt that produces no valid
  verdict, including login failures, oversized output, and unparseable output.
  Human and JSON results include the ordered `attempts` and their reasons;
  `PASS` and `FAIL` remain terminal. The default per-target timeout is now five
  minutes so full Codex reviews are not constrained by the lightweight probe's
  two-minute budget.
- Managed rules invoke `agent-ops review --yes`, so completion review is
  actually authorized, and private-state reads avoid redundant `chmod` calls
  while still repairing unsafe permissions when needed.

## [0.1.14]

- **Fix:** the managed `claude-routing` block in `CLAUDE.md` now uses Claude
  Code's `@.agent-ops/CLAUDE.md` import syntax instead of prose. The previous
  wording ("Load `.agent-ops/CLAUDE.md` as the agent-ops managed baseline")
  was inert in Claude Code, so the baseline was never loaded. The old body is
  registered as legacy, so `agent-ops update` migrates existing projects in
  place without touching surrounding user text. Codex/`AGENTS.md` routing is
  unchanged.

## [0.1.10]

- **Behavior change:** `agent-ops doctor` now exits non-zero only when a
  check `FAIL`s or names a specific agent-ops command to run (its `code`
  field). Previously any `UNKNOWN`, `UNSUPPORTED`, or `DEGRADED` status
  forced exit 1 — including permanently benign findings like
  `smoke-availability` on a project with no configured verification, or
  opencode's descriptor-declared `DEGRADED` `lifecycle-summary`. A doctor
  invocation that used to always fail on an otherwise healthy install will
  now correctly succeed. Scripts that relied on doctor's exit code as a
  generic "everything is PASS" gate should check `report.checks` directly if
  they need that stricter behavior.
- `repository-trust` reports `UNKNOWN` with no actionable code when
  `verification.commands` is empty — trust is only required to unblock Stop
  verification, so an install that never configured verification has nothing
  for `trust grant` to unlock. It still fails, unconditionally, when the
  binding is `STALE`.
- `review-targets` no longer carries `UPDATE_REQUIRED`; its fixes (`<target>
  login`, installing the executable, or editing `reviewRoles[].targets`) were
  never `agent-ops update` and now live in `remediation` instead.
- Added `remediation` to every non-`PASS` doctor check: a plain-string
  explanation of what to do, or that nothing needs to be done. Text output
  prints it as an indented `  → ` line; `--json` exposes it as a field.
- Added `reason` to `HarnessSurfaceStatus` for surfaces outside the
  installation root or optional files agent-ops never writes, so
  `surface-inventory`'s `Surfaces:` listing explains itself instead of
  reading as an unexplained fault.

## [0.1.7]

- `agent-ops review` now spawns a real independent reviewer. Previously it
  always reported `NOT_RUN / missing-cli` because no executor existed.
- Added the optional `reviewRoles` configuration field (still
  `schemaVersion: 2`) holding an ordered fallback chain of review target CLIs:
  `codex`, `agy` (Antigravity), and `claude`. Absent means disabled, which is
  also the default for `agent-ops init` and for the new repeatable
  `--review-target` flag.
- Every target is launched with its own read-only flag, and a target without
  one is skipped rather than run unsandboxed. `opencode` is therefore not a
  review target: its `--agent plan` is rejected as a subagent and silently
  falls back to a writable agent.
- The chain advances only when no review happened (missing executable, failed
  spawn, or timeout — 120s per target by default). A `FAIL` verdict is
  terminal, so the chain can never shop for a passing review.
- Responses that break the reply contract are reported as
  `NOT_RUN / unparseable-output` instead of `FAIL`, keeping `FAIL` to mean the
  reviewer looked and judged the work inadequate.
- Review criteria now carry their real descriptions and verifier ids from the
  bound task; a review with no task context reports
  `NOT_RUN / no-task-context` rather than reviewing criterion ids. Results are
  appended to the active task's evidence with a `review:<target>:` prefix, and
  a completed task is never rewritten.
- When Claude Code is the host, `claude` is moved to the end of the chain; it
  still runs as a last resort with a `reviewer == host` warning.
- Added the `review-targets` doctor check. It verifies executable presence with
  no tokens and no network by default; the new `--check-auth` flag adds one real
  print call per target. `--yes` remains inert for doctor.
- `agent-ops init` asks whether to enable external review (defaulting to no)
  and probes each selected target for authentication. A failed probe warns and
  never blocks the installation; the non-interactive path never probes.

## [0.1.6]

- Added the opt-in, project-local `loop` profile for Codex and Claude Code. It
  installs small Bash launchers backed by the shared runtime, safely seeds
  user-owned loop state, and registers the supported lifecycle hooks.
- Added high-confidence interception for literal secrets and destructive Bash
  commands in the project loop, while preserving native approval flows and
  fail-open behavior for malformed or advisory events.
- Added `doctor` artifact-staleness reporting. It identifies managed artifacts
  that predate the current toolkit or configuration as `DEGRADED` with
  `UPDATE_REQUIRED`, and directs users to run `agent-ops update`.
- Documented the generic loop setup, lifecycle boundaries, and Codex/Claude
  hook configuration.

## [0.1.5]

- Wired real advisory SessionStart dispatch and explicit Stop verification through
  the hook process. Stop is disabled by default, requires current repository
  trust and configured commands, emits bounded report-only evidence, and never
  completes a task. Config v1 migrates to config v2 and requires one
  `agent-ops trust grant`; the manifest remains schema v2. Claude and Codex
  lifecycle support is `supported`, OpenCode is `degraded`, and Codex command
  blocking remains `unknown`.

- Changed the harness selection from a single value to a list. `--harness` now takes a comma-separated list (`--harness codex,claude`) or one of the aliases `all` and `both`; `both` keeps its old meaning of codex plus claude. The interactive wizard asks for harnesses as a multi-select with a select-all entry instead of a single choice.
- Changed the installation manifest to store `harness` as a list, on its own `schemaVersion` 2. Config, task, and evidence documents stay at version 1. A manifest written by an earlier release is migrated when it is read, and rewritten in the new shape the next time `init` or `update` writes it.
- Replaced the two-harness branching in installation, hook registration, hook dispatch, ownership checks, and doctor probes with a harness registry, so each harness carries its own instruction file, hook path, and settings handling.
- Removed `runtime/src/review/claude-runner.ts` and `runtime/src/review/codex-runner.ts`, which only forwarded to `runIndependentReview`. `agent-ops review` now rejects a multi-harness selection explicitly rather than silently reducing it.

- Fixed Codex hook registration to invoke an absolute runtime path instead of the bare `agent-ops` command. The previous form was resolved through `PATH`, so a cloned repository could shadow it via `node_modules/.bin` and run arbitrary code on every hook event. Codex now matches Claude, which already used an absolute path. This replaces the earlier deliberate choice of PATH-relative commands for portability: an absolute path is regenerated on every `init` and `update`, so portability is recovered by re-running the installer rather than by trusting `PATH`.
- Changed `doctor` to treat a legacy PATH-resolved Codex handler as unregistered, so an affected installation reports the need to run `agent-ops update`. Running `update` replaces the legacy handler rather than leaving it in place.

## [0.1.4]

- Added an interactive init wizard with selectors for scope, harness, and multi-select profiles, including descriptions and a select-all option.
- Added an interactive postinstall flow for direct package installs, while skipping CI and non-direct dependency installs.
- Included configured hooks in install plans and successful installation messages.

## [0.1.3]

- Added a banner and an arrow-key Yes/No selector to interactive `init`, `update`, `uninstall`, and `trust grant` confirmations. Decorative only: skipped for `--json`, non-interactive runs, and narrow terminals, with no runtime dependency added.
- Fixed a Windows-only flake where private-state locks failed because a cold PowerShell start exceeded the process identity timeout.
- Added hook registration to `init` and `update`, writing agent-ops owned handlers into `.claude/settings.json` and `.codex/hooks.json` for profiles that enable lifecycle capabilities.
- Added the `agent-ops hook <harness> <event>` runtime entry point and a Claude hook entry script, both fail-open.
- Added hook removal to `uninstall`, which strips only owned handlers and preserves foreign settings.

## [0.1.2]

- Fixed filesystem identity snapshots to preserve 64-bit Windows file indexes exactly.

## [0.1.0]

- Added cross-platform CI coverage for macOS, Linux, and Windows across the supported Node matrix.
- Added a protected, dispatch-only release workflow prepared for npm trusted publishing.
- Added installed-package smoke checks, issue forms, pull request evidence requirements, and release policy tests.
- Added source-checkout quick-start and CLI usage documentation.
