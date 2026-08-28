# Loop Engineering Specification

This is the normative English specification for bounded, evidence-driven work.

The harness adapter rules cover agy, Codex, Claude Code, and opencode. The
opencode integration is a generated local plugin; it does not manage
`opencode.json`. agy shares project `AGENTS.md` routing, uses native hooks, and
is explicitly degraded where its lifecycle surface is smaller than the full
loop.

Configuration is versioned independently from the manifest. Config v1 migrates
to config v2 with Stop verification disabled; changing the capability requires
a confirmed project `agent-ops update`, which also refreshes trust when
verifiers exist. Stop verification is
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
