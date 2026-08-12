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

A review invocation MUST resolve to exactly one concrete review target, even
when an installation supports multiple harnesses.

- Trigger: Running `review` with a harness selection.
- Action: Select one of `codex`, `agy`, or `claude`; keep multi-harness installation separate from review execution.
- Evidence: Argument parsing rejects `all`, `both`, and comma-separated multi-harness values for review.
- Positive: `review --harness claude` resolves one target.
- Negative: `Run one review invocation against every installed harness implicitly.`

## REVIEW-READONLY-001

A review target MUST be launched with its own read-only mechanism, and a target
without one MUST be skipped rather than run unsandboxed.

- Trigger: Building a review invocation for a configured target.
- Action: Pass `-s read-only` (codex), `--sandbox --mode plan` (agy), or `--permission-mode plan` (claude); treat any other target as ineligible.
- Evidence: The spawned argv contains the target's read-only flags.
- Positive: `opencode is not a review target: --agent plan silently falls back to a writable agent.`
- Negative: `Trust the prompt to stop the reviewer from editing files.`

## REVIEW-CHAIN-001

Configured targets form an ordered fallback chain that MUST advance only when
no review happened, and MUST NOT advance past a verdict.

- Trigger: A configured target is missing, fails to spawn, or times out.
- Action: Try the next target; on PASS, FAIL, or unparseable output, stop and report that outcome.
- Evidence: The number of spawned attempts matches the failures that preceded the verdict.
- Positive: `codex FAIL is final; agy is never asked for a second opinion.`
- Negative: `Retry other targets after a FAIL until one reports PASS.`

## REVIEW-CONTRACT-001

A response that breaks the reply contract MUST be reported as NOT_RUN, not as
FAIL.

- Trigger: The reviewer omits, duplicates, or invents a criterion, or returns blank evidence.
- Action: Report `NOT_RUN` with reason `unparseable-output`, write no evidence, and keep FAIL for judged inadequacy.
- Evidence: The result reason distinguishes a protocol violation from a verdict.
- Positive: `NOT_RUN: unparseable-output; one criterion was missing.`
- Negative: `Record a failed review because the model's JSON was malformed.`
