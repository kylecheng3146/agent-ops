# Delegation

## DELEGATE-SCOPE-001

Delegation MUST use a bounded task with an explicit artifact, acceptance criteria, and return format.

- Trigger: Investigation spans unknown files, broad scans, or independent workstreams.
- Action: Send only the necessary context and require evidence-backed findings.
- Evidence: The delegation record names scope, output, and verification.
- Positive: `Inspect runtime/src/review and return affected files plus tests.`
- Negative: `Explore the repository and fix anything you notice.`

## DELEGATE-OWNERSHIP-001

The coordinator MUST retain ownership of final integration and verification.

- Trigger: A delegated task returns code, findings, or a proposed change.
- Action: Read back the artifact, reconcile conflicts, and run the required gate.
- Evidence: The coordinator records the final command output.
- Positive: `Reviewer reports PASS; coordinator reruns typecheck and tests.`
- Negative: `Accept the delegated claim without inspecting the diff.`

## DELEGATE-ISOLATION-001

Concurrent delegated writers MUST NOT share one working tree.

- Trigger: More than one delegated agent would edit files for the same task.
- Action: Run delegated edits one at a time, or give each writer its own Git worktree and merge before verification.
- Evidence: `agent-ops verify` returns a status other than `UNKNOWN` for the run.
- Positive: `Read-only scans run in parallel; the single edit runs in the coordinator worktree.`
- Negative: `Two subagents edit the same files while verification runs.`

## DELEGATE-ISOLATION-002

Parallel editing conversations in one repository MUST each work in their own agent-ops worktree.

- Trigger: `worktree.mode` is `auto`, or a second conversation will edit the repository while another is still open.
- Action: Run `agent-ops worktree add <name> --session <id>` from the main checkout before the first edit, work only in the printed path, and merge with `agent-ops worktree finish <name>` after the task completes against the printed `--base`. The merge lands on the branch the main checkout was on when the session began, wherever that checkout is now.
- Evidence: `agent-ops worktree list` shows one worktree per editing session, and each finish reports a fast-forward merge.
- Positive: `Two conversations edit .worktrees/login and .worktrees/cart; each verifies, reviews and finishes on its own.`
- Negative: `Two conversations edit the main checkout at once, so each one's verification and review is voided by the other's writes.`

## DELEGATE-ISOLATION-003

Subagents that write files in one session MUST each work in their own agent-ops worktree, with their own task, pre-work modification intent and local verification.

- Trigger: `worktree.mode` is `auto` and a subagent writes a file. Hook calls made inside a subagent carry its `agent_id` under the parent's `session_id`; a payload without `agent_id` is treated as the session's main thread.
- Action: The first blocked write allocates a worktree owned by that session and agent; edit there using absolute paths, because the hook's `cwd` does not follow a `cd`. Each subagent records `task create --intent` before editing, then commits and runs `agent-ops verify --task` locally. The coordinator runs `agent-ops task advance --task <parent-id> --session <id> --yes` from the main checkout. It integrates every child into the session candidate, verifies all criteria on that candidate, reviews the whole tree in two fresh sessions, archives proof locally and finishes. A direct finish of one child while siblings exist is refused.
- Evidence: `agent-ops worktree list` shows an `agent:` line for each child; the final receipt under `.git/agent-ops/receipts/` contains the integrated task tree, intents, verifier evidence and review reports.
- Positive: `Two subagents commit and verify separate worktrees; one task advance integrates them and completes the final gate before finish.`
- Negative: `A subagent edits the coordinator's worktree, or two subagents edit one worktree, so one review covers two tasks' changes.`
