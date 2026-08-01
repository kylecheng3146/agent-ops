# Project-Neutral Harness Architecture Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Align agent-ops with the reusable harness qualities demonstrated by the comparison project—layer discovery, ownership-safe reconciliation, honest lifecycle fidelity, and evidence-driven verification—without copying any comparison-project policy, command, plugin, model, path, or hook implementation.

> **Terminology:** "comparison project" means the external repository used only as a read-only reference during design. It is never a fixture, dependency, or CI input.

**Architecture:** Keep project policy outside agent-ops. Split each harness descriptor into a control-plane adapter for installation, surfaces, ownership, and probes, and a runtime adapter for native input, normalized events, support fidelity, and native output. Keep manifest schema v2; add only in-memory capability registration specifications. Make Stop verification a config-owned, disabled-by-default feature and wire it to a task-independent verifier runner.

**Tech Stack:** TypeScript 7, Node.js 22 ESM, `node:test`, JSON Schema 2020-12, AJV, transactional filesystem plans, Codex/Claude JSON hook files, and an OpenCode JavaScript plugin shim.

## Why this is a revision, not a rewrite

A fresh-context adversarial review returned `REVISE`. It agreed with the core direction but found four release-blocking omissions:

1. Existing installations validate routing blocks against the current exact descriptor text, so routing wording cannot change until legacy blocks are recognized and migratable. (`runtime/src/install/ownership.ts:231`)
2. Stop hooks are currently registered by `guardrails`, but the real CLI hook path never supplies `stopVerification`; every real Stop reaches `STOP_VERIFICATION_UNAVAILABLE`. (`packages/cli/src/commands/hook.ts:47`)
3. Plan output currently exposes complete merged settings, so reading local or user settings before public-plan redaction could disclose unrelated permissions or sensitive values. (`packages/cli/src/plan-output.ts:32`)
4. Enforcement failure behavior differs by adapter. Codex blocking is `UNKNOWN`, shared hook execution fails open, and only the OpenCode shim currently denies when command-policy runtime invocation fails.

A second adversarial pass confirmed all four against the source and added six more that the sequence must absorb:

5. **Advisory has the same defect as Stop.** `dispatchHookEvent` runs the advisory branch only when `options.advisory` is supplied, and `runHookCommand` never supplies it, so real `SessionStart` on every harness falls through to `HOOK_NOOP` / `PASS`. A support matrix that reports `lifecycle-summary` as supported would be false. (`runtime/src/hooks/dispatch.ts:66`)
6. **Config v2 invalidates repository trust.** The trust binding hashes the complete effective config (`packages/cli/src/context.ts:119`), so adding `features` changes every binding. Every trust-gated flow—`verify`, all hooks, doctor's trust check, and verification attached to tasks—goes `STALE` until the user re-grants. Plain task CRUD is unaffected.
7. **Two config hash functions already exist.** Trust uses `sha256(JSON.stringify(config))`; evidence uses key-sorted canonical JSON (`runtime/src/verify/evidence.ts:60`). Stop must not add a third, and the surviving function must be the canonical one.
8. **Enabling Stop in config does not register the native hook.** Native registration is produced at plan time, so a config edit alone leaves runtime willing and the harness silent.
9. **Routing has three source texts, not one.** Codex/OpenCode share the `AGENTS.md` body, Claude has its own, and `runtime/src/adapters/claude/config.ts:44` holds a third, production-dead `claudeRoutingBlock()` that only tests reference.
10. **PR 1 is a one-way installed-state migration.** Source-level revert is safe only until a user runs `update`; see the rollback section.

The review also established that manifest schema v3 is unnecessary now. Managed-handler markers plus harness and path already identify owned registrations. Revisit v3 only if one installation must own multiple hook surfaces for the same harness or if a native registration cannot be recognized from its marker.

## Product boundary

### Keep in agent-ops

- Short, project-neutral Loop Engineering baseline.
- Explicit evidence and the rule that hook success is not completion evidence.
- Harness surface discovery and bounded inspection.
- Managed-versus-foreign ownership.
- Adapter-native input/output semantics.
- Normalized runtime events used by actual generic capabilities.
- Capability support and degradation reporting.
- Generic task, verification, review, trust, and command-policy machinery.

### Keep out of agent-ops

- Comparison-project commands, package-manager invocations, application paths, routes, and framework assumptions.
- The comparison project's observed native event inventory and hook configuration.
- Its `.codex/hooks/loop-hook.sh`, disabled gate scripts, matchers, or telemetry format.
- Permission values, environment values, or credentials.
- Plugin names, versions, enablement policy, or plugin-specific lifecycle behavior.
- Model names, effort values, quota observations, token measurements, or delegation thresholds.
- Memory products, session statistics, local backup paths, and project maintenance commands.
- Its exact precedence text, verifier IDs, path mappings, test suite, and project policy prose.

## Non-goals

- Do not import the comparison project as a test fixture or package dependency.
- Do not add every Codex or Claude native lifecycle event to a universal union.
- Do not build a policy-pack SDK.
- Do not make Claude local settings the default write target.
- Do not modify plugin configuration.
- Do not claim Codex or any other adapter can block unless native denial is fixture-tested and documented.
- Do not claim a capability is supported while its runtime dispatch dependency is unwired.
- Do not make Stop verification complete a task or act as a blocking gate in this release.
- Do not keep an unreachable native blocking branch alive "for later".
- Do not bump manifest schema beyond v2.
- Do not add dependencies.

## Final behavior

```text
Control plane

project policy -> config/trust -> profile/feature resolution
  -> harness control adapter -> surface inventory/selection
  -> ownership-safe plan -> manifest v2 -> doctor

Runtime plane

native invocation -> harness runtime adapter -> normalized event
  -> capability dispatcher -> HookResult -> native output adapter
```

The adapter-owned registration specification remains in memory:

```text
capability -> normalized event -> native event -> selected surface
  -> support level -> runtime-failure behavior
```

## Global acceptance criteria

