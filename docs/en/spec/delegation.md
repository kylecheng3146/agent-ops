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
