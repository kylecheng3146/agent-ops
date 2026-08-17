# Doctor Remediation and Exit Code Semantics Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make `agent-ops doctor` tell the operator what to do next. Every non-PASS check carries a `remediation` string — including "no action needed" for checks that are benign by design — and the exit code becomes meaningful instead of being permanently non-zero.

**Architecture:** Two root causes, addressed independently.

1. *Empty messages.* `checkProbe()` in `runtime/src/install/doctor.ts` collapses a probe's `boolean | DoctorStatus` result into one of three canned sentences (`"Probe passed."` / `"Probe failed."` / `"Probe has nothing to verify yet."`), discarding everything the probe knew — which harness drifted, whether trust is `STALE` or `UNTRUSTED`, why smoke availability is unknown. Widen the probe result type (additively) so probes report detail, and add an optional `remediation` string to `DoctorCheck`.
2. *Meaningless exit code.* `packages/cli/src/commands/doctor.ts` maps `FAIL | UNSUPPORTED | UNKNOWN | DEGRADED` to `status: "error"`, and `packages/cli/src/cli.ts:159` maps any non-ok status to exit 1. Because `smokeAvailabilityStatus()` returns `UNKNOWN` whenever `config.verification.commands` is empty — a perfectly healthy state — a fresh, correct installation always exits 1. Remap so that only "there is something to do" is an error.

Doctor stays **read-only**. No `--fix` flag, no interactive prompt, no new write path. Repair is what `agent-ops update` and `agent-ops trust grant` are for; they already exist and already confirm.

**Tech Stack:** TypeScript 7, Node.js 22 ESM, node:test, existing CLI envelope / command registry.

## Design decisions

Recorded so implementation does not relitigate them. Decisions marked **(2026-08-17)** supersede the original 2026-08-05 draft.

- `remediation` is a **plain string**, never `{command, args}`. The JSON envelope shape must stay backward compatible (~1000 npm downloads); adding a key is additive, changing a string to an object is not. `schemas/` contains no doctor schema and there is no `additionalProperties: false` gate, so an added key is safe.
- Coverage is **all non-PASS checks**, not just fixable ones. The most confusing statuses (`UNKNOWN`, `UNSUPPORTED`) are precisely the unfixable ones; leaving them blank would preserve the original complaint. "This one needs no action, because X" is a valid next step.
- `config` FAIL must **not** suggest `agent-ops init` — that would overwrite the operator's configuration. Report the failing validation path only.
- `artifacts` FAIL remediation must carry an overwrite warning: a hash mismatch may be a deliberate local edit.
- `hookRegistrationSatisfied()` keeps its `boolean` signature. `tests/install/probes.test.ts` holds 11 boolean assertions against it; a sibling `hookRegistrationDrift()` returning the failing harness ids avoids touching any of them.
- **(2026-08-17)** No interactive fix prompt. The original Task 4 offered a TTY `y/n` that dispatched `trust` / `update`; it is cut. It bought the operator ~15 keystrokes at the cost of turning a diagnostic command into one that writes files, plus injected confirm callbacks and command runners. `--yes` stays inert for doctor.
- **(2026-08-17)** Exit code is driven by **actionability, not status**: error when `status === "FAIL"` **or** `code !== undefined`. The original rule (`FAIL || DEGRADED`) would have kept every opencode installation permanently at exit 1, because `lifecycle-summary` reports DEGRADED by descriptor declaration and can never be repaired. Under the new rule that check exits 0 (no `code`), while `artifact-staleness` DEGRADED still exits 1 (carries `UPDATE_REQUIRED`). `config` FAIL has no `code` but is caught by the `FAIL` half.
- **(2026-08-17)** `code` therefore means exactly one thing: *an agent-ops command exists that addresses this*. `UPDATE_REQUIRED` → `agent-ops update`; `TRUST_REQUIRED` → `agent-ops trust grant`. Nothing else may carry a `code`.
- **(2026-08-17)** `repository-trust` UNTRUSTED gets `TRUST_REQUIRED` **only when `config.verification.commands` is non-empty**. Untrusted silently disables Stop-hook verification (`runtime/src/hooks/stop-verify.ts:75` returns `unavailable("STOP_VERIFICATION_UNTRUSTED")`), which is a real fault for an operator who configured verification — and irrelevant for one who did not. `init` never grants trust, so an unconditional `code` would put every fresh installation back at a permanent exit 1. `STALE` is unconditional FAIL: it means a binding existed and changed, which is a security signal regardless of configuration.
- **(2026-08-17)** `review-targets` loses its `UPDATE_REQUIRED` code at all four sites. Its fixes are `codex login`, installing the executable, or editing `reviewRoles[].targets` — never `agent-ops update`. The precise guidance moves from `message` into `remediation`, and the comment at `doctor.ts:670-676` (which exists only because `remediation` did not) is deleted.
- **(2026-08-17)** Surface rows get a `reason`. `HarnessSurfaceStatus` gains `readonly reason?: string`, populated by the inspection layer, rendered by the formatter. The `status` union is **not** extended — that field is part of `--json` output and changing its value domain is not additive. This is what stops `unknown claude/user-settings` and `missing opencode/opencode-config` from reading as faults.

