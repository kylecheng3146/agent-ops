# Loop Engineering Toolkit

Loop Engineering Toolkit is an evidence-driven development-loop toolkit for
agy, Codex, Claude Code, and opencode. It is designed to turn acceptance criteria, explicit
verification, safe lifecycle hooks, and independent review into a repeatable
engineering workflow.

This repository is in its foundation stage. The CLI, hook runtime, normative
specification, and installation profiles are being developed as a reviewable
pre-1.0 interface.

The CLI is published as `@kylecheng3146/agent-ops` as a pre-1.0 interface;
command behavior may change before 1.0.

## Executable acceptance and native goal runs (0.6.0)

Criteria can use `behavioral`, `invariant` or `review-only` acceptance contracts.
Behavioral proof requires each designated red check to fail by assertion on its
immutable baseline and every required check to pass on the candidate. Invariants
can pass on both versions. Review-only requirements still need two fresh reviews
against the original goal and an explicit `reviewOnlyReason` in the acceptance
contract. Legacy criteria keep their existing verifier behavior.

Configure and trust `verification.acceptanceRunners` in the repository. Tasks bind
stable check IDs and explicit committed test/fixture/helper materials; they cannot
override runner executables or arguments. Each version installs and builds its own
declared dependencies. Fixture errors, skipped/retried checks, incomplete output and
timeouts produce UNKNOWN. Review examines the checks themselves and every fallback.
`task revise`, `task replan` and `task pin-finding` preserve goal and evidence history;
`task status` and `doctor` distinguish mechanical coverage from review-only coverage.

On macOS, a trusted clean main checkout can start an isolated native goal run:

```sh
agent-ops run "Implement the requested behavior" --host codex --time-budget 60m --jobs 2
agent-ops run status <run-id>
agent-ops run logs <run-id>
agent-ops run respond <run-id> --question-id <id> --answer "Clarification"
agent-ops run stop <run-id>
agent-ops run resume <run-id>
```

`--host claude` uses Claude Code; `--wait` waits for a terminal or input state.
The coordinator counts toward the two writer slots. Native processes write only
under current leases in separate worktrees. Active time counts once across parallel
workers and continues through proof and integration; resume retains earlier usage
epochs. Missing token or cost counters remain unknown. Completion requires current
verification, two fresh reviews, completed tasks and a receipt bound to the target.
Setup runs in the background under registered process groups. Stop cancels native
writers, local verification and setup; interrupted setup requires explicit resume.
The coordinator can assess additional non-dangerous fixed commands through a
policy request. This authorization is bound to the run, runtime, lease and budget;
it creates no permanent repository trust. Policy transitions fence writers and
journal delivery imports and contract synchronization before starting new leases.
Native authorization decisions retain redacted command scope and rationale;
missing provider decisions remain unknown. Repair compares actual check outcomes
and outstanding finding pins rather than source fingerprints.

Native lifecycle reachability and framework probe conditions are recorded in
[the capability probe](docs/harness/native-goal-probe.md); these observations do not
establish external adoption or a reduction in review cost.

## Quick start from npm

Requires Node.js `>=22.14.0`. Install the published CLI globally:

```bash
npm install --global @kylecheng3146/agent-ops@latest
agent-ops --version
```

You can run it without a global install with `npx`. When the command runs in
an interactive terminal without arguments, it opens the setup wizard
automatically:

```bash
npx --yes @kylecheng3146/agent-ops@latest
```

Use `--help` for the complete command reference or provide explicit options in
automation. The wizard never writes files until you review and confirm its
installation plan.

The interactive multi-select screens start with no harness or profile selected.
Choose at least one of `agy`, `codex`, `claude`, and `opencode`, and at least one of
the `core`, `advisory`, `guardrails`, and `loop` profiles before confirming. For
scripted use, `--harness all` selects all four harnesses; comma-separated
selections such as `codex,opencode` are also supported. The legacy `both` value
remains an alias for `codex,claude`.

Preview a project installation before changing files:

```bash
agent-ops init \
  --dry-run --scope project --harness all --profile core --json
```

After reviewing the plan, apply it explicitly with `--yes`:

```bash
agent-ops init --scope project --harness all --profile core --yes
```

The remaining day-to-day checks are:

