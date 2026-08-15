# Detailed Independent Review Roadmap

**Date:** 2026-08-14

**Status:** Approved design; implementation not started.

**Goal:** Replace verdict-only independent review output with a detailed,
machine-readable and human-readable report, then make one fresh reviewer the
final automated checkpoint after current machine verification passes.

**Delivery:** Three additive pull requests, implemented in order:

1. [Detailed review report contract](./2026-08-14-detailed-independent-review-report.md)
2. [Deterministic scope and reviewer isolation](./2026-08-14-deterministic-review-scope-isolation.md)
3. [Verification freshness and automatic review handoff](./2026-08-14-verification-review-handoff.md)

This roadmap supersedes the structured-output and process-isolation decisions
in `2026-08-12-external-review-cli-targets.md`. That document remains the
historical plan for the currently implemented external-target chain.

## Outcome

The completed flow is:

```text
task create (capture policy config hash)
  -> development
  -> agent-ops verify
  -> required checks PASS and evidence matches current source
  -> review preflight
  -> exactly one fresh, isolated, read-only reviewer verdict
  -> render the complete report for a person and JSON consumer
  -> continue only on review PASS
```

`agent-ops review --yes` already starts a new external CLI process without a
resume or continuation identifier, so it has a fresh conversation. It does not
yet provide a clean execution context: the child currently runs from the
repository root and can inherit project or user customization. PR 2 closes that
gap with a neutral temporary working directory and target-native isolation
flags.

Fresh context and target independence are separate properties:

| Property | Meaning | Required behavior |
|---|---|---|
| Fresh conversation | No earlier chat/session history | Always required |
| Isolated execution | No project rules, skills, plugins, hooks, or memory | Always required through demonstrable native controls; otherwise target is unavailable |
| Independent target | Reviewer CLI differs from the hosting CLI | Preferred, but same-target fresh review remains allowed |
| Deterministic scope | Runtime and reviewer agree on the exact changed files | Always required |

The result reports `independence` as `different-target`, `same-target`, or
`unknown`. It never claims stronger independence than the runtime can prove.

## Agreed product behavior

### Trigger and authorization

- External review stays opt-in through `reviewRoles`.
- The CLI requires a resolvable explicit or session-attached task. `--criterion`
  only filters that task; it never fabricates a criterion description from an
  ID. Missing task context is `NOT_RUN / no-task-context` before packet build,
  target probing, or model spawn.
- Interactive development asks for token-spend authorization once when it has
  not already been granted, then invokes one `agent-ops review --yes` at the
  completion checkpoint.
- CI grants authorization explicitly with `--yes`.
- Review does not run on save, in the background, or after every command.
- `verify` does not internally invoke `review`; the managed agent instruction or
  CI pipeline performs the two explicit commands in sequence.
- There is no fan-out, voting, automatic retry, or result shopping.

### Gate semantics

- Only configured verifier commands with `required: true` gate reviewer spawn.
- Optional verifier outcomes are shown and passed to the reviewer but do not
  block spawn.
- A criterion backed only by optional checks remains a semantic reviewer
  judgment.
- A criterion FAIL or any blocking finding produces overall review FAIL.
- Non-blocking findings do not turn a PASS into a fourth status.
- Review FAIL and NOT_RUN both exit 1; JSON distinguishes them. Invalid CLI
  arguments continue to exit 2.
- Only review PASS writes review evidence to an active task.

### Scope

- Default mode reviews staged, unstaged, and untracked worktree changes.
- `--base <git-ref>` reviews the committed `<base>...HEAD` range and requires a
  clean worktree.
- No changes produce `NOT_RUN / no-change-surface`; the runtime never guesses
  the last commit.
- The reviewer must list every runtime-computed changed path exactly once.
- Supporting inspection is limited to direct callers/callees, shared types,
  relevant configuration, and related tests.
- Large scopes are not split automatically; the user must split the change.

### Persistence

- The complete report is transient: human stdout and `--json` contain it, but
  agent-ops does not keep review history.
- Existing per-criterion task evidence remains the only review write-back.
- Verification evidence advances to schema v2 and is source-bound.
- Evidence v1 remains readable for diagnostics but is always stale for the new
  review gate.
- A compact policy config hash is captured when a task is created. This is not
  review-history persistence.

## Report contract

