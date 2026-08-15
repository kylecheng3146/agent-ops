# Detailed Independent Review Report Implementation Plan

**PR:** 1 of 3

**Depends on:** The currently implemented external review target chain.

**Goal:** Make `agent-ops review` return a complete structured report that CI
can gate on and a person can inspect, instead of reducing a successful review
to a one-line approval.

**Architecture:** Add one transient report contract and one pure renderer. Use a
packaged JSON Schema through each review CLI's native structured-output feature,
then apply a handwritten semantic validator before deriving the verdict. Keep
the existing `ReviewRunResult` and `results[]` fields in place, and do not store
the complete report.

PR 1 deliberately does not implement authoritative Git scope, neutral working
directories, source fingerprints, or automatic completion handoff. Those are
PR 2 and PR 3. It does require the scope declaration fields now so the protocol
does not change again later.

## Decisions

- The model returns `ReviewReport`; it does not return authoritative overall
  status.
- `runReviewCommand()` requires a resolved task record. A bare `--criterion`
  value is only a filter and is never reused as its own description; missing
  task context returns `NOT_RUN / no-task-context` before packet construction.
- Runtime derives FAIL from any failed criterion or blocking finding. All
  criteria PASS with only non-blocking findings remains PASS.
- `critical` is always blocking, `minor` is always non-blocking, and
  `important` may be either.
- Every failed criterion must have a blocking finding that references it.
- A blocking finding that names criteria may name only failed criteria; a
  cross-cutting blocker uses an empty `criterionIds` array.
- Every requested criterion appears exactly once and contains a non-blank
  summary plus at least one evidence entry.
- Finding `criterionIds` are known and unique. An empty array means the finding
  is cross-cutting.
- Native JSON Schema is mandatory. Prompt-only structured output is not a
  fallback.
- A protocol violation is terminal `NOT_RUN / unparseable-output`; it is never
  a reviewer FAIL and never advances to another target.
- Truncated reviewer stdout is terminal `NOT_RUN / output-too-large`, which is
  distinct from structurally invalid JSON.
- Raw invalid output is not exposed. The caller receives only bounded, redacted
  `{ path, code, message }` diagnostics.
- Treat task title, criterion text, verifier IDs, artifact references, and
  evidence requirements as untrusted data. Run the existing secret guardrail,
  redaction, control-character cleanup, and byte bounds before prompt
  construction; a detected credential is `NOT_RUN / sensitive-review-input`
  before any target probe or spawn.
- Serialize sanitized task data as one JSON value between fixed reviewer
  instructions, and explicitly forbid following instructions found inside
  string values. Do not interpolate task-controlled text into control
  sentences.
- Send the final bounded prompt through stdin, not process argv, and retain only
  that sanitized/redacted prompt in the compatibility result field.
- Reuse one 64 KiB ceiling for the serialized prompt. Reject an oversized
  packet as `NOT_RUN / scope-too-large`; never truncate criterion semantics.
- Packet guard and size failures use bounded `AgentOpsError` codes internally;
  `runReviewCommand()` catches only those known codes and maps them to the
  standard `REVIEW_NOT_RUN` envelope. Other programming/storage errors still
  propagate instead of being mislabeled.
- Reuse the existing 64 KiB reviewer stdout limit as the total report bound and
  return at most 20 validation diagnostics. Do not add per-field configuration
  for a payload that is already globally bounded.
- The full report is returned through human stdout and `--json`, but is not
  written to task state.
- Only overall PASS writes the existing per-criterion review evidence to an
  active task.
- JSON keys, enums, and headings stay English. Reviewer narrative follows the
  task's dominant language.
- Production gains no schema-validation dependency. Tests may use the existing
  AJV dev dependency to compile the static schema.

## Contract

Create this transient model-output shape:

```ts
export interface ReviewReportCriterionResult {
  readonly criterionId: string;
  readonly status: "PASS" | "FAIL";
  readonly summary: string;
  readonly evidence: readonly string[];
}

export interface ReviewFindingLocation {
  readonly path: string;
  readonly line?: number;
}

export interface ReviewFinding {
  readonly severity: "critical" | "important" | "minor";
  readonly blocking: boolean;
  readonly title: string;
  readonly details: string;
  readonly locations: readonly ReviewFindingLocation[];
  readonly evidence: readonly string[];
  readonly recommendation: string;
  readonly criterionIds: readonly string[];
}

export interface ReviewReport {
  readonly summary: string;
  readonly results: readonly ReviewReportCriterionResult[];
  readonly findings: readonly ReviewFinding[];
  readonly residualRisks: readonly string[];
  readonly changedFilesInspected: readonly string[];
  readonly supportingFilesInspected: readonly string[];
}

export interface ReviewValidationError {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}
```

