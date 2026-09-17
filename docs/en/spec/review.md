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

A complete review MUST use the configured independent-review target selection;
the review command MUST NOT accept a per-run harness override.

- Trigger: Running `review`.
- Action: Resolve the configured targets and plan exactly two fresh sessions.
- Evidence: Argument parsing rejects `--harness`, while `init --review-target` remains the configuration entry point.
- Positive: `review --task <id> --yes` reports its configured `plannedTargets`.
- Negative: `review --task <id> --yes --harness claude` changes the reviewer set.

With three configured targets, `AGENT_OPS_HOST` MUST identify the current host;
that target is excluded and `agy` is primary when available. With two targets,
both run in configured order even if one is the host. With one target, it runs
twice in fresh sessions.

## REVIEW-READONLY-001

A review target MUST be launched with its own read-only mechanism, and a target
without one MUST be skipped rather than run unsandboxed.

- Trigger: Building a review invocation for a configured target.
- Action: Pass `-s read-only` (codex), `--sandbox --mode plan` (agy), or `--permission-mode plan` (claude); run agy against a disposable repository clone; treat any other target as ineligible.
- Evidence: The spawned argv contains the target's read-only flags.
- Positive: `agy receives sandboxed plan mode; opencode remains ineligible.`
- Negative: `Trust the prompt to stop the reviewer from editing files.`

Every attempted review MUST run in a fresh session (`sessionIsolation:
"fresh"`) and in a disposable repository clone. A same-target pair remains
independent because the sessions and clones are fresh. A resumed development
session is never an independent review.

Capability and model-start progress goes to stderr even when stdout is JSON.
Raw reviewer output remains bounded and unstreamed. SIGINT or SIGTERM aborts
the active process tree without fallback or attestation; timeout remains a
distinct NOT_RUN reason rather than being flattened to `missing-cli`.

## REVIEW-CHAIN-001

The two planned sessions MUST be ordered as a necessary review followed by an
adversarial re-check. The first session MUST stop the run on FAIL or NOT_RUN;
there is no fallback after that result.

- Trigger: The first target is missing, unauthenticated, unavailable, or returns a malformed report.
- Action: Return NOT_RUN with the first attempt and do not start the second session.
- Evidence: `attempts` contains the first diagnostic and has no second attempt.
- Positive: `primary NOT_RUN` is final NOT_RUN.
- Negative: `Run the second target after the necessary review did not run.`

## REVIEW-ADVERSARIAL-001

A PASS MUST be offered to the second planned target for refutation, and a
successful refutation MUST make the run FAIL.

- Trigger: The primary target returns PASS.
- Action: Send that target the prior report as untrusted data and ask it to
  refute the verdict; report FAIL when it does, and record the challenge as
  `adversarial` either way.
- Evidence: `adversarial` names the challenging target and whether it refuted;
  a challenger that produced no report appears on the attempt list instead.
- Positive: `codex passed, claude found a blocking defect, the run failed.`
- Negative: `Manufacture a refutation so the challenge looks effective.`
- Note: With one configured target the same target is invoked again in a fresh
  session. A FAIL is already terminal and is never re-checked.

## REVIEW-HOST-001

A host that cannot provide network and loopback capability MUST fail closed
before any reviewer invocation.

- Trigger: The host declares disabled network or the loopback probe fails.
- Action: Return `REVIEW_NOT_RUN / host-required` with the host restriction.
- Evidence: `attempts` is empty and no target preflight or reviewer process ran.
- Positive: A trusted outer host runner starts the exact command once with both capabilities before any reviewer invocation.
- Negative: Treat a child login error as proof that an authenticated reviewer is unavailable.

The managed host instructions require this handoff before the first command.
There is no repository-level permission bypass. An unavailable outer host runner
MUST leave the result NOT_RUN rather than manufacture PASS.

## REVIEW-EVIDENCE-001

A complete PASS MUST include the primary report, the adversarial report, two PASS
attempts with fresh session IDs, a stable source fingerprint, and a private
bounded report artifact before its attestation is written. Artifact or
attestation write failure MUST return NOT_RUN.

- Trigger: A reviewer chain reaches a PASS verdict.
- Action: Validate both reports, both fresh attempts, the source fingerprint,
  and the private bounded artifact before writing the attestation.
- Evidence: The attestation and artifact agree on task, host, targets, session
  IDs, report digests, and source fingerprint.
- Positive: A complete pair writes the artifact and matching PASS attestation.
- Negative: A partial PASS or failed evidence write becomes NOT_RUN.

## REVIEW-CONTRACT-001

A response that breaks the reply contract MUST be reported as NOT_RUN, not as
FAIL.

- Trigger: The reviewer omits, duplicates, or invents a criterion, or returns blank evidence.
- Action: Report `NOT_RUN` with reason `unparseable-output`, write no evidence, and keep FAIL for judged inadequacy.
- Evidence: The result reason distinguishes a protocol violation from a verdict.
- Positive: `NOT_RUN: unparseable-output; one criterion was missing.`
- Negative: `Record a failed review because the model's JSON was malformed.`