```bash
agent-ops trust status --json
agent-ops doctor --json
agent-ops config explain --json
agent-ops update --dry-run --json
agent-ops update --yes --json
agent-ops uninstall --dry-run --json
```

### Project-local loop

`loop` is an explicit, project-only profile for agy, Codex, and Claude Code.
agy installs its native `PreInvocation`, `PreToolUse(run_command)`, and optional
`Stop` subset directly in `.agents/hooks.json`, plus project routing in
`GEMINI.md` to `.agent-ops/GEMINI.md`; doctor reports its loop as
degraded because prompt, permission, compact, and subagent events are unavailable.
Claude Code supports native Windows through a generated PowerShell launcher;
Codex's loop launcher still requires POSIX-compatible `bash`. Preview it
first, then install only after reviewing the plan. `loop` also implies the
`core` baseline, so the project retains the managed rules and routing files:

```bash
agent-ops init --dry-run --scope project --harness codex,claude --profile loop --json
agent-ops init --scope project --harness codex,claude --profile loop --yes
```

For a project agy loop, the wizard recommends the hard completion gate. In
automation, opt in explicitly:

```bash
agent-ops init --scope project --harness agy --profile loop --completion-gate --yes
```

The gate lets pure Q&A, analysis, and read-only diagnostics stop normally. It
activates only after that conversation creates a Git-visible net change, then
requires an attached completed task with two to five criteria, current PASS
evidence, and a PASS review for the current source fingerprint. It never runs
tests or review from `Stop`. Error, max-step, and non-idle stops continue. A
user can approve one fingerprint-bound escape with
`agent-ops allow-stop --session <conversationId>`. Use
`agent-ops agy-run -- <agy arguments>` for a process-exit recheck in headless or
CI use. Codex, Claude Code, and OpenCode retain their existing non-blocking Stop
behavior in this release.

On native Windows, select `--harness claude` unless Codex is running in a
POSIX environment; the Codex loop still invokes `bash`.

It creates managed launchers per selected native host:

- Codex: `.codex/hooks/agent-ops-loop.sh`, `.codex/config.toml` when absent,
  `.codex/loop-goal.md`, `.codex/loop-state.md`, and
  `.codex/loop-telemetry.jsonl`.
- Claude Code: `.claude/hooks/agent-ops-loop.sh`,
  `.claude/hooks/agent-ops-loop.ps1`, `.claude/loop-goal.md`,
  `.claude/loop-state.md`, and `.claude/loop-telemetry.jsonl`.

The launchers delegate to one installed Node runtime; agent-ops does not copy
project-specific policy code into either hook directory. It adds an exact,
hash-commented `.gitignore` block for the goal, state, and telemetry files.
Those files and `.codex/config.toml` remain user-owned: update never overwrites
them, and uninstall keeps them while removing only launchers, hook handlers,
and the managed ignore block.

The loop registers `SessionStart`, `UserPromptSubmit`, `PreToolUse`,
`PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`,
`SubagentStart`, and `SubagentStop`; it intentionally does not register
`Stop`. On high-confidence matches, it blocks literal credential-shaped user
prompts or Bash commands, plus dangerous Bash commands such as broad recursive
deletion or `git reset --hard`. Codex uses its documented exit-code denial path; Claude Code
uses its documented native JSON denial shapes. Permission and escalation
requests are never auto-approved or denied by the loop, so the harness's normal
approval prompt remains authoritative.

Session context is bounded and derives from the redacted goal plus a telemetry
count. Telemetry records only timestamp, event, outcome, and rule code; it
never stores raw prompts, Bash commands, or credentials and is byte-rotated.
Before compaction, the loop writes a bounded, redacted Git-status snapshot into
its own block inside `loop-state.md`, preserving surrounding user text. This is
a guardrail, not a complete sandbox or a replacement for each harness's own
permissions. Review and trust the generated hook configuration in Codex and
Claude Code before use. An existing Codex `.codex/config.toml` with an explicit
`[features]` / `hooks = false` setting stops installation before any write.

Use `--scope user` with user-home installations. Keep `--dry-run` for any
operation you want to inspect before applying; non-interactive automation should
pass `--yes` only after reviewing the plan. Add `--json` when another tool will
consume the result. `update` operates on an existing managed installation. Pass
`--target-version <version>` when the target must be explicit or the command
must work without a registry lookup, for example:

```bash
agent-ops update \
  --harness opencode \
  --target-version 0.1.4 \
  --dry-run --json
```

## Quick start from a source checkout

For development or to run the repository version directly, use a source
checkout:

```bash
git clone https://github.com/kylecheng3146/agent-ops.git
cd agent-ops
npm ci
npm run build
node dist/packages/cli/src/bin.js --version
```

Preview a project installation before changing files:

```bash
node dist/packages/cli/src/bin.js init \
  --dry-run --scope project --harness all --profile core --json
```

After reviewing the plan, apply it explicitly with `--yes`. Confirmed
project-scope init/update automatically grants the displayed trust binding when
verification commands are configured; uninstall revokes it. Diagnostics and
manual trust management remain separate commands:

```bash
node dist/packages/cli/src/bin.js init --scope project --harness all --profile core --yes
node dist/packages/cli/src/bin.js trust status --json
node dist/packages/cli/src/bin.js doctor --json
node dist/packages/cli/src/bin.js config explain --json
node dist/packages/cli/src/bin.js update --dry-run --json
node dist/packages/cli/src/bin.js uninstall --dry-run --json
```

The `dist/...` path is relative to the source checkout. When testing from a
throwaway project, run the built CLI with its absolute checkout path (or use the
published `agent-ops` command); a new project does not contain its own `dist/`
directory. `update` also requires that the project already has a valid managed
`.agent-ops/manifest.json` created by `init`.

The commands after `init --yes` are post-apply operations. `doctor` reports
`UNKNOWN` for a probe that has nothing to verify yet: `repository-trust` when
no verification command exists, and `smoke-availability` until the
configuration declares one. Every non-`PASS` check carries a `remediation` string
explaining what, if anything, to do about it; text output prints it as an
indented `  → ` line, and `--json` exposes it as a field. `doctor` never
writes: it only reports what `agent-ops update` or `agent-ops trust grant`
would fix.

`doctor` exits non-zero only when a check `FAIL`s or names a specific
agent-ops command to run. `UNKNOWN`, `UNSUPPORTED`, and a `DEGRADED` check
with no such command (for example, a harness that only partially supports a
capability by design, such as opencode's `lifecycle-summary`) are permanent,
benign findings and exit 0 — there is nothing to fix.

`artifact-staleness` reports `DEGRADED` with `UPDATE_REQUIRED` when a toolkit
upgrade or effective profile or capability change makes intact managed rules
differ from the current baseline. Run `agent-ops update` to regenerate them.
Missing, altered, or hash-mismatched managed artifacts remain `FAIL` under
`artifacts`.

Installing the `advisory` or `guardrails` profile registers the lifecycle and
command-policy hooks implied by those profiles for the selected harnesses.
Claude Code and Codex use their native JSON settings files; opencode uses the agent-ops-owned
`.opencode/plugins/agent-ops.js` shim and never changes `opencode.json`. Only
agent-ops-owned handlers and artifacts are managed, foreign settings are
preserved, and `uninstall` removes exactly the content it registered. At user
scope, the opencode plugin is placed under
`.config/opencode/plugins/agent-ops.js`, or under the configured
`$XDG_CONFIG_HOME/opencode/` or `$OPENCODE_CONFIG_DIR/` when that location is
inside the managed user root. The shims call `agent-ops hook <harness> <event>`
through the installed absolute runtime path. Advisory failures remain
fail-open. Runtime-failure enforcement is deliberately narrow: Claude Code can
emit its documented `PreToolUse` denial shape for a classified invalid installed
configuration, and the managed OpenCode `tool.execute.before` plugin throws
its documented command-policy denial or unavailable-runtime error for its
supported Bash surface. Codex command policy is `unknown` and explicitly
non-enforcing for the ordinary `guardrails` profile. The project-local `loop`
profile uses its separate native hook policy described above. These are output
and plugin contracts, not proof that a host
honors a denial. Claude and Codex lifecycle summaries are `supported`; OpenCode's
app-scoped initialization is `degraded` rather than per-session coverage.

Claude's invalid-config fallback has four safeguards: only an invalid (not
absent) `.agent-ops/config.json` can reach it; a safely read manifest must list
the current harness; `AGENT_OPS_DISABLE=1` must not be set; and Claude's denial
reason names the config file with a repair or temporary shell-disable remedy.
`AGENT_OPS_DISABLE=1` is a human-shell recovery variable only. Agent-ops never
reads it from configuration, a manifest, or another file it writes. Every
`SessionStart` and `Stop` failure path remains fail-open.