The model returns one object and does not provide an authoritative overall
status:

```ts
interface ReviewReport {
  summary: string;
  results: Array<{
    criterionId: string;
    status: "PASS" | "FAIL";
    summary: string;
    evidence: string[];
  }>;
  findings: Array<{
    severity: "critical" | "important" | "minor";
    blocking: boolean;
    title: string;
    details: string;
    locations: Array<{ path: string; line?: number }>;
    evidence: string[];
    recommendation: string;
    criterionIds: string[];
  }>;
  residualRisks: string[];
  changedFilesInspected: string[];
  supportingFilesInspected: string[];
}
```

Runtime validation enforces these invariants:

- Every requested criterion appears exactly once; unknown and duplicate IDs are
  invalid protocol output.
- Every criterion has a non-blank summary and at least one evidence item.
- Every FAIL criterion has a blocking finding linked through `criterionIds`.
- A blocking finding that names criteria may name only criteria marked FAIL;
  cross-cutting blocking findings use an empty `criterionIds` array.
- `critical` findings are blocking; `minor` findings are non-blocking;
  `important` may be either.
- Finding criterion IDs are known and unique. An empty list means a
  cross-cutting finding.
- Finding locations refer only to declared changed or supporting files.
- `changedFilesInspected` exactly equals the authoritative runtime scope.
- All strings, arrays, and the complete response are bounded before rendering.
- Protocol or semantic validation failure is NOT_RUN, not a reviewer FAIL.

The runtime adds authoritative metadata outside the model payload:

```ts
{
  status: "PASS" | "FAIL" | "NOT_RUN";
  reason?: ReviewUnavailableReason;
  harness: ReviewTargetId;       // actual target used
  model: string;
  effort: string;
  independence?: "different-target" | "same-target" | "unknown";
  scope?: ReviewScope;
  verification?: VerificationSummary;
  prompt: string;                // retained for compatibility, redacted
  results?: ReviewCriterionResult[]; // existing location retained
  report?: ReviewReport;
  validationErrors?: ReviewValidationError[];
}
```

These metadata fields are optional at the exported TypeScript boundary for
additive compatibility. PR 2 makes `scope` and `independence` present on every
native verdict; PR 3 makes `verification` present after successful evidence
preflight. Injected legacy executors may omit them and are rendered as
`unknown`, never as stronger proof.

JSON field names, enums, and status values remain English. Generated narrative
follows the dominant task language. Human section headers remain English; this
work does not introduce an i18n subsystem.

## Fail-closed reasons

The three PRs add bounded, machine-readable reasons instead of collapsing every
problem into `unparseable-output`:

- `authorization-required`
- `no-task-context`
- `no-change-surface`
- `dirty-worktree`
- `invalid-base-ref`
- `change-surface-unavailable`
- `source-snapshot-unavailable`
- `source-changed-during-review`
- `unsafe-review-path`
- `scope-too-large`
- `reviewer-policy-changed`
- `reviewer-policy-baseline-missing`
- `sensitive-review-input`
- `verification-not-passed`
- `missing-verification-evidence`
- `unreadable-verification-evidence`
- `stale-verification`
- `incomplete-scope`
- `capability-unavailable`
- `output-too-large`
- `unparseable-output`

Raw invalid model output is never echoed. Validation diagnostics contain only
bounded, redacted field paths, codes, and messages.

## Backward compatibility

- Existing `ReviewRunResult` fields and `data.result.results` stay in place.
- New fields are additive at the TypeScript and JSON shape boundary; the report
  is not moved under a new mandatory outer envelope.
- This is intentionally stricter behavior for injected executors: an existing
  `{ status: "PASS" | "FAIL", results }` value still compiles, but without a
  valid `report` it is normalized to `NOT_RUN / unparseable-output`. Injected
  callers must provide the detailed report to preserve a verdict. Do not label
  that semantic tightening as behavior-compatible.
- `runReviewCommand()` also removes the historical id-as-description fallback:
  a missing task service or unresolved task is now typed `no-task-context`.
  The low-level runner may still accept a fully constructed injected packet,
  but the production CLI never routes through that seam as a context bypass.
- There is no `detailedReview` feature flag. When external review is enabled it
  uses the strict protocol.
- No new runtime dependency is introduced. The existing development-only AJV
  dependency may compile the static schema in tests; production keeps a small
  handwritten semantic validator.