1. Existing v2 installations with old routing blocks update and uninstall safely; user content outside managed markers is byte-for-byte preserved.
2. Human and JSON plans never expose foreign settings values, permission entries, environment values, or hook commands from inspected files.
3. `guardrails` installs command policy only. New installs do not register Stop unless config v2 explicitly enables it.
4. Config v1 migrates deterministically to config v2 with Stop disabled. Manifest remains schema v2.
5. Doctor reports managed, foreign, degraded, unsupported, and unknown states without claiming absent data when a surface is inaccessible.
6. Project-shared settings remain the default managed project target; project-local requires explicit target selection; user settings are writable only in user scope; plugin layers are inventory-only.
7. Adapter support/failure behavior is declared and tested per capability. Unsupported native denial is never reported as enforcement `PASS`.
8. Enabled Stop verification executes selected, trusted verifier commands through the real hook process, emits bounded evidence, and never marks a task complete.
9. Generated artifacts and generic fixtures contain no comparison-project tokens or commands, enforced by an automated test from PR 1 onward.
10. Every capability the support matrix reports as supported is reachable through the real CLI hook process. A capability whose dispatch dependency is unwired is reported `unsupported`, never `supported`.
11. One config hash function serves trust grant, trust status, evidence, and Stop. Its result is independent of property order.
12. Doctor reports desired-capability versus actual-registration drift as a non-success status with an actionable remedy. Drift is never `PASS`.
13. Typecheck, complete tests, build, package checks, and diff checks pass.

## Delivery sequence

| PR | Purpose | Behavior risk |
|---|---|---|
| 1 | Migration-safe supplemental routing plus neutrality guard | Medium; one-way installed-state migration |
| 2 | Opaque public plan output | Low; public output shape changes |
| 3 | Split control/runtime adapters and add honest support matrix | Medium; internal refactor, no intended installed behavior change |
| 4 | Safe multi-surface discovery and explicit target selection | Medium; new inspection and CLI surface |
| 5 | Config v2, unified config hash, and Stop decoupling | High; persisted config, trust rebinding, registration change |
| 6a | Task-independent command executor extraction | Low; pure refactor, zero intended behavior change |
| 6b | Real advisory and Stop execution, native failure semantics | High; runtime command execution |

Do not combine PR 2 with PR 4: surface inspection is unsafe until plan output is opaque. Do not combine PR 3 with PR 5: an internal adapter refactor and a persisted behavior migration need independent rollback points. Do not combine PR 6a with PR 6b: a pure extraction and first-time subprocess execution from a lifecycle hook need independent rollback points.

PR 1 carries the neutrality regression test because it guards every later PR; adding it last would leave the whole sequence unguarded.

---

# PR 1 — Migration-safe supplemental routing

## Task 1: Characterize legacy routing compatibility

**Files:**

- Modify: `tests/install/doctor.test.ts`
- Modify: `tests/install/update.test.ts`
- Modify: `tests/install/uninstall.test.ts`
- Modify: `tests/e2e/project-lifecycle.test.ts`

**Step 1: Add v2 installation fixtures for every legacy body**

There are two shipped legacy bodies, not one. Both need fixtures, because a
`--harness all` installation carries both at once.

Codex and OpenCode share `AGENTS.md`:

```text
## Loop Engineering

Use `.agent-ops/AGENTS.md` as the canonical Loop Engineering specification for this project.
```

Claude uses `CLAUDE.md`:

```text
## Loop Engineering

Use `.agent-ops/CLAUDE.md` as the canonical Loop Engineering specification for this project.
```

Place user text before and after each managed block and retain the original bytes for comparison.

**Step 2: Write failing migration tests**

Cover, for each legacy body:

- doctor recognizes the exact legacy body as managed-but-legacy;
- update accepts that state and plans one marker rewrite;
- uninstall removes the exact legacy block;
- changed legacy body still fails closed;
- text outside the block remains byte-identical;
- a `--harness all` installation carrying both legacy bodies migrates in one transaction.

**Step 3: Compile and run the focused tests**

Run:

```bash
npm run test:compile
node scripts/run-tests.mjs \
  .tmp/test-dist/tests/install/doctor.test.js \
  .tmp/test-dist/tests/install/update.test.js \
  .tmp/test-dist/tests/install/uninstall.test.js
```

Expected: the new legacy-recognition tests fail before implementation.

## Task 2: Separate desired and accepted routing bodies

**Files:**

- Modify: `runtime/src/install/harness.ts`
- Modify: `runtime/src/install/ownership.ts`
- Modify: `runtime/src/install/doctor.ts`
- Modify: `runtime/src/install/update.ts`
- Modify: `runtime/src/install/plan.ts`

**Step 1: Introduce a routing specification**

Use a shape equivalent to:

```ts
export interface HarnessRoutingSpec {
  readonly desired: string;
  readonly legacy: readonly string[];
}
```

`desired` is used for new plans. `legacy` is accepted only by ownership and migration checks. Keep marker IDs and boundaries unchanged.

Keep the block version at `1`. `locateMarkers()` rejects a version mismatch with `MALFORMED_MANAGED_BLOCK`, so bumping the version would make the migration itself unreadable on the very installations it must repair. Content, not version, distinguishes desired from legacy.

`assertExpectedManagedBlock()` currently compares against a single `expected.content`. Widen `ExpectedManagedMarker` with the accepted legacy bodies and return which one matched, so callers can distinguish migration from tampering. `runtime/src/install/uninstall.ts:153` and `runtime/src/install/plan.ts:471` keep their call shape because they receive the marker map from `assertSupportedManifestOwnership()`.

**Step 2: Make doctor distinguish legacy from tampering**

- Exact desired content: `PASS`.
- Exact known legacy content: `DEGRADED` with a migration message.
- Any other body: `FAIL`.

Update preflight may accept `PASS` or recognized routing `DEGRADED`, but must continue rejecting malformed markers and arbitrary content.

**Step 3: Plan a transactional rewrite**

The write operation must use the legacy file hash as `expectedHash`, replace only the managed body, and leave surrounding bytes untouched.

## Task 3: Change generated routing from canonical to supplemental

**Files:**

- Modify: `runtime/src/install/harness.ts`
- Modify: `runtime/src/adapters/claude/config.ts`
- Modify: `tests/install/harness.test.ts`
- Modify: `tests/install/plan.test.ts`
- Modify: `tests/adapters/claude.test.ts`
- Modify: `README.md`
- Modify: `docs/en/guides/configuration.md`
- Modify: `docs/zh-TW/guides/configuration.md`

Use project-neutral wording equivalent to:

```md
Load `.agent-ops/AGENTS.md` as the agent-ops managed baseline.
Project-specific instructions in this file remain authoritative.
```

Claude should reference `.agent-ops/CLAUDE.md`; Codex and OpenCode should continue sharing the project `AGENTS.md` route.