`guardrails` enables command policy only; it does not imply Stop verification.
Stop verification is an explicit, disabled-by-default config feature. Enable it
only with confirmed commands, for example the relevant config fragment is:

```json
{
  "features": { "stopVerification": { "enabled": true } },
  "verification": {
    "commands": [
      {
        "id": "unit",
        "command": "npm",
        "args": ["test"],
        "cwd": ".",
        "required": true,
        "evidence": { "kind": "test-count", "minimum": 1 }
      }
    ]
  }
}
```

After changing Stop configuration, run `agent-ops update`; its approved plan
updates native registrations and the exact trust binding together. Stop is
report-only: `PASS`, `FAIL`, and `UNKNOWN` continue
the harness, emit bounded command evidence, and never complete a task.
Older configs migrate to config v3 with both Stop verification and the agy
completion gate disabled; migration invalidates the old trust binding.

The generated `AGENTS.md`, `CLAUDE.md`, and agy `GEMINI.md` routing blocks are supplemental: they
load the managed baseline while leaving project-specific instructions in those
files authoritative. Existing installations with the previous canonical
wording are migrated by `agent-ops update`; changed managed blocks still fail
closed.

### Rejected proposals and deliberate boundaries

The following proposals are deliberately rejected: emitting a model-visible
`SessionStart` advisory summary, inspecting user-authored Markdown link
integrity in `doctor`, and creating backups for agent-authored rule edits.
Transactional backups remain limited to agent-ops apply operations. Agent-ops
also does not add a git-workflow instruction to the generated baseline, which
stays project-neutral.

Dry-run plans keep harness settings writes opaque: human and JSON output expose
only the expected hash, content hash, and a safe summary. Use
`--hook-target <harness>=<surface-id>` when selecting a non-default discovered
surface; project-local Claude settings are never selected implicitly. The
internal plan still retains the complete merged settings for transactional
apply. The routing migration is one-way once applied; review the release notes
before attempting a downgrade.

For a full command reference, run `agent-ops --help`. The `task`, `verify`, and
`review` commands support acceptance tracking and independent verification when
the project configuration defines those workflows.

### External review

`agent-ops review --task <id> --yes` can hand a complete task-bound review to
agent CLIs, so the work is not judged only by the agent that produced it.
Enable review targets during `agent-ops init` (the default is off). Every task
criterion and its original description are reviewed; partial criteria,
generic reviews, and missing `--yes` are rejected. Current verification
evidence is required before any reviewer starts.

Each attempt uses a fresh temporary session and disposable repository clone, a
small allowlisted environment, and a target-native read-only mode. Claude
additionally uses its complete safe mode; Codex ignores user config and
persistence, while Agy runs in sandboxed plan mode. Codex and Agy preserve their
existing login environment, so their context isolation is intentionally weaker
than Claude's. `opencode` is not a review target.

Exactly two fresh sessions are planned. With three configured targets, the
explicit `AGENT_OPS_HOST` is excluded and `agy` is primary when available; with
two targets both run in configured order; with one target the same CLI is run
twice. The first session is the necessary review. Only its PASS starts the
second adversarial session, which receives the first full redacted report as
untrusted data. The first FAIL or NOT_RUN stops; a second FAIL is final FAIL,
and a missing second verdict is NOT_RUN. A same-target pair is still
independent because the sessions and clones are fresh.

Host network or loopback restrictions return `REVIEW_NOT_RUN` before any
reviewer is started. The managed instructions require a trusted outer host
runner to start the exact same command with both capabilities on its first
invocation; an in-sandbox retry is not an elevation. The result remains
`NOT_RUN` if that host is unavailable. There is no repository-level permission
bypass.
Reviewer attempts and preflight diagnostics remain visible in JSON. `--yes` is
required because a complete run spends provider quota twice.

