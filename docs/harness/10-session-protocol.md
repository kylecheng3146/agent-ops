# Session protocol

Routing table only. Read one entry when its trigger fires; do not preload the
whole playbook.

`.agent-ops/CLAUDE.md` and `.agent-ops/AGENTS.md` already carry the managed
loop rules and are loaded automatically. This file routes to the normative
specification, which is not loaded automatically.

| When | Read |
| --- | --- |
| Defining acceptance criteria, or deciding what counts as evidence | [Acceptance and evidence](../en/spec/acceptance-and-evidence.md) |
| Unsure whether a change is in scope, or which of two readings to take | [Judgment](../en/spec/judgment.md) |
| Handing a bounded subtask to a subagent | [Delegation](../en/spec/delegation.md) |
| Running or interpreting `agent-ops review` | [Review](../en/spec/review.md) |
| A hook, gate, or verifier behaves unexpectedly | [Troubleshooting](../en/spec/troubleshooting.md) |
| A command is blocked, or secret-shaped content is involved | [Guardrails](../en/spec/guardrails.md) |
| Changing installed harness files, config, or trust records | [Maintenance](../en/spec/maintenance.md) |
| Working on adapter support, hook registration, or host differences | [Harness adapters](../en/spec/harness-adapters.md) |
| Needing the loop's overall shape | [Loop engineering](../en/spec/loop-engineering.md) |

Known harness risks and their proposed repairs: [harness risk baseline](./00-harness-risk-baseline.md).

Traditional Chinese mirrors of every specification file live in
`docs/zh-TW/spec/`.

Revalidate: whenever a file is added to or removed from `docs/en/spec/`.