Delete the third routing source. `claudeRoutingBlock()` in `runtime/src/adapters/claude/config.ts:44` is unreachable from production code, carries wording that matches neither descriptor, and is referenced only by `tests/adapters/claude.test.ts`. Remove the function and its test so `HarnessRoutingSpec` is the single source of routing text.

## Task 3A: Add project-neutrality regression coverage

**Files:**

- Create: `tests/install/project-neutrality.test.ts`

This guard lands in PR 1 so every later PR inherits it.

Generate every managed rules artifact, routing block, JSON hook registration, and OpenCode plugin. Assert generated output does not contain comparison-project sentinels such as:

```text
vue-tsc
vitest
claude-mem
```

Do not scan plan documents or user documentation, because this plan necessarily discusses the source comparison. Test generated runtime artifacts only.

## Task 3B: Verify PR 1

**Step 1: Run focused and lifecycle tests**

```bash
npm run test:compile
node scripts/run-tests.mjs \
  .tmp/test-dist/tests/install/harness.test.js \
  .tmp/test-dist/tests/install/plan.test.js \
  .tmp/test-dist/tests/install/doctor.test.js \
  .tmp/test-dist/tests/install/update.test.js \
  .tmp/test-dist/tests/install/uninstall.test.js \
  .tmp/test-dist/tests/install/project-neutrality.test.js \
  .tmp/test-dist/tests/adapters/claude.test.js \
  .tmp/test-dist/tests/e2e/project-lifecycle.test.js
```

Expected: PASS.

**Step 2: Commit**

```bash
git add runtime/src/install runtime/src/adapters/claude/config.ts tests/install tests/adapters tests/e2e README.md docs/en/guides/configuration.md docs/zh-TW/guides/configuration.md
git commit -m "fix(install): migrate routing blocks to supplemental policy"
```

### PR 1 release gate

- New install writes supplemental wording.
- Both legacy bodies update without manual edits, including a combined `--harness all` installation.
- Tampered block still blocks update and uninstall.
- Only one routing text source remains in the codebase.
- Neutrality test is green and runs from this PR onward.
- No config or manifest schema changes.

### PR 1 migration direction

Once a user runs `update`, the on-disk managed body no longer matches what a pre-PR-1 binary expects, so that binary reports `MANAGED_BLOCK_CHANGED` and refuses to update or uninstall. Distinguish the two revert cases in release notes:

- Source-level revert before any user has applied the update: safe.
- After a user has applied the update: one-way installed-state migration. Recovery requires a binary at or above the PR 1 release, not a downgrade.

---

# PR 2 — Opaque and redacted public plans

## Task 4: Add disclosure regression tests

**Files:**

- Create: `tests/fixtures/claude/settings-sensitive.json`
- Modify: `tests/install/hooks.test.ts`
- Modify: `tests/install/init.test.ts`
- Modify: `tests/install/update.test.ts`
- Create: `tests/cli/plan-output.test.ts`

Use fake sentinels only:

```json
{
  "permissions": {
    "allow": ["FAKE_SECRET_SENTINEL", "FAKE_FOREIGN_COMMAND"]
  },
  "hooks": {}
}
```

Tests must assert that internal apply operations retain the values, while human output and `JSON.stringify()` of every public CLI envelope do not contain either sentinel.

## Task 5: Mark opaque operations and project internal plans to public plans

**Files:**

- Modify: `runtime/src/fs/transaction.ts` or the file defining `FileOperation`
- Modify: `runtime/src/install/hooks.ts`
- Create: `packages/cli/src/public-plan.ts`
- Modify: `packages/cli/src/plan-output.ts`
- Modify: `packages/cli/src/commands/init.ts`
- Modify: `packages/cli/src/commands/update.ts`
- Modify: `packages/cli/src/commands/uninstall.ts`
- Modify: `packages/cli/src/output.ts` only if the generic envelope type requires it

Add non-persisted disclosure metadata:

```ts
type OperationDisclosure = "full" | "opaque";
```

Hook settings merges are always `opaque`, because they can contain foreign configuration even if this particular fixture does not. Applying the plan still uses full internal content.

Public opaque writes expose only:

```ts
interface PublicOpaqueWrite {
  readonly kind: "write";
  readonly path: string;
  readonly expectedHash: string | null;
  readonly contentHash: string;
  readonly summary: string;
}
```

Do not include raw `content`. Redact paths and summaries with the existing secret redactor before writing human or JSON output.

## Task 6: Verify public and internal behavior

Run:

```bash
npm run test:compile
node scripts/run-tests.mjs \
  .tmp/test-dist/tests/cli/plan-output.test.js \
  .tmp/test-dist/tests/install/hooks.test.js \
  .tmp/test-dist/tests/install/init.test.js \
  .tmp/test-dist/tests/install/update.test.js
```

Expected: PASS, with fake sentinels absent from all public output.

Then run the project lifecycle test to prove opaque public plans remain applicable:

```bash
node scripts/run-tests.mjs .tmp/test-dist/tests/e2e/project-lifecycle.test.js
```

**Commit:**

```bash
git add runtime/src/fs runtime/src/install/hooks.ts packages/cli/src tests/cli tests/install tests/fixtures/claude
git commit -m "fix(cli): redact foreign settings from operation plans"
```

### PR 2 compatibility note

This intentionally changes dry-run JSON shape for opaque settings writes. Document the change because consumers that read raw `operation.content` must switch to `contentHash` and `summary`.

---

# PR 3 — Control/runtime adapter contracts and support fidelity

## Task 7: Write contract tests before refactoring

**Files:**

- Modify: `tests/install/harness.test.ts`
- Modify: `tests/install/probes.test.ts`
- Modify: `tests/install/doctor.test.ts`
- Modify: `tests/adapters/codex.test.ts`
- Modify: `tests/adapters/claude.test.ts`
- Modify: `tests/adapters/opencode.test.ts`

Tests should require every adapter to declare:

- its control surfaces;
- instruction routing contribution;
- capability-to-native registration specification;
- normalized runtime decoder and native output encoder;
- support level and runtime-failure behavior per registration.

Do not add  native events. Continue covering only capabilities agent-ops actually implements.

## Task 8: Introduce adapter-owned registration specifications

**Files:**

- Modify: `runtime/src/install/types.ts`
- Modify: `runtime/src/install/harness.ts`
- Modify: `runtime/src/install/hooks.ts`
- Modify: `runtime/src/install/probes.ts`
- Modify: `runtime/src/adapters/codex/events.ts`
- Modify: `runtime/src/adapters/claude/events.ts`
- Modify: `runtime/src/adapters/opencode/events.ts`