## Remediation table

| Check / status | `code` | Remediation |
|---|---|---|
| `node-version` FAIL | — | Install Node 22.14.0 or newer. |
| `manifest` FAIL | — | Run `agent-ops init` to create a managed installation. |
| `config` FAIL | — | Fix the reported validation path in `.agent-ops/config.json`. (No command — regenerating would discard configuration.) |
| `artifacts` FAIL | `UPDATE_REQUIRED` | Run `agent-ops update` to restore managed artifacts. Warns that local edits to the listed paths will be overwritten. |
| `artifact-staleness` DEGRADED | `UPDATE_REQUIRED` | Run `agent-ops update`. |
| `markers` FAIL / DEGRADED | `UPDATE_REQUIRED` | Run `agent-ops update`. |
| `registration-drift` FAIL | `UPDATE_REQUIRED` | Run `agent-ops update` (names the drifted harness). |
| `hook-registration` FAIL | `UPDATE_REQUIRED` | Run `agent-ops update` (names the harness missing handlers). |
| `repository-trust` STALE → FAIL | `TRUST_REQUIRED` | Binding is stale; run `agent-ops trust grant`. |
| `repository-trust` UNTRUSTED → UNKNOWN, verification configured | `TRUST_REQUIRED` | Not granted; Stop verification will not run. Run `agent-ops trust grant`. |
| `repository-trust` UNTRUSTED → UNKNOWN, no verification configured | — | No action needed; trust is only required once `verification.commands` is set. |
| `surface-inventory` UNKNOWN | — | No action needed; lists the surfaces that could not be inspected. |
| `lifecycle-summary` UNSUPPORTED / DEGRADED | — | No action needed; the named harness does not dispatch it. |
| `smoke-availability` UNKNOWN | — | No action needed; add `verification.commands` to `.agent-ops/config.json` to enable smoke checks. |
| `review-targets` FAIL, missing executable | — | Install the named target, or remove it from `reviewRoles[].targets`. |
| `review-targets` FAIL, ineligible | — | The named target has no read-only mode; remove it from `reviewRoles[].targets`. |
| `review-targets` FAIL, timeout | — | Re-run `agent-ops doctor --check-auth`. |
| `review-targets` FAIL, unauthenticated | — | Run `<target> login`. |

## Surface reason table

| Condition | `reason` |
|---|---|
| `surface.scope === "external"` | Outside the installation root; not inspected by design. |
| `access === "inspect-only"`, status `missing` | Optional file that agent-ops never writes. |
| everything else | (field omitted) |

## Acceptance criteria