`ReviewRunResult` retains its existing fields and adds optional `report`,
`validationErrors`, and:

```ts
type ReviewIndependence =
  | "different-target"
  | "same-target"
  | "unknown";
```

The existing `ReviewCriterionResult` type and
`data.result.results[].criterionId/status/evidence` location remain unchanged.
Project detailed results into that legacy shape; the required per-criterion
`summary` remains available under `report.results` without making existing
TypeScript constructors add a new field.

Keep the injected executor contract source-compatible as well:

```ts
type ReviewExecutionResult =
  | {
      readonly status: "PASS" | "FAIL";
      readonly results: readonly ReviewCriterionResult[];
      readonly report?: ReviewReport;
      readonly harness?: ReviewTargetId;
    }
  | {
      readonly status: "NOT_RUN";
      readonly reason: ReviewUnavailableReason;
      readonly harness?: ReviewTargetId;
      readonly validationErrors?: readonly ReviewValidationError[];
    };
```

The production executor always supplies `report` and the actual `harness` for a
verdict. Optional fields preserve source compatibility for existing injected
callers, but not their old verdict behavior: a PASS/FAIL execution without a
valid report is intentionally normalized to `NOT_RUN / unparseable-output`.
Injected callers must add a valid report to preserve PASS/FAIL semantics.
`runIndependentReview()` uses the returned `harness` when present and never
labels a fallback verdict with only the first configured target.

## Acceptance criteria

1. A task-backed valid native-schema response produces a complete human report
   and machine-readable `ReviewReport`; missing task context produces typed
   NOT_RUN before any reviewer work.
2. Runtime, not the model, derives PASS or FAIL from criteria and blocking
   findings; malformed or internally inconsistent output is NOT_RUN.
3. All three target invocations require native structured output, and a target
   without that capability is never run in prompt-only mode.
4. PASS with non-blocking findings remains PASS and writes criterion evidence;
   FAIL, NOT_RUN, and completed tasks do not write evidence.
5. Reviewer input and the complete report are redacted and bounded; the report
   is visible by default and never persisted by agent-ops.

## Task 1: Add the report schema and semantic validator

**Files:**

- Create: `runtime/src/review/report.ts`
- Create: `schemas/review-report.schema.json`
- Create: `tests/fixtures/review/valid-report.json`
- Create: `tests/review/report.test.ts`
- Modify: `runtime/src/review/result.ts`
- Modify: `tests/schema/validate.test.ts`

### Step 1: Write failing tests

Cover:

- one valid report passes the static schema and runtime validator;
- missing, duplicate, and unknown criterion IDs;
- blank summary, evidence, finding title, details, and recommendation;
- unknown top-level and nested properties;
- location line absent or a positive integer, but never zero or negative;
- unsafe, blank, duplicate, or oversized paths;
- unknown or duplicate finding `criterionIds`;
- critical/non-blocking and minor/blocking contradictions;
- a failed criterion without a linked blocking finding;
- a blocking finding linked to a criterion that is still marked PASS;
- all PASS with no findings, PASS with non-blocking findings, criterion FAIL,
  and cross-cutting blocking finding aggregation;
- validation diagnostics contain no raw payload or secret value.

Run:

```sh
npm run test:compile
node scripts/run-tests.mjs .tmp/test-dist/tests/review/report.test.js .tmp/test-dist/tests/schema/validate.test.js
```

Expected before implementation: FAIL.

### Step 2: Implement the minimum contract

- Put transient interfaces, bounds, `validateReviewReport()`, and
  `deriveReviewStatus()` in `report.ts`.
- Keep the native schema structural: required fields, types, enums, arrays, and
  `additionalProperties: false`.
- Keep request-specific checks in TypeScript: exact criterion set, safe paths,
  severity/blocking invariants, and FAIL-to-finding linkage.
