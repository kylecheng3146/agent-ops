<!-- agent-ops:start agents-routing v1 -->
## Loop Engineering

Load `.agent-ops/AGENTS.md` as the agent-ops managed baseline.
Project-specific instructions in this file remain authoritative.
<!-- agent-ops:end agents-routing -->

## Session protocol

Read `docs/harness/10-session-protocol.md` once at session start. It routes to
the acceptance, judgment, delegation, review, guardrail, and maintenance
specifications only when needed. Do not load the whole playbook or historical
evidence.

## Definition of done (code changes, fully automatic)

Every code change in this repo must run the full loop without asking:
`task create` (2-5 criteria) → implement → commit → `verify --task` →
`task complete` with evidence → `review --task --yes` → `worktree finish`.
Commit, quota spend, and finish are pre-authorized. Never stop after
implementing and ask; finish the chain.