After a complete PASS, the full redacted primary and adversarial reports are
stored privately under `.agent-ops/reviews/`; the source-fingerprint attestation
stores only the task, reviewer/session identities, report digests, and artifact
reference. Any artifact or attestation write failure is NOT_RUN, never PASS.

Authentication is diagnosed, never guessed:

```bash
agent-ops doctor              # presence only: no tokens, no network
agent-ops doctor --check-auth # one real print call per configured target
```

### Batch review

For writing subagents in separate worktrees, record each child's complete
modification intent at task creation (`--intent`), then commit and run its
local verifier. The coordinator runs `agent-ops task advance --task <parent-id>
--session <session-id> --yes` from the main checkout through the same trusted
outer host runner used for review. Advance integrates the committed children,
verifies every parent and child criterion on the integrated candidate, and
runs one two-round tree review. Only `NOT_RUN / scope-too-large` falls back to
per-task two-round reviews; FAIL requires a fix and a fresh final gate. A
passing gate saves the complete local receipt in `.git/agent-ops/receipts/`
before finish. A moved target gets at most one automatic rebase and repeat.
Run `agent-ops review show --task <parent-id>` from the main checkout to read
both full recorded reports for the latest candidate without invoking a reviewer.
`task advance` prints a short summary of nonblocking findings and residual risks.

`batch` remains the per-task review command for tasks already in one worktree.

A change split into subtasks needs one verify and one review per subtask.
`agent-ops batch --parent <task-id> --yes` runs them together for the parent's
active subtasks and the parent itself, instead of one `review` at a time:

```bash
agent-ops batch --parent <task-id> --yes --output batch.json
agent-ops batch --parent <task-id> --yes --base <ref> --parent-base <ref> --width 3
```

- Each task is verified and reviewed against its own base: `--base` for the
  subtasks and `--parent-base` for the parent, otherwise the base recorded by
  its last PASS review, otherwise the worktree base.
- A task that already has fresh PASS verification evidence skips verify. The
  rest are verified one at a time, and each task's review starts as soon as its
  own verify passes, so the next verify overlaps it. A task whose verify fails
  gets no review; the others continue.
- At most `--width` reviews run at once (default 2). A transient `NOT_RUN`
  (`probe-failed`, `stalled`, `timeout`, `quota-exhausted`,
  `network-unreachable`) lowers the width to 1 for the rest and earns that task
  one retry, alone, after the others finish. Other results are final.
- Each review target is probed once per batch while the probe succeeds; a
  failed probe is forgotten so the retry probes again.
- Nothing may commit or edit the worktree while it runs. HEAD is part of every
  fingerprint, so a change aborts the batch and reports the unfinished tasks
  as `aborted`.
- Exit code 0 means every task passed, 1 means a review or verify failed, and 2
  means the rest could not run and may be retried. The JSON envelope lists each
  task; the full reports stay under `.agent-ops/reviews/`.

`batch` is started exactly like `review`: through the trusted outer host runner
as its first and only invocation, with `--output` instead of a shell redirect.
`agent-ops init` and `update` pre-authorize it beside `review`.

See [Configuration](docs/en/guides/configuration.md) for the full contract.

## Project principles

- Define verifiable success before making changes.
- Treat command output and current filesystem state as evidence.
- Keep advisory automation separate from blocking guardrails.
- Preserve user configuration through managed, reversible updates.
- Support agy, Codex, Claude Code, and opencode without project-specific assumptions.
- Collect no network telemetry.

## Project status

A pre-1.0 npm package is published. Use `@latest` for the current release, or
pin a specific version in automation when reproducibility matters; review
release notes before upgrading.

Documentation:

- [English specification](docs/en/spec/README.md)
- [繁體中文規範](docs/zh-TW/spec/README.md)
- [English guides](docs/en/guides/quickstart.md)
- [繁體中文指南](docs/zh-TW/guides/quickstart.md)

## Community

- Read [CONTRIBUTING.md](CONTRIBUTING.md) before proposing a change.
- Report security issues according to [SECURITY.md](SECURITY.md).
- Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License

Copyright (c) 2026 Kyle Cheng. Released under the
[PolyForm Shield License 1.0.0](LICENSE): free to use, change and share,
including inside a company, but not to build a product or service that competes
with agent-ops. Versions up to 0.4.1 were released under, and remain under, the MIT License.