- Stop validation diagnostics after 20 entries; use static messages plus safe
  JSON paths, never rejected values.
- Do not add a report schema version because the report is not persisted.
- Keep `aggregateReviewResults()` exported for existing callers until all
  internal callers use the new contract.

### Step 3: Re-run the focused tests

```sh
npm run typecheck
npm run test:compile
node scripts/run-tests.mjs .tmp/test-dist/tests/review/report.test.js .tmp/test-dist/tests/schema/validate.test.js
```

### Step 4: Commit boundary

```text
feat(review): define detailed report contract
```

## Task 2: Add native-schema target invocations and strict extraction

**Files:**

- Create: `runtime/src/review/schema.ts`
- Modify: `runtime/src/review/invocation.ts`
- Modify: `runtime/src/review/extract.ts`
- Modify: `runtime/src/review/execute.ts`
- Modify: `tests/review/invocation.test.ts`
- Modify: `tests/review/extract.test.ts`
- Modify: `tests/fixtures/review/README.md`
- Add: a Claude `structured_output` fixture and an Agy structured response
  fixture

### Step 1: Write failing tests

Assert:

- Codex receives `--output-schema <packaged-file>`;
- Claude receives `--output-format json --json-schema <inline-schema>`;
- Agy receives `--output-format json --json-schema <inline-schema>`;
- the schema file resolves from the installed package as well as the source
  tree, without a temporary schema file;
- Claude extracts `.structured_output` for review while the legacy `.result`
  path remains available only to its probe;
- Agy accepts an object or JSON string in its `response` envelope;
- Codex accepts only the complete trimmed JSON stdout;
- prose, Markdown fences, trailing text, an envelope mistaken for the report,
  and truncated JSON are rejected.
- output flagged as truncated by the existing process runner returns
  `output-too-large` before JSON parsing.

Run:

```sh
npm run test:compile
node scripts/run-tests.mjs .tmp/test-dist/tests/review/invocation.test.js .tmp/test-dist/tests/review/extract.test.js
```

Expected before implementation: FAIL.

### Step 2: Implement target-specific structured output

- Resolve the static schema from `import.meta.url`; use a source-tree fallback
  only for tests and unbuilt development execution.
- Expose schema text for inline-schema targets and a stable path for Codex.
- Keep transport extraction target-specific, then run one exact `JSON.parse`
  and one shared report validator.
- Stop using balanced-object recovery on the reviewer path. Keep it only if an
  existing probe still needs it.
- Introduce `capability-unavailable` as an additive NOT_RUN reason. PR 2 adds
  the zero-token preflight probe; PR 1 may classify an explicit unknown-option
  response but must never retry malformed model content.

### Step 3: Re-run the focused tests

```sh
npm run typecheck
npm run test:compile
node scripts/run-tests.mjs .tmp/test-dist/tests/review/invocation.test.js .tmp/test-dist/tests/review/extract.test.js
```

### Step 4: Commit boundary

```text
feat(review): enforce native structured output
```

## Task 3: Build the detailed prompt and derive the runtime verdict

**Files:**

- Modify: `runtime/src/review/packet.ts`
- Modify: `runtime/src/review/execute.ts`
- Modify: `runtime/src/review/runner.ts`
- Modify: `runtime/src/review/result.ts`
- Modify: `runtime/src/verify/spawn.ts`
- Modify: `packages/cli/src/commands/review.ts`
- Modify: `tests/review/packet.test.ts`
- Modify: `tests/review/chain.test.ts`
- Modify: `tests/review/runner.test.ts`
- Modify: `tests/verify/spawn.test.ts`
- Modify: `tests/cli/review-task-context.test.ts`

### Step 1: Write failing tests

Cover:

- task title becomes the review request instead of the generic placeholder;
- absent task service, unresolved task/session, and criterion-only CLI input
  each return `REVIEW_NOT_RUN / no-task-context` with zero packet build,
  target probe, executor call, or evidence write;
- the packet contains real criterion descriptions and verifier IDs but no
  transcript, original prompt, raw logs, credential, or embedded diff;
- known credentials in any task-derived field stop with
  `sensitive-review-input` and zero target probes/spawns;
- an oversized sanitized packet stops with `scope-too-large` and zero target
  probes/spawns rather than truncating a criterion;