Use shapes equivalent to:

```ts
export type CapabilitySupport =
  | "supported"
  | "degraded"
  | "unsupported"
  | "unknown";

export type RuntimeFailureMode =
  | "fail-open"
  | "fail-closed"
  | "native-unknown";

export interface CapabilityRegistrationSpec {
  readonly capability:
    | "lifecycle-summary"
    | "command-policy"
    | "optional-stop-verify";
  readonly normalizedEvent: "session-start" | "command" | "stop";
  readonly nativeEvent: "SessionStart" | "PreToolUse" | "Stop";
  readonly surfaceId: string;
  readonly support: CapabilitySupport;
  readonly runtimeFailure: RuntimeFailureMode;
}
```

These values are adapter-owned and derived in memory. Do not add them to manifest v2.

## Task 9: Split the descriptor logically without moving directories

**Files:**

- Modify: `runtime/src/install/harness.ts`
- Modify: call sites under `runtime/src/install/`
- Modify: `packages/cli/src/commands/hook.ts`

Target shape:

```ts
export interface HarnessControlAdapter {
  readonly instructionFile: string;
  readonly routing: HarnessRoutingSpec;
  readonly registrations: readonly CapabilityRegistrationSpec[];
  plan(context: HarnessPlanContext): Promise<HarnessContribution>;
  // Existing merge, strip, ownership, and probe responsibilities.
}

export interface HarnessRuntimeAdapter {
  normalizeInput(input: unknown): NormalizedHookEvent;
  formatOutput(event: HookEventName, result: HookResult): HookProcessOutput;
  formatRuntimeFailure(
    event: HookEventName,
    capability: Capability
  ): HookProcessOutput;
}

export interface HarnessDescriptor {
  readonly id: HarnessId;
  readonly control: HarnessControlAdapter;
  readonly runtime: HarnessRuntimeAdapter;
}
```

Keep existing adapter directories. Do not perform a broad file move.

## Task 10: Report effective capability fidelity

**Files:**

- Modify: `runtime/src/install/doctor.ts`
- Modify: `packages/cli/src/commands/doctor.ts`
- Modify: `docs/en/spec/harness-adapters.md`
- Modify: `docs/zh-TW/spec/harness-adapters.md`

Add `UNSUPPORTED` to doctor status only if it is needed to distinguish a known missing native capability from `UNKNOWN`. Ensure existing status aggregation treats `UNSUPPORTED` as non-success and never rewrites it as `PASS`.

Initial declarations must be based on existing adapter fixtures and on what the real CLI hook process actually dispatches, not on comparison-project observations. In particular:

- `lifecycle-summary` is `unsupported` on every harness as of PR 3, because `runHookCommand` supplies no advisory implementation and `dispatchHookEvent` therefore falls through to `HOOK_NOOP`. PR 6b wires it and flips the declaration; declaring it supported before then is a false claim under acceptance criterion 10.
- OpenCode app initialization remains degraded for per-session lifecycle summary even after wiring, because the plugin initializes once per app rather than once per session.
- Codex command denial remains unknown until a real native smoke proves blocking.
- OpenCode's generated shim retains fail-closed behavior when command-policy runtime is unavailable.
- Stop support is reported separately from command-policy support, and stays `unsupported` until PR 6b.

Add a contract test asserting the inverse direction: for every registration declared `supported`, the real `runHookCommand` path must reach that capability's handler. This is what prevents the advisory defect from recurring.

## Task 11: Verify no installed behavior drift

```bash
npm run test:compile
node scripts/run-tests.mjs \
  .tmp/test-dist/tests/install/harness.test.js \
  .tmp/test-dist/tests/install/hooks.test.js \
  .tmp/test-dist/tests/install/probes.test.js \
  .tmp/test-dist/tests/install/doctor.test.js \
  .tmp/test-dist/tests/adapters/codex.test.js \
  .tmp/test-dist/tests/adapters/claude.test.js \
  .tmp/test-dist/tests/adapters/opencode.test.js \
  .tmp/test-dist/tests/adapters/opencode-shim.test.js
```

Expected: PASS. Generated hook files should remain byte-compatible except where an explicit support correction requires removing a falsely claimed registration.

**Commit:**

```bash
git add runtime/src/install runtime/src/adapters packages/cli/src/commands/hook.ts tests/install tests/adapters docs/en/spec/harness-adapters.md docs/zh-TW/spec/harness-adapters.md
git commit -m "refactor(harness): separate control and runtime contracts"
```

---

# PR 4 — Safe multi-surface discovery and target selection

## Task 12: Define project-neutral harness surfaces

**Files:**

- Create: `runtime/src/install/surfaces.ts`
- Modify: `runtime/src/install/types.ts`
- Modify: `runtime/src/install/harness.ts`
- Create or modify: `runtime/src/adapters/codex/surfaces.ts`
- Create or modify: `runtime/src/adapters/claude/surfaces.ts`
- Create or modify: `runtime/src/adapters/opencode/surfaces.ts`
- Create: `tests/install/surfaces.test.ts`

Use a model equivalent to:

```ts
export type SurfaceAccess =
  | "managed-default"
  | "managed-opt-in"
  | "inspect-only";

export interface HarnessSurface {
  readonly id: string;
  readonly path: string;
  readonly scope: "project" | "user" | "external";
  readonly access: SurfaceAccess;
  readonly representation: "json" | "javascript" | "markdown";
}
```

Required Claude policy:

- project shared `.claude/settings.json`: `managed-default` in project scope;
- project local `.claude/settings.local.json`: `managed-opt-in` in project scope;
- user settings: `inspect-only` during project install, managed during explicit user scope;
- plugin layer: `inspect-only` in every scope.

Inaccessible external surfaces are `UNKNOWN`, never silently absent.

## Task 13: Add bounded, value-free surface inventory

**Files:**

- Create: `runtime/src/install/surface-inspection.ts`
- Modify: `runtime/src/install/doctor.ts`
- Modify: `packages/cli/src/commands/doctor.ts`
- Create: `tests/install/surface-inspection.test.ts`
- Add generic fixtures under: `tests/fixtures/harness-surfaces/`

The inspector may report:

```ts
interface HarnessSurfaceStatus {
  readonly harness: HarnessId;
  readonly surfaceId: string;
  readonly path: string;
  readonly status: "managed" | "foreign" | "missing" | "unknown";
  readonly managedHandlerCount: number;
  readonly foreignHandlerCount: number;
}
```

