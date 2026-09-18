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
