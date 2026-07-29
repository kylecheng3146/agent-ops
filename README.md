# Loop Engineering Toolkit

Loop Engineering Toolkit is an evidence-driven development-loop toolkit for
Codex and Claude Code. It is designed to turn acceptance criteria, explicit
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

Preview a project installation before changing files:

```bash
agent-ops init \
  --dry-run --scope project --harness both --profile core --json
```

After reviewing the plan, apply it explicitly with `--yes`:

```bash
agent-ops init --scope project --harness both --profile core --yes
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

Use `--scope user` with user-home installations. Keep `--dry-run` for any
operation you want to inspect before applying; non-interactive automation should
pass `--yes` only after reviewing the plan. Add `--json` when another tool will
consume the result.

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
  --dry-run --scope project --harness both --profile core --json
```

After reviewing the plan, apply it explicitly with `--yes`. Trust, diagnostics,
updates, and removal are separate commands:

```bash
node dist/packages/cli/src/bin.js init --scope project --harness both --profile core --yes
node dist/packages/cli/src/bin.js trust status --json
node dist/packages/cli/src/bin.js doctor --json
node dist/packages/cli/src/bin.js config explain --json
node dist/packages/cli/src/bin.js update --dry-run --json
node dist/packages/cli/src/bin.js uninstall --dry-run --json
```

The commands after `init --yes` are post-apply operations. `doctor` reports
`UNKNOWN` for a probe that has nothing to verify yet: `repository-trust` until
`trust grant` runs, and `smoke-availability` until the configuration declares a
verification command.

Installing the `advisory` or `guardrails` profile also registers lifecycle
hooks in `.claude/settings.json` and `.codex/hooks.json`. Only agent-ops owned
handlers are added, foreign settings in those files are preserved, and
`uninstall` removes exactly the handlers it registered. The hooks call
`agent-ops hook <harness> <event>`, which always exits 0 so a toolkit failure
can never block the harness.

For a full command reference, run `agent-ops --help`. The `task`, `verify`, and
`review` commands support acceptance tracking and independent verification when
the project configuration defines those workflows.

## Project principles

- Define verifiable success before making changes.
- Treat command output and current filesystem state as evidence.
- Keep advisory automation separate from blocking guardrails.
- Preserve user configuration through managed, reversible updates.
- Support Codex and Claude Code without project-specific assumptions.
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