It must not return settings values, permission entries, environment values, commands, or plugin names. Reads must be bounded, regular-file-only, no-follow, and identity-checked using the same safety pattern as doctor and update.

## Task 14: Add explicit hook-target selection without manifest v3

**Files:**

- Modify: `packages/cli/src/args.ts`
- Modify: `packages/cli/src/cli.ts`
- Modify: `packages/cli/src/wizard.ts` only for descriptions; do not add a default-selected prompt
- Modify: `runtime/src/install/plan.ts`
- Modify: `runtime/src/install/hooks.ts`
- Modify: `runtime/src/install/ownership.ts`
- Modify: `runtime/src/install/update.ts`
- Modify: `tests/cli/args.test.ts`
- Modify: `tests/install/plan.test.ts`
- Modify: `tests/install/update.test.ts`
- Modify: `tests/install/uninstall.test.ts`

Add an advanced repeatable option:

```text
--hook-target claude=project-local
```

Rules:

- Omission uses the adapter's managed default.
- Only adapter-declared writable targets are accepted.
- Plugin and inspect-only surfaces are rejected.
- Manifest v2 `hooks[].path` persists the selected path.
- Update reuses the path from the existing manifest unless the user explicitly changes it.
- One installation still owns at most one hook surface per harness.
- Changing target removes only owned handlers from the old target and adds owned handlers to the new target transactionally.

Do not add `surfaceId` to manifest. Paths must be unique within an adapter, so the adapter can recover the surface ID from the persisted path.

The concrete blocker is `runtime/src/install/ownership.ts:80`, where `assertSupportedHookRecords()` pins `hook.path` to the single default `hookRegistrationPath(harness, scope, root)`. Replace that equality with a lookup:

```text
persisted path
  -> adapter surface lookup
  -> recognized + writable + scope-compatible
  -> ownership accepted
```

Anything the lookup does not recognize still throws `MANIFEST_OWNERSHIP_INVALID`.

No manifest schema change is required: the existing `relativePath` pattern in `schemas/manifest.schema.json:51` already accepts `.claude/settings.local.json`. Add an acceptance test pinning that fact instead of touching the pattern.

## Task 15: Verify scope and disclosure boundaries

```bash
npm run test:compile
node scripts/run-tests.mjs \
  .tmp/test-dist/tests/install/surfaces.test.js \
  .tmp/test-dist/tests/install/surface-inspection.test.js \
  .tmp/test-dist/tests/install/doctor.test.js \
  .tmp/test-dist/tests/install/plan.test.js \
  .tmp/test-dist/tests/install/update.test.js \
  .tmp/test-dist/tests/install/uninstall.test.js \
  .tmp/test-dist/tests/cli/args.test.js \
  .tmp/test-dist/tests/cli/plan-output.test.js
```

Expected: PASS, including fake-secret non-disclosure tests.

**Commit:**

```bash
git add runtime/src/install runtime/src/adapters packages/cli/src tests/install tests/cli tests/fixtures/harness-surfaces
git commit -m "feat(harness): discover and select safe configuration surfaces"
```

---

# PR 5 — Config v2 and explicit Stop opt-in

## Task 16: Separate schema version constants without changing numbers

**Files:**

- Modify: `runtime/src/contracts.ts`
- Modify: internal imports under `runtime/src/`
- Modify: `packages/cli/src/context.ts`
- Modify: `tests/schema/validate.test.ts`
- Modify: schema fixtures using `schemaVersion`

Introduce:

```ts
export const CONFIG_SCHEMA_VERSION = 1 as const;
export const TASK_SCHEMA_VERSION = 1 as const;
export const EVIDENCE_SCHEMA_VERSION = 1 as const;
export const MANIFEST_SCHEMA_VERSION = 2 as const;
```

Remove internal dependence on one ambiguous `SCHEMA_VERSION`. If retaining it temporarily for external compatibility, mark it deprecated and define precisely which document it versions.

`runtime/src/config/migrate.ts` compares against `SCHEMA_VERSION` in three places; all three mean the config document and must move to `CONFIG_SCHEMA_VERSION`.

Run all schema/config/task/evidence tests before changing any version number.

## Task 16A: Unify the config hash on canonical JSON

**Files:**

- Modify: `runtime/src/verify/evidence.ts`
- Create: `runtime/src/config/hash.ts` or move `canonicalJson`/`calculateConfigHash` into a shared module
- Modify: `runtime/src/security/trust.ts` call sites
- Modify: `packages/cli/src/context.ts`
- Modify: `packages/cli/src/bin.ts`
- Modify: `tests/security/trust.test.ts`
- Modify: `tests/verify/evidence.test.ts`

Two hash functions exist today and disagree:

- trust: `sha256(JSON.stringify(config))` at `packages/cli/src/context.ts:119` and `packages/cli/src/bin.ts:327`, which is property-order dependent;
- evidence: `calculateConfigHash()` at `runtime/src/verify/evidence.ts:60`, key-sorted canonical JSON.

Keep the canonical one. Trust grant, trust status, evidence, and Stop must all call it. Add a regression test proving two configs that differ only in property order hash identically, and one proving a `features` change does alter the hash.

Do this in PR 5 rather than PR 6b: switching the algorithm rebinds trust exactly like the config v2 field addition does, and users should absorb one trust refresh, not two.

## Task 17: Define config v2 Stop feature and migration

**Files:**

- Modify: `runtime/src/contracts.ts`
- Modify: `schemas/config.schema.json`
- Modify: `runtime/src/schema/validate.ts`
- Modify: `runtime/src/config/migrate.ts`
- Modify: `runtime/src/config/merge.ts`
- Modify: `runtime/src/config/explain.ts`
- Modify: `packages/cli/src/context.ts`
- Modify: `tests/config/migrate.test.ts`
- Modify: `tests/config/merge.test.ts`
- Modify: `tests/config/explain.test.ts`
- Modify: `tests/schema/validate.test.ts`
- Add: `tests/fixtures/migrations/config-v2.json`
- Modify: `tests/fixtures/schema/valid-config.json`

Target config shape:

```ts
export interface AgentOpsFeatures {
  readonly stopVerification: {
    readonly enabled: boolean;
  };
}

export interface AgentOpsConfig {
  readonly schemaVersion: 2;
  readonly profiles: Profile[];
  readonly verification: VerificationConfig;
  readonly features: AgentOpsFeatures;
  readonly pathMappings: PathMapping[];
  readonly securityExceptions: SecurityException[];
}
```