1. Every non-PASS check in a doctor report carries a non-empty `remediation` string, and the three probe checks name the specific harness / trust state / missing configuration instead of `"Probe failed."`.
2. Envelope `status` is `"error"` exactly when some check has `status === "FAIL"` or a defined `code`; otherwise `"ok"` and process exit 0. A report whose only findings are `lifecycle-summary` DEGRADED, `surface-inventory` UNKNOWN, and `smoke-availability` UNKNOWN exits 0. The `DOCTOR_*` code strings and their precedence are unchanged.
3. `repository-trust` UNTRUSTED carries `TRUST_REQUIRED` when `verification.commands` is non-empty and carries no `code` when it is empty. `STALE` always carries it.
4. `review-targets` checks carry no `code`; their per-result guidance appears in `remediation`.
5. Text output prints remediation as an indented `  → ` line under the owning check; check order is unchanged; `--json` exposes `remediation` as a string field.
6. Surface rows whose scope is external, or which are missing `inspect-only` files, render a trailing reason and expose `reason` in `--json`. The `status` union is unchanged.
7. Doctor performs no writes and never prompts, in any mode, with or without `--yes`.
8. Focused tests, the full suite, typecheck, build, and package check pass.

### Task 1: Carry remediation through the doctor report

**Files:**

- Modify: runtime/src/install/doctor.ts
- Test: tests/install/doctor.test.ts

**Step 1: Write failing report tests**

Assert that each non-PASS check exposes `remediation`; that `config` FAIL remediation contains no `agent-ops` command; that `artifacts` FAIL remediation mentions overwriting; that `lifecycle-summary` UNSUPPORTED and `smoke-availability` UNKNOWN remediation state that no action is needed; that `review-targets` FAIL carries `remediation` and **no** `code`. Assert PASS checks omit the field.

**Step 2: Run the focused test to prove the field is absent**

Run: `npm run test:compile && node scripts/run-tests.mjs .tmp/test-dist/tests/install/doctor.test.js`

**Step 3: Add the field and populate it**

Add `readonly remediation?: string` to `DoctorCheck`. Extend the internal `check()` helper with an optional remediation argument, keeping the existing "omit undefined keys" style. Fill in every row of the remediation table that originates in `doctor.ts`. Add the `TRUST_REQUIRED` code path. Strip the `UPDATE_REQUIRED` code from the four `review-targets` sites and move their guidance into `remediation`; delete the now-obsolete comment above `checkReviewTargets`.

**Step 4: Widen the probe result type**

Change `DoctorProbeResult` to `boolean | DoctorStatus | { status: DoctorStatus; message?: string; remediation?: string; code?: string }`. The two existing forms stay valid, so no caller breaks. Normalize inside `checkProbe()`: an object result supplies its own message, remediation, and code; boolean/status results keep today's canned text.

**Step 5: Re-run the focused test**

### Task 2: Give the probes something to say

**Files:**

- Modify: runtime/src/install/probes.ts
- Modify: packages/cli/src/bin.ts
- Test: tests/install/probes.test.ts

**Step 1: Write failing probe-detail tests**

Assert `hookRegistrationDrift()` returns the ids of harnesses missing managed handlers and an empty array when satisfied. Leave the 11 existing `hookRegistrationSatisfied()` assertions untouched — they must still pass unmodified.

**Step 2: Run the focused test**

Run: `npm run test:compile && node scripts/run-tests.mjs .tmp/test-dist/tests/install/probes.test.js`

**Step 3: Add `hookRegistrationDrift()`**

Same input type as `hookRegistrationSatisfied`; returns `readonly HarnessId[]`. Implement `hookRegistrationSatisfied` in terms of it to avoid two copies of the capability-resolution logic.

**Step 4: Return rich probe results from bin.ts**

In the doctor branch of `bin.ts`, build object-form probe results:

- `hookRegistration`: drifted ids → `{status: "FAIL", message, remediation, code: "UPDATE_REQUIRED"}` naming the harnesses; empty → `PASS`.
- `repositoryTrust`: keep the raw `TRUSTED | STALE | UNTRUSTED` value. `STALE` → `{status: "FAIL", code: "TRUST_REQUIRED"}`. `UNTRUSTED` → `{status: "UNKNOWN"}` with `code: "TRUST_REQUIRED"` **only when `config.verification.commands.length > 0`**, and remediation wording that differs between the two cases per the remediation table.
- `smokeAvailability`: on `UNKNOWN`, state that `verification.commands` is empty and that no action is required. No `code`.

