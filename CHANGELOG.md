# Changelog

All notable changes to this unreleased project are documented here.

## [Unreleased]

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
