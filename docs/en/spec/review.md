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

The explicit target MUST already exist in the configured independent-review
role. It narrows the configured chain to one target while preserving model,
effort, and timeout policy. Without `--harness`, host-aware ordering applies to
the complete configured chain. Every result carries that order as
`plannedTargets`.

## REVIEW-READONLY-001

A review target MUST be launched with its own read-only mechanism, and a target
without one MUST be skipped rather than run unsandboxed.

- Trigger: Building a review invocation for a configured target.
- Action: Pass `-s read-only` (codex), `--sandbox --mode plan` (agy), or `--permission-mode plan` (claude); run agy against a disposable repository clone; treat any other target as ineligible.
- Evidence: The spawned argv contains the target's read-only flags.
- Positive: `agy receives sandboxed plan mode; opencode remains ineligible.`
- Negative: `Trust the prompt to stop the reviewer from editing files.`

Every attempted review MUST run in a fresh session (`sessionIsolation:
"fresh"`) and in a disposable repository clone. The reviewer chain prefers a
different CLI from the hosting CLI; when no other usable target exists,
same-target fresh review is allowed but MUST render as `DEGRADED: isolated
self-review`. A resumed development session is never an independent review.

Capability and model-start progress goes to stderr even when stdout is JSON.
Raw reviewer output remains bounded and unstreamed. SIGINT or SIGTERM aborts
the active process tree without fallback or attestation; timeout remains a
distinct NOT_RUN reason rather than being flattened to `missing-cli`.

## REVIEW-CHAIN-001

Configured targets form an ordered fallback chain that MUST advance only when
no review happened, and MUST NOT advance past a verdict.

- Trigger: A configured target is missing, fails to spawn, or times out.
- Action: Try the next target after unparseable output; stop and report the first PASS or FAIL.
- Evidence: The number of spawned attempts matches the failures that preceded the verdict.
- Positive: `codex FAIL is final; no other target is asked for a second opinion.`
- Negative: `Retry other targets after a FAIL until one reports PASS.`

## REVIEW-ADVERSARIAL-001

A PASS MUST be offered to a different eligible target for refutation, and a
successful refutation MUST make the run FAIL.

- Trigger: The primary target returns PASS and another eligible target has not
  already been walked past. The host target never serves as the challenger.
- Action: Send that target the prior report as untrusted data and ask it to
  refute the verdict; report FAIL when it does, and record the challenge as
  `adversarial` either way.
- Evidence: `adversarial` names the challenging target and whether it refuted;
  a challenger that produced no report appears on the attempt list instead.
- Positive: `codex passed, claude found a blocking defect, the run failed.`
- Negative: `Manufacture a refutation so the challenge looks effective.`
- Note: With one usable target the primary verdict stands unchallenged. A FAIL
  is already terminal and is never re-checked.

## REVIEW-CONTRACT-001

A response that breaks the reply contract MUST be reported as NOT_RUN, not as
FAIL.

- Trigger: The reviewer omits, duplicates, or invents a criterion, or returns blank evidence.
- Action: Report `NOT_RUN` with reason `unparseable-output`, write no evidence, and keep FAIL for judged inadequacy.
- Evidence: The result reason distinguishes a protocol violation from a verdict.
- Positive: `NOT_RUN: unparseable-output; one criterion was missing.`
- Negative: `Record a failed review because the model's JSON was malformed.`
