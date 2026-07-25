# Loop Engineering Toolkit

Loop Engineering Toolkit is an evidence-driven development-loop toolkit for
Codex and Claude Code. It is designed to turn acceptance criteria, explicit
verification, safe lifecycle hooks, and independent review into a repeatable
engineering workflow.

This repository is in its foundation stage. The CLI, hook runtime, normative
specification, and installation profiles are being developed in a reviewable
feature branch before the first pre-1.0 release.

The current CLI is an unreleased development interface. Its packed artifact is
checked by `npm run package:check`; command behavior may change before the first
tagged pre-1.0 release.

## Quick start from a source checkout

The package is private and has not been published to npm. Use a checkout for
now:

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
node dist/packages/cli/src/bin.js trust status --json
node dist/packages/cli/src/bin.js doctor --json
node dist/packages/cli/src/bin.js update --target-version 0.0.1 --dry-run --json
node dist/packages/cli/src/bin.js uninstall --dry-run --json
```

Use `--scope user` with user-home installations. Do not copy the development
version into a global npm install; wait for a tagged release and its published
package instructions.

## Project principles

- Define verifiable success before making changes.
- Treat command output and current filesystem state as evidence.
- Keep advisory automation separate from blocking guardrails.
- Preserve user configuration through managed, reversible updates.
- Support Codex and Claude Code without project-specific assumptions.
- Collect no network telemetry.

## Project status

No npm package has been published yet. Do not depend on the current repository
as a stable interface until a tagged release is available.

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