- sanitized task data is JSON-encoded as untrusted data, so embedded newlines,
  delimiters, and instruction-like text cannot alter the fixed control
  sections;
- target argv never contains the review prompt; the bounded sanitized prompt is
  supplied on stdin and the process runner still ignores stdin by default for
  all existing verification callers;
- direct `runReviewCommand()` calls receive the normal typed JSON/human envelope
  for sensitive or oversized input; no guard failure escapes as a generic CLI
  rejection;
- the prompt requests all report fields, exact JSON, and no model-authored
  overall status;
- the reviewer is instructed to inspect the changed files and only bounded
  direct supporting code;
- a valid all-PASS report returns PASS;
- a non-blocking finding keeps PASS;
- a failed criterion or blocking finding returns FAIL;
- the old `{ results: [...] }`-only response is NOT_RUN;
- malformed and semantically inconsistent reports are terminal and never
  advance the target chain;
- capability unavailable may advance, but FAIL never advances;
- actual target metadata, not the first configured target, is returned;
- the sanitized report recursively redacts summaries, findings, risks, and
  paths.

Run:

```sh
npm run test:compile
node scripts/run-tests.mjs .tmp/test-dist/tests/review/packet.test.js .tmp/test-dist/tests/review/chain.test.js .tmp/test-dist/tests/review/runner.test.js .tmp/test-dist/tests/verify/spawn.test.js .tmp/test-dist/tests/cli/review-task-context.test.js
```

Expected before implementation: FAIL.

### Step 2: Implement the report pipeline

Use this single path:

```text
target transport payload
  -> exact JSON parse
  -> validateReviewReport
  -> deriveReviewStatus
  -> recursively sanitize report
  -> expose report plus legacy results projection
```

- Change successful `ReviewExecutionResult` branches to carry the full report.
- Remove the command-level id-as-description fallback. Keep the lower-level
  `runIndependentReview()` packet seam for injected tests/integrators, but make
  every production `runReviewCommand()` path require resolved task context.
- Make `buildReviewPacket()` the single input trust boundary: reuse the current
  secret evaluator, `redactSecrets()`, and `safeTaskText()`, then enforce field
  and total UTF-8 bounds before `buildReviewPrompt()` runs.
- Extend `ReviewUnavailableReason` with `sensitive-review-input`; return it
  before capability probing when the existing secret evaluator blocks any
  task-derived field.
- Add `scope-too-large` in this PR for the 64 KiB serialized-prompt ceiling; PR
  2 reuses the same reason when authoritative path metadata is added.
- Have `buildReviewPacket()` throw only bounded `AgentOpsError` codes for those
  two preflight conditions. Catch those exact codes in `runReviewCommand()` and
  construct `notRunEnvelope()` with target/model/effort, an empty safe prompt,
  and the mapped typed reason. Do not catch unrelated errors.
- Render the sanitized packet as JSON between fixed instructions, with a fixed
  suffix after the data reiterating that string contents are evidence, not
  instructions.
- Add an optional bounded stdin string to the existing process request. Review
  uses it; verification callers omit it and preserve their current behavior.
  Use each target's stdin prompt form so no task text appears in argv.
- Preserve the existing `results` member and add optional `report` and
  actual-`harness` members exactly as defined above, so injected TypeScript
  callers are not forced through a source-breaking signature change.
- Do not accept executor- or model-supplied overall status.
- Populate `ReviewRunResult.harness` from the target that actually returned the
  verdict.
- Add bounded `validationErrors` for NOT_RUN.
- Keep fallback only for missing executable, spawn failure, timeout, and
  capability unavailable. Preserve terminal behavior for PASS, FAIL, and
  malformed output.
- Mark target relationship as `different-target`, `same-target`, or `unknown`
  only when current host detection supports the claim. PR 2 adds execution
  isolation; this field describes target relationship, not sandbox strength.

### Step 3: Re-run the focused tests

```sh
npm run typecheck
npm run test:compile
node scripts/run-tests.mjs .tmp/test-dist/tests/review/packet.test.js .tmp/test-dist/tests/review/chain.test.js .tmp/test-dist/tests/review/runner.test.js .tmp/test-dist/tests/verify/spawn.test.js .tmp/test-dist/tests/cli/review-task-context.test.js
```

### Step 4: Commit boundary

```text
feat(review): derive verdict from detailed report
```