Migration v1 to v2 always writes:

```json
{
  "features": {
    "stopVerification": {
      "enabled": false
    }
  }
}
```

Do not infer consent from `guardrails` or from an already-managed Stop handler.

`features` is required in the v2 schema, and the migration always supplies it, so a hand-written v2 config without it fails validation deterministically rather than defaulting silently.

Runtime validation must reject `enabled: true` when verification commands are empty. Document that enabling Stop requires confirmed commands and refreshed repository trust.

**Trust consequence.** The trust binding hashes the complete effective config, so adding `features` invalidates every existing binding. After migration each repository reports `STALE` until the user runs `agent-ops trust grant`. Affected flows are every trust-gated one—`verify`, all hooks, doctor's trust check, and verification attached to tasks. Plain task CRUD is unaffected. Add a migration test asserting the pre-migration binding no longer validates and that the post-grant binding does, and put the required command in the migration notes.

## Task 18: Resolve capabilities from profiles plus explicit features

**Files:**

- Modify: `runtime/src/install/profiles.ts`
- Modify: `runtime/src/install/types.ts`
- Modify: `runtime/src/install/plan.ts`
- Modify: `runtime/src/install/hooks.ts`
- Modify: `runtime/src/install/probes.ts`
- Modify: `packages/cli/src/commands/hook.ts`
- Modify: `packages/cli/src/wizard.ts`
- Modify: `tests/install/profiles.test.ts`
- Modify: `tests/install/plan.test.ts`
- Modify: `tests/install/probes.test.ts`
- Modify: `tests/cli/ui.test.ts`

Required mapping:

```text
core       -> rules, task, verify, review
advisory   -> lifecycle-summary, local-log
guardrails -> command-policy

features.stopVerification.enabled
            -> optional-stop-verify
```

Keep `resolveProfiles()` for profile-only behavior and add a config-aware resolver rather than silently changing every call site:

```ts
resolveCapabilities(config: AgentOpsConfig): ResolvedCapabilities
```

Update wizard description to remove the claim that guardrails enables Stop.

**Registration drift.** Native registrations are produced at plan time, so editing `features.stopVerification.enabled` to `true` leaves runtime willing and the harness silent: no `Stop` handler exists until `update` rewrites the hook file. Cover this in two places.

Doctor gains a check comparing `resolveCapabilities(config)` against the manifest's recorded events and the on-disk handlers. A mismatch is installation drift, not partial function, so report it as `FAIL` with code `UPDATE_REQUIRED` rather than `DEGRADED`; the one forbidden outcome is `PASS`. Both directions matter: a desired capability with no registration, and an owned registration for a capability no longer desired.

Documentation states the required sequence explicitly:

```bash
agent-ops update
agent-ops trust grant
```

## Task 19: Reconcile old owned Stop handlers on update

**Files:**

- Modify: `tests/install/update.test.ts`
- Modify: `tests/install/uninstall.test.ts`
- Modify: `tests/e2e/harness-matrix.test.ts`
- Modify: `runtime/src/install/update.ts` and `runtime/src/install/plan.ts` only if a test proves a gap
- Modify: adapter merge/strip code only if a test proves a gap

This task is mostly verification, not new code. `mergeClaudeSettings()` at `runtime/src/adapters/claude/config.ts:191` already strips every owned handler across all events before appending the currently managed ones, and the Codex merge follows the same shape. Stop handlers owned by agent-ops should therefore disappear on the first update after migration with no adapter change at all.

Write the tests first and let them decide the scope. Required behavior after config migration disables Stop:

- strip only handlers carrying the agent-ops marker;
- preserve foreign Stop handlers and matcher groups;
- keep command-policy handlers for guardrails;
- remove an empty agent-ops-only settings file when normal ownership rules permit;
- rewrite the manifest hook record so its `events` no longer advertise `Stop`;
- make repeated update idempotent.

If every assertion passes untouched, ship the tests alone and say so in the PR.

## Task 20: Verify config and migration behavior

```bash
npm run test:compile
node scripts/run-tests.mjs \
  .tmp/test-dist/tests/config \
  .tmp/test-dist/tests/schema/validate.test.js \
  .tmp/test-dist/tests/security/trust.test.js \
  .tmp/test-dist/tests/verify/evidence.test.js \
  .tmp/test-dist/tests/install/profiles.test.js \
  .tmp/test-dist/tests/install/plan.test.js \
  .tmp/test-dist/tests/install/update.test.js \
  .tmp/test-dist/tests/install/uninstall.test.js \
  .tmp/test-dist/tests/e2e/harness-matrix.test.js \
  .tmp/test-dist/tests/cli/ui.test.js
```

Expected: PASS.

**Commit:**

```bash
git add runtime/src schemas/config.schema.json packages/cli/src tests/config tests/schema tests/security tests/verify tests/install tests/e2e tests/cli tests/fixtures
git commit -m "feat(config): make Stop verification explicitly opt in"
```

### PR 5 migration impact

- Config schema changes from 1 to 2.
- Manifest stays at 2.
- New guardrails installations no longer register Stop.
- Updating an old guardrails installation removes only agent-ops-owned Stop handlers.
- Every repository trust binding becomes `STALE`, for two compounding reasons: the config gains `features`, and the hash algorithm becomes canonical. Users must run `agent-ops trust grant` once. Until then, every trust-gated verification and hook flow reports untrusted; plain task CRUD keeps working.
- Older 0.1.x binaries cannot read config v2; release this sequence as a minor pre-1.0 version and document that completed migration is not downgrade-compatible.

---

# PR 6a — Task-independent command executor extraction

Pure refactor. No installed behavior changes, no new subprocess sites, no adapter changes. It ships separately so PR 6b's first-time execution of configured commands from a lifecycle hook has a clean rollback point beneath it.

## Task 21: Extract a task-independent configured-command executor

**Files:**

- Create: `runtime/src/verify/command-executor.ts`
- Modify: `runtime/src/verify/service.ts`
- Modify: `runtime/src/verify/spawn.ts`
- Create: `tests/verify/command-executor.test.ts`
- Modify: `tests/verify/service.test.ts`
- Modify fake process runners across `tests/verify/`

Extract the existing command execution, timeout, test-count classification, and required-command aggregation so task verification and Stop verification use the same implementation.

