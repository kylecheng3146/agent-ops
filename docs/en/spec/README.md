# Loop Engineering Specification

This is the normative English specification for bounded, evidence-driven work.

The harness adapter rules cover Codex, Claude Code, and opencode. The opencode
integration is a generated local plugin; it does not manage `opencode.json`.

Configuration is versioned independently from the manifest. Config v1 migrates
to config v2 with Stop verification disabled; changing the capability requires
`agent-ops update` followed by `agent-ops trust grant`. Stop verification is
explicit, trusted, report-only, and never completes a task. Dry-run plans keep
foreign settings opaque, and the routing migration is one-way once applied.

- [Loop engineering](./loop-engineering.md)
- [Acceptance and evidence](./acceptance-and-evidence.md)
- [Judgment](./judgment.md)
- [Delegation](./delegation.md)
- [Review](./review.md)
- [Troubleshooting](./troubleshooting.md)
- [Guardrails](./guardrails.md)
- [Maintenance](./maintenance.md)
- [Harness adapters](./harness-adapters.md)
