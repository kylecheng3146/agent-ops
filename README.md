# Loop Engineering Toolkit

Loop Engineering Toolkit is an evidence-driven development-loop toolkit for
Codex, Claude Code, and opencode. It is designed to turn acceptance criteria, explicit
verification, safe lifecycle hooks, and independent review into a repeatable
engineering workflow.

This repository is in its foundation stage. The CLI, hook runtime, normative
specification, and installation profiles are being developed as a reviewable
pre-1.0 interface.

The CLI is published as `@kylecheng3146/agent-ops` as a pre-1.0 interface;
command behavior may change before 1.0.

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
Choose at least one of `codex`, `claude`, and `opencode`, and at least one of
the `core`, `advisory`, `guardrails`, and `loop` profiles before confirming. For
scripted use, `--harness all` selects all three harnesses; comma-separated
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

`loop` is an explicit, project-only profile for Codex, Claude Code, or both.
It requires a POSIX-compatible `bash`; the generated native launchers are
`.sh` files, so Windows is not currently a supported loop host. Preview it
first, then install only after reviewing the plan. `loop` also implies the
`core` baseline, so the project retains the managed rules and routing files:

```bash
agent-ops init --dry-run --scope project --harness codex,claude --profile loop --json
agent-ops init --scope project --harness codex,claude --profile loop --yes
```

It creates one small managed launcher per selected native host:

- Codex: `.codex/hooks/agent-ops-loop.sh`, `.codex/config.toml` when absent,
  `.codex/loop-goal.md`, `.codex/loop-state.md`, and
  `.codex/loop-telemetry.jsonl`.
- Claude Code: `.claude/hooks/agent-ops-loop.sh`, `.claude/loop-goal.md`,
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

After reviewing the plan, apply it explicitly with `--yes`. Trust, diagnostics,
updates, and removal are separate commands:

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
`UNKNOWN` for a probe that has nothing to verify yet: `repository-trust`
until `trust grant` runs (only actionable once `verification.commands` is
configured — a project that never runs verification has nothing for trust
to unlock), and `smoke-availability` until the configuration declares a
verification command. Every non-`PASS` check carries a `remediation` string
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

After changing Stop configuration, run `agent-ops update` so native
registrations match the config, then `agent-ops trust grant` to bind the
current config. Stop is report-only: `PASS`, `FAIL`, and `UNKNOWN` continue
the harness, emit bounded command evidence, and never complete a task.
Config v1 migrates to config v2 with Stop disabled; migration invalidates the
old trust binding, and pre-v1 binaries cannot read the migrated config.

The generated `AGENTS.md` and `CLAUDE.md` routing blocks are supplemental: they
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

`agent-ops review` can hand the review to another agent CLI, so the work is not
judged by the agent that produced it. Enable it during `agent-ops init` (the
default is off). Reviews require an attached task, current required
verification evidence, and a deterministic worktree (or `--base`) scope. The
native-schema detailed report is displayed but not persisted.

Each attempt uses a fresh temporary cwd, a small allowlisted environment, and a
target-native read-only/context-isolation mode. Currently only Claude safe mode
meets the full isolation contract; configured Codex and Agy entries return
`capability-unavailable` rather than run with a weaker boundary. `opencode` is
not a review target.

The first target that actually runs produces the verdict. A `FAIL` is final:
the chain never retries elsewhere after a real verdict. `--yes` is still
required for every run, since each run spends another provider's quota.

Authentication is diagnosed, never guessed:

```bash
agent-ops doctor              # presence only: no tokens, no network
agent-ops doctor --check-auth # one real print call per configured target
```

See [Configuration](docs/en/guides/configuration.md) for the full contract.

## Project principles

- Define verifiable success before making changes.
- Treat command output and current filesystem state as evidence.
- Keep advisory automation separate from blocking guardrails.
- Preserve user configuration through managed, reversible updates.
- Support Codex, Claude Code, and opencode without project-specific assumptions.
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

Copyright (c) 2026 Kyle Cheng. Released under the [MIT License](LICENSE).
