# Loop Engineering Toolkit

Loop Engineering Toolkit is an evidence-driven development-loop toolkit for
Codex and Claude Code. It is designed to turn acceptance criteria, explicit
verification, safe lifecycle hooks, and independent review into a repeatable
engineering workflow.

This repository is in its foundation stage. The CLI, hook runtime, normative
specification, and installation profiles are being developed in a reviewable
feature branch before the first pre-1.0 release.

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

## Community

- Read [CONTRIBUTING.md](CONTRIBUTING.md) before proposing a change.
- Report security issues according to [SECURITY.md](SECURITY.md).
- Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License

Copyright (c) 2026 Kyle Cheng. Released under the [MIT License](LICENSE).