`repositoryTrustStatus()` and `smokeAvailabilityStatus()` keep their signatures; the richer wording is composed at the call site.

**Step 5: Re-run the focused test**

### Task 3: Surface reasons

**Files:**

- Modify: runtime/src/install/surface-inspection.ts
- Modify: packages/cli/src/commands/doctor.ts
- Test: tests/install/surface-inspection.test.ts

**Step 1: Write failing inspection tests**

Assert an external surface carries a `reason` naming that it is outside the root; that a missing `inspect-only` surface carries an optional-file reason; that a managed surface omits `reason`; that the `status` values are unchanged from today for all three.

**Step 2: Run the focused test**

Run: `npm run test:compile && node scripts/run-tests.mjs .tmp/test-dist/tests/install/surface-inspection.test.js`

**Step 3: Populate `reason`**

Add `readonly reason?: string` to `HarnessSurfaceStatus`. Set it at the two sites in `inspectHarnessSurfaces()` that already know the answer: the `surface.scope === "external"` early return, and the `read === null` missing branch when `surface.access === "inspect-only"`. Leave every other push untouched.

**Step 4: Re-run the focused test**

### Task 4: Fix the exit code mapping and the text formatter

**Files:**

- Modify: packages/cli/src/commands/doctor.ts
- Test: tests/cli/doctor-command.test.ts (new)

**Step 1: Write failing CLI envelope tests**

This is the criterion that protects existing users' pipelines, so test it directly:

- A report whose only findings are `UNKNOWN` / `UNSUPPORTED` / codeless `DEGRADED` → `status: "ok"`, `errors: []`, code still `DOCTOR_UNKNOWN` / `DOCTOR_UNSUPPORTED` / `DOCTOR_DEGRADED` by the existing precedence.
- A `DEGRADED` check carrying `UPDATE_REQUIRED` → `status: "error"`.
- A `FAIL` check with no `code` (the `config` case) → `status: "error"`, code `DOCTOR_FAILED`.
- Formatter output places remediation on its own `  → `-prefixed line directly under its check, leaves check order unchanged, and appends surface reasons to their rows.

**Step 2: Run the focused test**

Run: `npm run test:compile && node scripts/run-tests.mjs .tmp/test-dist/tests/cli/doctor-command.test.js`

**Step 3: Remap status and render**

Keep the `code` precedence ladder exactly as it is. Change only the `status` and `errors` computation to the actionability rule. Update `formatDoctorReport()` to emit the indented remediation line and the trailing surface reason.

**Step 4: Re-run the focused test**

### Task 5: Documentation and changelog

**Files:**

- Modify: README.md
- Modify: docs/en/guides/configuration.md
- Modify: docs/zh-TW/guides/configuration.md
- Modify: docs/en/spec/harness-adapters.md
- Modify: docs/zh-TW/spec/harness-adapters.md
- Modify: CHANGELOG.md

**Step 1: Correct the documented UNKNOWN semantics**

`README.md:167` explains that `repository-trust` and `smoke-availability` report `UNKNOWN` when there is nothing to verify, without saying that this used to force a non-zero exit. State the new contract explicitly: doctor exits non-zero only when a check failed or names an agent-ops command to run. Audit the four `docs/` files for any claim that contradicts the new mapping and for the `UPDATE_REQUIRED` references at `docs/en/guides/configuration.md:132` and `docs/zh-TW/guides/configuration.md:121`.

**Step 2: Document what doctor cannot fix**

One short paragraph, both languages: external surfaces and descriptor-declared degraded capabilities are permanent findings that need no action; doctor never writes; repair is `agent-ops update` / `agent-ops trust grant`.

**Step 3: Changelog entry**

Release as `0.1.10`. The exit code remap is the only change to behavior existing users can observe, so it must be called out on its own line as a prominent warning — a `doctor` invocation that always failed will now succeed when nothing is actionable. Note the additive `remediation` and `reason` fields separately.

**Step 4: Full verification**

Run the full suite, typecheck, build, and package check. Then request independent review.