- Existing task records without a policy baseline remain readable. They are not
  eligible for automated review and must be recreated rather than silently
  trusting the current policy.
- Evidence v1 files remain readable and are not rewritten. They cannot satisfy
  source freshness.

## Security and operational limits

- Reviewer processes remain read-only, run with `shell: false`, receive only a
  fixed platform plus target-auth environment allowlist, and are terminated
  with the existing process-tree handling.
- Task-derived prompt fields cross one trust boundary: detected secrets stop
  before spawn, remaining content is redacted, normalized, bounded, serialized
  as untrusted JSON data, and sent through stdin rather than argv.
- Review uses a neutral temporary directory and removes it in `finally` on
  PASS, FAIL, timeout, or parse failure.
- Every reviewable changed/supporting path is symlink-free component by
  component. The eligible target's native access boundary must resolve paths
  canonically and prevent traversal outside the repository; otherwise that
  target is unavailable.
- Git refs are resolved through argv and converted to commit OIDs before use.
- Source fingerprints store hashes and metadata, never source contents.
- Policy-bearing changes fail before capability probing or model invocation.
- The existing 64 KiB process-output ceiling remains; oversized output is
  NOT_RUN.
- Fingerprinting is O(bytes in the changed worktree files), not a whole-repo
  scan. Base mode binds immutable commit IDs and does not reread every blob.

`changedFilesInspected` is still a model declaration. Exact equality proves
that the reviewer accounted for each path in its response; it cannot prove
human-level comprehension. The complete evidence and findings therefore remain
visible to a person by default.

## Global acceptance criteria

1. A valid review prints criterion summaries, evidence, findings,
   recommendations, residual risks, inspected scope, verification state, and
   reviewer independence; it never reduces the default human output to only
   `APPROVED`.
2. Reviewer spawn occurs only after current required verification evidence,
   deterministic scope, policy baseline, and target capabilities all pass
   preflight.
3. Every spawned reviewer has a fresh conversation, a neutral working
   directory, native read-only enforcement, native structured output, and
   target-supported customization/session isolation.
4. Existing JSON result fields remain usable, complete reports are not
   persisted, and old task/evidence data fails closed without being destroyed.
5. The completion workflow invokes at most one verdict-producing reviewer and
   surfaces the complete result to both humans and automation.

## Final validation

Each pull request runs focused tests named in its implementation plan. Before
merging PR 3, run:

```sh
npm run typecheck
npm test
npm run build
npm run package:check
git diff --check
```

Also run temporary-repository CLI smoke tests for worktree scope, base scope,
dirty-worktree rejection, stale evidence, policy changes, isolated reviewer
arguments, detailed PASS, blocking FAIL, non-blocking findings, malformed JSON,
and preflight paths that must produce zero model spawns.

## Rollout

1. Merge the three PRs in order; do not enable the PR 3 completion wording
   before evidence v2 and preflight ship.
2. Run `agent-ops update` so installed managed instructions receive the explicit
   completion checkpoint.
3. Configure an `independent-review` role only in repositories that authorize
   external reviewer cost. This repository's current config has no
   `reviewRoles`, so review remains disabled until that explicit step.
4. Create new tasks after PR 2 so they receive a policy config baseline. Legacy
   tasks stay readable but cannot pass the automatic review gate.
5. Run `agent-ops doctor` to verify local capabilities; use the existing
   explicitly authorized deep probe when authentication must also be checked.
6. In CI, use the same locally available base ref for verify and review. The
   commands do not fetch a missing remote ref.

Capability availability is determined from the installed CLI, not its name.
As inspected on 2026-08-14, Claude exposes the required safe-mode and
allowed-directory controls. Codex exposes read-only, ephemeral, and user-config
controls but no native control that demonstrably suppresses `AGENTS.md`
discovery; Agy lacks the complete user-customization isolation contract. PR 2
therefore treats current Codex and Agy as unavailable for strict automated
review until their installed help proves the missing native capability. It
does not weaken isolation to keep a target runnable.

## Explicitly deferred

- Persisted review history or a report database
- Automatic PR comments, issues, or notifications
- Reviewer fan-out, voting, or consensus
- Large-change batching
- AST call-graph construction
- Automatic login or CLI upgrades
- Prompt-only fallback when native schema or isolation capability is absent
