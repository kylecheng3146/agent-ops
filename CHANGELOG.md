# Changelog

All notable changes to this unreleased project are documented here.

## [Unreleased]

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