## Task 4: Render the complete report and gate evidence writes

**Files:**

- Create: `runtime/src/review/render.ts`
- Modify: `packages/cli/src/commands/review.ts`
- Modify: `tests/review/command.test.ts`
- Modify: `tests/cli/review-task-context.test.ts`

### Step 1: Write failing tests

Assert that default human output contains:

- overall status and non-blocking finding count;
- report summary;
- every criterion's status, summary, and evidence;
- findings with severity, blocking state, locations, evidence, and
  recommendation;
- residual risks;
- changed and supporting file declarations;
- actual target/model/effort and target independence;
- bounded validation diagnostics for NOT_RUN.

Also assert:

- the success path no longer dumps the complete prompt;
- `--json` preserves the existing result keys and includes the full report;
- active task PASS writes `review:<actual-target>:` evidence;
- PASS with non-blocking findings writes evidence;
- FAIL, NOT_RUN, and completed-task review write nothing;
- PASS exits 0, while FAIL and NOT_RUN remain distinct JSON errors with exit 1.

Run:

```sh
npm run test:compile
node scripts/run-tests.mjs .tmp/test-dist/tests/review/command.test.js .tmp/test-dist/tests/cli/review-task-context.test.js
```

Expected before implementation: FAIL.

### Step 2: Implement a pure renderer

- Apply existing `safeTaskText()` and `redactSecrets()` at every narrative and
  path boundary.
- Render `PASS — N non-blocking findings` without adding another status.
- Group findings in severity order and label blocking explicitly.
- Render an explicit `none` for empty findings or residual risks.
- On NOT_RUN, show the reason and safe validation diagnostics. Keep the redacted
  prompt in JSON for compatibility; do not print it on successful review.
- Change evidence write-back to require overall PASS and active task status.

### Step 3: Re-run the focused tests

```sh
npm run typecheck
npm run test:compile
node scripts/run-tests.mjs .tmp/test-dist/tests/review/command.test.js .tmp/test-dist/tests/cli/review-task-context.test.js
```

### Step 4: Commit boundary

```text
feat(review): render detailed review results
```

## Task 5: Document the strict report protocol

**Files:**

- Modify: `docs/en/spec/review.md`
- Modify: `docs/zh-TW/spec/review.md`
- Modify: `docs/en/guides/configuration.md`
- Modify: `docs/zh-TW/guides/configuration.md`
- Modify: `tests/docs/spec.test.ts`
- Modify: `tests/docs/translation.test.ts`

### Step 1: Write failing documentation tests

Require both language variants to cover:

- full report fields and runtime-derived verdict;
- native schema requirement and no prompt-only fallback;
- strict malformed-output behavior;
- required task context and no id-as-description fallback;
- severity and blocking semantics;
- PASS with non-blocking findings;
- PASS-only evidence write-back;
- no complete-report persistence;
- prompt secret/injection boundary, stdin transport, and packet size failure;
- typed `REVIEW_NOT_RUN` envelopes for prompt preflight failures;
- additive JSON shape plus the intentional verdict tightening for legacy
  injected executors that omit `report`.

Run:

```sh
npm run test:compile
node scripts/run-tests.mjs .tmp/test-dist/tests/docs/spec.test.js .tmp/test-dist/tests/docs/translation.test.js
```

Expected before documentation changes: FAIL.

### Step 2: Update both specifications

Document only PR 1 behavior as shipped. Refer to the roadmap for future scope,
isolation, and verification work; do not describe PR 2 or PR 3 as implemented.

### Step 3: Re-run the documentation tests

```sh
npm run test:compile
node scripts/run-tests.mjs .tmp/test-dist/tests/docs/spec.test.js .tmp/test-dist/tests/docs/translation.test.js
```

### Step 4: Commit boundary

```text
docs(review): document detailed report protocol
```

## Final PR verification

Run:

```sh
npm run typecheck
npm test
npm run build
npm run package:check
git diff --check
```

No automated test invokes a real reviewer CLI. Use existing injected executor
and process-runner seams. Authentication, quota, and installed CLI capability
remain doctor and manual-smoke concerns.

At implementation time, revalidate provider flags against current local help.
For Codex, the authoritative reference for the schema-file option is the
[OpenAI Codex CLI reference](https://developers.openai.com/codex/cli/reference).