The extracted executor must not persist task evidence. `VerificationService` remains responsible for mapping command results to task criteria and saving evidence files.

Add optional child environment overrides to `ProcessRequest`:

```ts
readonly env?: Readonly<Record<string, string>>;
```

`NodeVerificationProcessRunner` merges only explicitly provided keys over `process.env`. Tests must confirm no environment values are returned in reports.

### PR 6a release gate

- `npm test` passes with no test rewritten to accommodate a behavior change.
- Task verification output is byte-identical to the pre-refactor output for the same fixtures.
- No new call site executes a configured command.

**Commit:**

```bash
git add runtime/src/verify tests/verify
git commit -m "refactor(verify): extract a task-independent command executor"
```

---

# PR 6b — Real advisory and Stop execution, native failure semantics

## Task 21A: Wire the advisory implementation

**Files:**

- Modify: `packages/cli/src/commands/hook.ts`
- Modify: `packages/cli/src/hook-process.ts`
- Modify: `runtime/src/install/doctor.ts`
- Modify: `tests/cli/hook-command.test.ts`
- Modify: `tests/hooks/engine.test.ts`
- Modify: `tests/adapters/opencode.test.ts`

`dispatchHookEvent` runs the advisory branch only when `options.advisory` is supplied, and `runHookCommand` never supplies it, so every real `SessionStart` currently returns `HOOK_NOOP` / `PASS` on all three harnesses. Supply the real advisory implementation from the hook command, using the same bounded, fail-open contract the dispatcher already assumes: an advisory failure returns `UNKNOWN` and never becomes verification evidence.

Then flip the PR 3 support declarations: `lifecycle-summary` moves from `unsupported` to `supported`, except OpenCode, which stays `degraded` because its plugin initializes once per app rather than once per session.

The PR 3 contract test—every `supported` registration is reachable through `runHookCommand`—must now pass with `lifecycle-summary` included.

## Task 22: Implement StopVerificationService

**Files:**

- Create: `runtime/src/hooks/stop-service.ts`
- Modify: `runtime/src/hooks/events.ts`
- Modify: `runtime/src/hooks/stop-verify.ts`
- Create: `tests/hooks/stop-service.test.ts`
- Modify: `tests/hooks/stop-verify.test.ts`

Service input:

```ts
interface StopVerificationServiceOptions {
  readonly root: string;
  readonly config: AgentOpsConfig;
  readonly trusted: boolean;
  readonly gitRunner: GitRunner;
  readonly processRunner: VerificationProcessRunner;
  readonly recursionActive: boolean;
  readonly configHash: string;
}
```

Flow:

1. Require config feature enabled.
2. Require non-empty confirmed verifier commands.
3. Require current trust binding.
4. Reject native or environment recursion markers.
5. Collect bounded change surface.
6. Select verifier IDs through existing path mappings and fallback rules.
7. Execute selected commands through the shared command executor.
8. Aggregate `PASS`, `FAIL`, or `UNKNOWN`.
9. Return only command ID, exit code, and test count as bounded hook evidence.
10. Do not persist task evidence and do not update task status.

Set a private child marker such as `AGENT_OPS_STOP_VERIFY_ACTIVE=1` for verifier subprocesses. Never print it or treat it as repository trust.

Stop v1 is report-only: `PASS`, `FAIL`, and `UNKNOWN` all return `action: "continue"`. A future blocking mode requires a separate design and explicit config migration.

Because report-only makes it unreachable, delete the `event === "Stop" && result.action === "block"` branch in `runtime/src/adapters/claude/output.ts:33` and its test. Reintroducing blocking later means a new design, a config migration, and native fixture tests anyway; a dormant branch would only look like tested capability.

## Task 23: Wire the real hook process

**Files:**

- Modify: `packages/cli/src/hook-process.ts`
- Modify: `packages/cli/src/commands/hook.ts`
- Modify: `packages/cli/src/context.ts`
- Modify: `runtime/src/adapters/claude/input.ts`
- Modify runtime adapters only where native recursion metadata exists
- Modify: `tests/cli/hook-command.test.ts`
- Create or modify: `tests/cli/hook-process.test.ts`

The hook process must retain raw parsed input long enough for the runtime adapter to detect native recursion metadata, while normalized policy dispatch still receives only bounded fields.

Build `stopVerification` options only when:

- normalized event is `stop`;
- the explicit feature is enabled;
- the adapter registration spec does not mark Stop unsupported.

Use the single canonical config hash function unified in Task 16A. Do not introduce a second JSON serialization rule.

## Task 24: Apply adapter-specific runtime-failure behavior

**Files:**

- Modify: `packages/cli/src/hook-process.ts`
- Modify: `runtime/src/adapters/codex/output.ts`
- Modify: `runtime/src/adapters/claude/output.ts`
- Modify: `runtime/src/adapters/opencode/config.ts`
- Modify: `runtime/src/install/doctor.ts`
- Modify adapter and shim tests

Rules:

- Advisory runtime failure: continue and report `UNKNOWN` when the native protocol can carry it.
- Verified command-policy denial: fail closed only for adapters with fixture-tested native denial.
- Native denial unknown: fail open operationally, report capability `UNKNOWN` or `DEGRADED`, and never display enforcement `PASS`.
- Stop report failure: continue with `FAIL` or `UNKNOWN`; it is not a completion gate.
- OpenCode shim retains its existing missing-runtime fail-closed behavior for command policy.

Do not globally change `HookProcessOutput.exitCode` without adapter-specific native tests.

## Task 25: Complete adapter and end-to-end coverage

**Files:**

- Modify: `tests/hooks/engine.test.ts`
- Modify: `tests/hooks/stop-verify.test.ts`
- Modify: `tests/hooks/stop-service.test.ts`
- Modify: `tests/adapters/codex.test.ts`
- Modify: `tests/adapters/claude.test.ts`
- Modify: `tests/adapters/opencode.test.ts`
- Modify: `tests/adapters/opencode-shim.test.ts`
- Modify: `tests/install/doctor.test.ts`
- Modify: `tests/e2e/harness-matrix.test.ts`

Required cases:

- enabled/disabled Stop;
- trusted, stale, and untrusted config;
- config hash mismatch;
- no commands;
- no changed paths and fallback selection;
- matched path mapping;
- recursion marker;
- process timeout;
- missing executable;
- nonzero exit;
- zero tests;
- malformed or oversized evidence;
- advisory runtime failure;
- advisory reached through the real `runHookCommand` path on each harness;
- command-policy runtime failure per adapter;
- unsupported Stop adapter;
- degraded OpenCode idle mapping;
- foreign Stop handler preservation;
- capability desired but not registered, reported as `UPDATE_REQUIRED`;
- trust stale after config migration, and valid after `trust grant`.

