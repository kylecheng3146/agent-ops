# Loop Engineering Toolkit

Loop Engineering Toolkit is an evidence-driven development-loop toolkit for
Codex and Claude Code. It is designed to turn acceptance criteria, explicit
verification, safe lifecycle hooks, and independent review into a repeatable
engineering workflow.

This repository is in its foundation stage. The CLI, hook runtime, normative
specification, and installation profiles are being developed as a reviewable
pre-1.0 interface.

The CLI is published as `@kylecheng3146/agent-ops`. The current bootstrap
release is `0.0.1`; command behavior may change before 1.0.

## Quick start from npm

Requires Node.js `>=22.14.0`. Install the published CLI globally:

```bash
npm install --global @kylecheng3146/agent-ops@0.0.1
agent-ops --version
```

You can run it without a global install with `npx`:

```bash
npx --yes @kylecheng3146/agent-ops@0.0.1 --help
```

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

The commands after `init --yes` are post-apply operations; `doctor` may report
an unknown probe status until a repository-specific verification setup exists.

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

The `0.0.1` npm package is published as a pre-1.0 interface. Pin the package
version in automation when reproducibility matters; review release notes before
upgrading.

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
