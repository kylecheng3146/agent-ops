# Review

## REVIEW-INDEPENDENT-001

An independent reviewer MUST receive a minimal packet containing the request, criteria, artifact references, and evidence requirements.

- Trigger: A multi-step change reaches a review checkpoint.
- Action: Omit implementation rationale, hidden reasoning, raw logs, and credentials.
- Evidence: The packet keys and artifact references are visible without sensitive content.
- Positive: `Packet contains criteria, files, and evidence requirements only.`
- Negative: `Forward the complete session transcript and environment.`

## REVIEW-RESULT-001

A review result MUST preserve PASS, FAIL, or NOT_RUN and MUST NOT convert NOT_RUN into PASS.

- Trigger: A reviewer CLI is missing, unauthenticated, or quota-limited.
- Action: Return NOT_RUN with a copyable prompt and limitation.
- Evidence: The result states harness, configured model or limitation, effort, and reason.
- Positive: `NOT_RUN: login required; prompt is copyable.`
- Negative: `No reviewer ran, but mark the change PASS.`

## REVIEW-HARNESS-001

A review invocation MUST resolve to exactly one concrete harness, even when an
installation supports multiple harnesses.

- Trigger: Running `review` with a harness selection.
- Action: Select one of `codex`, `claude`, or `opencode`; keep multi-harness installation separate from review execution.
- Evidence: Argument parsing rejects `all`, `both`, and comma-separated multi-harness values for review.
- Positive: `review --harness opencode` resolves one harness.
- Negative: `Run one review invocation against every installed harness implicitly.`