## Task 26: Update user-facing documentation

**Files:**

- Modify: `README.md`
- Modify: `docs/en/guides/configuration.md`
- Modify: `docs/zh-TW/guides/configuration.md`
- Modify: `docs/en/spec/harness-adapters.md`
- Modify: `docs/zh-TW/spec/harness-adapters.md`
- Modify: `docs/en/spec/README.md`
- Modify: `docs/zh-TW/spec/README.md`

Document:

- project policy remains authoritative;
- surface discovery and target policy;
- guardrails no longer implies Stop;
- Stop is explicit, trusted, report-only, and does not complete tasks;
- adapter support is supported/degraded/unsupported/unknown;
- plan output omits foreign settings values;
- manifest remains schema v2;
- config migrates to v2;
- config migration requires one `agent-ops trust grant`;
- changing a capability in config requires `agent-ops update` before the harness registers it;
- routing migration is one-way once applied;
- downgrade limitation.

## Task 28: Run final automated verification

Run each command separately and require success:

```bash
npm run typecheck
npm test
npm run build
npm run package:check
git diff --check
```

Expected:

- Typecheck exits 0.
- Complete suite reports a non-zero test count and zero failures.
- Build produces `dist/packages/cli/src/bin.js`.
- Package check exits 0.
- Diff check emits no whitespace errors.

## Task 29: Run disposable project smoke tests

Create a temporary generic repository outside the source tree and test:

```bash
node dist/packages/cli/src/bin.js init \
  --scope project \
  --harness all \
  --profile core \
  --dry-run \
  --json
```

Then apply in the disposable repository, run doctor, update dry-run, and uninstall dry-run. Confirm:

- no harness/profile is silently selected in interactive mode;
- core creates no hook registrations;
- advisory creates only advisory registrations;
- guardrails creates command policy but no Stop;
- explicit Stop config requires commands and trust;
- enabling Stop in config without running update is reported as `UPDATE_REQUIRED`, not `PASS`;
- doctor reports OpenCode lifecycle degradation honestly;
- advisory actually runs on a real SessionStart instead of returning `HOOK_NOOP`;
- public plans contain no foreign settings values.

## Task 30: Run read-only comparison-repository smoke

Manual, non-blocking, and explicitly outside the "previous PR accepted" gate in the handoff section. It must never become a repository fixture or CI dependency, and a failure here is a bug report, not a merge block.

From `<comparison-repo>`—an existing multi-harness repository chosen by the operator, never a hard-coded absolute path—run only dry-run and doctor-style inspection commands. Do not apply changes. Confirm:

- existing `AGENTS.md` and `CLAUDE.md` are treated as project-owned policy;
- proposed routing is supplemental;
- `.claude/settings.local.json` is inventoried without printing values;
- existing Codex and Claude handlers remain foreign;
- no plugin, model, permission, command, or comparison-project fact is copied into agent-ops output;
- `git status --short` remains unchanged.

## Task 31: Commit PR 6b

```bash
git add runtime/src/hooks runtime/src/verify runtime/src/adapters runtime/src/install packages/cli/src tests README.md docs/en docs/zh-TW
git commit -m "feat(hooks): run explicit Stop verification through adapters"
```

---

## Release and rollback plan

Release the completed sequence as a new pre-1.0 minor version, not a patch, because config schema and guardrails behavior change.

Before release:

1. Publish migration notes for config v1 to v2.
2. State that manifest remains v2.
3. State that new and migrated guardrails configs do not imply Stop.
4. State that old binaries cannot read migrated config v2.
5. State that dry-run public operation contents are opaque for harness settings.
6. State that project-local Claude settings require explicit target selection.
7. State that one `agent-ops trust grant` is required after migration, and why.
8. State that the routing migration in PR 1 is one-way once applied.

Rollback boundaries:

- Source-level revert of PRs 1–4 is safe only while no user has applied the corresponding update.
- PR 1 becomes a one-way installed-state migration the moment a user runs `update`: a pre-PR-1 binary reads the new managed body as tampering and refuses to update or uninstall. Recovery is forward, not downgrade.
- PR 5 cannot be downgraded with an older binary after config v2 is written; rollback requires restoring the prior config or reinstalling with the older release. The trust rebinding is not reversible by downgrade either.
- PR 6a is revertible independently of PR 6b, which is the reason for the split.
- Every update must remain transactionally all-or-nothing.
- Failed surface changes must leave both source and destination settings untouched.
- Failed Stop execution must never mutate config, task state, or manifest.

## Performance constraints

- Surface inspection reads each regular file at most once and remains bounded to the existing doctor/update maximum unless a lower harness-specific maximum is selected.
- Plugin inventory reports presence/status only; do not recursively scan plugin caches.
- Registration support matrices are static in-memory data.
- Stop verification reuses existing bounded process output and timeout behavior.
- No lifecycle handler may perform repository-wide search outside configured verification commands.

## Security constraints

- Never output foreign settings values in human or JSON plans.
- Never log raw hook payloads, commands, permission entries, environment values, or secrets.
- Preserve no-follow, regular-file, containment, identity, and size checks.
- Never use a PATH-resolved managed runtime.
- User/global writes require explicit user scope; project-local writes require explicit target selection.
- Plugin surfaces are inventory-only.
- Runtime-failure behavior must match the adapter support matrix; no universal fail-closed claim.
- Stop commands require confirmed config and current trust.

## Observability changes

Doctor may add sanitized surface and capability status, but output is limited to harness ID, surface ID, redacted path, status, support level, and handler counts. It must never emit foreign handler content.

Stop evidence contains only command IDs, exit codes, test counts, config hash, and timestamp. It does not contain stdout, stderr, task content, hook payloads, or environment values.

## Implementation handoff

Use a dedicated worktree and execute PRs in order. For each PR:

1. Start from the prior merged PR.
2. Follow red-green-refactor per task.
3. Run the focused tests listed for that PR.
4. Run `npm run typecheck` and `git diff --check` before committing.
5. Request fresh-context review before opening the PR.
6. Do not begin the next PR until the previous migration and ownership behavior is accepted. Task 30 is exempt: it is a manual, non-blocking smoke and never gates the next PR.
