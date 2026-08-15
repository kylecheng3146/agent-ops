# External Review CLI Targets Implementation Plan

> **Historical note (2026-08-14):** This plan describes the currently shipped
> target chain. Its prompt-only structured-output, tolerant JSON extraction,
> and repository-cwd decisions are superseded by the
> [Detailed Independent Review Roadmap](./2026-08-14-detailed-independent-review-roadmap.md).

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make `agent-ops review` actually spawn an independent reviewer. Today `packages/cli/src/commands/review.ts:78` defaults `execute` to `{ status: "NOT_RUN", reason: "missing-cli" }`, so no CLI is ever invoked and the whole review path is inert. Give it an ordered fallback chain of external agent CLIs — `codex`, `agy` (Antigravity), `claude` — configured at `agent-ops init`, executed read-only, parsed into the existing `ReviewCriterionResult` shape, and recorded against the active task.

**Architecture:** Four independent gaps, each addressed on its own seam.

1. *No targets.* `runtime/src/review/roles.ts` already defines `ReviewRoleConfig { role, harness, model, effort }` and `resolveReviewRole()`, but `bin.ts:260` passes no `roles` and `schemas/config.schema.json` has no field for them. Dead wiring. Add an optional `reviewRoles` config field and a `ReviewTargetId` type distinct from `HarnessId`.
2. *No executor.* Build `execute` as a thin shell over the existing `runVerificationCommand()` (`runtime/src/verify/spawn.ts`), which already provides detached spawn, timeout, output truncation, POSIX process-group / Windows `taskkill /T` teardown, and — critically for the fallback chain — `failureClass: "missing-executable"` on ENOENT.
3. *No content.* `review.ts:47` fabricates `description: id`, so the reviewer receives `criterion: c1` and reviews nothing. Pull real `AcceptanceCriterion` descriptions from the task store; `TaskService` is already constructed at `bin.ts:245`, in scope and unused by the review branch.
4. *No visibility.* Add one doctor check so a stale login is diagnosable after init.

**Tech Stack:** TypeScript 7, Node.js 22 ESM, node:test, existing CLI envelope / command registry.

## Prerequisite: real stdout fixtures — DONE

Captured 2026-08-12 into `tests/fixtures/review/` (see its `README.md` for the exact
argv per file). What the capture established, all of it contradicting an assumption
this plan originally carried:

- **Every envelope uses a different key.** claude `.result`, agy `.response`. They are
  not near-identical, as first assumed — no two targets share an extraction branch.
  agy additionally carries `status: "SUCCESS"`; claude carries `is_error` / `subtype`.
- **codex stdout is already the bare final message** (`OK\n`). All progress — banner,
  workdir, model, `sandbox: read-only`, hook events — goes to **stderr**. So codex
  needs neither `--json` nor `-o <FILE>`; `extractFinalMessage` returns stdout verbatim.
  (stderr's first line is `Reading additional input from stdin...`, triggered by
  `spawn.ts` setting stdin to `ignore`. Harmless, but it confirms codex reads stdin.)
- **opencode cannot be a review target.** `--agent plan` is rejected — *"agent 'plan'
  is a subagent, not a primary agent. Falling back to default agent"* — and the
  fallback is **silent in the exit code**. There is no flag that makes opencode
  read-only, so it fails the hard precondition below. Its backend also returned
  `Unexpected server error` on both attempts, so no usable transport fixture exists.

## Design decisions

Recorded so implementation does not relitigate them.

### Routing

- **Configuration-driven, not detection-driven.** Which CLI reviews is declared in `.agent-ops/config.json`, never inferred. Host detection is used only to reorder the chain (see below). Sniffing per-harness environment markers is unverifiable for two of the three targets, and a detector that silently guesses wrong is worse than no detector.
- **`reviewRoles` is an optional field at `schemaVersion: 2`. Do not bump the schema version.** `schemaVersion` exists for breaking changes; an optional field leaves every existing config valid and `runtime/src/config/migrate.ts` untouched. A 2→3 migration whose entire body is "add an empty array" is equivalent to reading `?? []`, which `review.ts:63` already does.
- **`schemas/config.schema.json` must declare `reviewRoles`.** The root is `additionalProperties: false`, so an undeclared field would fail our own validation on write. This is a checklist item, not a choice.
- **`ReviewTargetId = "claude" | "codex" | "agy"` is a new type. `HarnessId` is not touched and no `agy` install adapter is written.** `HarnessId` means "a harness agent-ops can install configuration into" — each id is bound to an adapter, surfaces, events, ownership, and doctor drift checks in `runtime/src/install/harness.ts`. A review target only means "a CLI that can be invoked". Adding `agy` to `HarnessId` would either demand a full adapter (a separate feature, roughly an order of magnitude larger than this one) or leave a fake branch in every exhaustive switch.
- **`ReviewRoleConfig.harness` is renamed to `targets: readonly ReviewTargetId[]`.** No caller passes `roles` today, so the rename costs nothing now and never gets cheaper.
- **Multi-select means an ordered fallback chain, not fan-out.** Try each target in order; the first one that actually runs produces the verdict. Fan-out would multiply cost by N and require reworking `aggregateReviewResults`, which consumes a single result set. Fan-out remains addable later without changing the config format.
- **`opencode` is deliberately not a review target.** It has no read-only mechanism (see Prerequisite), and the silent fallback to a writable agent means shipping it would put an agent that *can edit files* in charge of reviewing them — the one thing the read-only precondition exists to prevent. The upgrade path is a separate feature: `runtime/src/adapters/opencode/config.ts` already manages opencode configuration, so agent-ops could install a managed read-only **primary** agent (`agent-ops-review`) and pass `--agent agent-ops-review`. That cost lands entirely on the install side (config write, ownership, manifest, drift check) and is independent of everything in this plan — adding it later means one more legal value in `ReviewTargetId`, with zero change to the executor.
- **Chain order is the option-list declaration order: `codex → agy → claude`.** `selectOptions()` (`packages/cli/src/ui.ts:339`) returns `choices.filter(...).map(...)`, so click order is discarded by construction. Custom order is expressed by hand-editing `targets` in `config.json` — an escape hatch the optional-field decision already gives us for free. Writing a reordering TUI would cost ~100 lines of new UI to replace editing one JSON line, and changing `selectOptions` to preserve click order would regress the two existing multi-selects that depend on stable declaration order.
  - Default order rationale: `codex` needs no envelope parsing at all (bare stdout); `agy` is a single flat envelope; `claude` is last because it is the most likely host, so the default order and the host-reordering rule push in the same direction instead of fighting.
- **Host detection recognizes `CLAUDECODE` only, and reorders rather than filters.** A detected host target moves to the end of the chain. If it is the only target, it still runs, with a `reviewer == host` warning in the output. Filtering would need a separate empty-chain recovery branch; a stable sort needs none. `AI_AGENT` is not an official Claude Code variable and must not be relied on.

### Execution

- **Process execution reuses `runVerificationCommand()`.** The chain's core predicate — `failureClass === "missing-executable"` — already exists there, along with the Windows teardown branch a bespoke spawner would have to reimplement. Accept borrowing the `VerificationCommand` type; the alternative (borrowing only `ProcessRequest` / `NodeVerificationProcessRunner`) means rewriting the timeout and truncation orchestration that lives in the function body. Do **not** refactor a shared process layer out of `verify/` — that is a separate change against already-tested code.
- **Read-only enforcement is a hard precondition, not an advisory.** Each target must be launched with its own read-only flag: `codex -s read-only`, `agy --sandbox --mode plan`, `claude --permission-mode plan`. A target for which no read-only flag can be passed is not eligible for the chain — it is skipped, never run on prompt-based trust. This precondition is what excluded opencode. `--disallowedTools` is deliberately **not** layered on; the sandbox flags are the officially supported mechanism.
- **Per-target timeout defaults to 120s, not the `spawn.ts` default of 5 minutes,** overridable via `reviewRoles[].timeoutMs`. Because timeout advances the chain (below), the 5-minute default would make the worst case 20 minutes. Each attempt prints one progress line (`codex: timed out after 120s → trying agy`); for a foreground command, invisibility hurts more than duration.
- **Do not pass `agy --print-timeout`.** Two timeout layers fight; the outer one already handles process-group teardown, and an inner timeout would let the child exit gracefully and bypass our classification.
- **The prompt travels through argv and stays short.** It instructs the target to inspect the repository itself (`git diff`, reading files) inside its read-only sandbox. Do **not** embed a diff: `spawn.ts:283` sets `stdio: ["ignore", "pipe", "pipe"]` so stdin is unavailable, and an argv-embedded diff risks `ARG_MAX` and exposes the full diff in `ps` output to every user on the machine. `redactSecrets` is applied to results only, never to the outgoing prompt.
- **`--yes` authorization is unchanged.** `bin.ts:261` already gates on it. Init selection answers "which targets are permitted"; `--yes` answers "spend money now". Merging them would let anyone who clones a repo with a committed `config.json` burn the configured targets' quota on their first `review`. Zero lines change.

### Chain advancement

Advance to the next target only when no review actually happened:

| Outcome | Advance? |
|---|---|
| `missing-executable`, `spawn-failed` | yes |
| `timeout` | yes |
| `unparseable-output` (including protocol violations) | no — terminal |
| `PASS`, `FAIL` | no — terminal |

- **`FAIL` must never advance.** Otherwise the mechanism becomes automated review shopping: retry CLIs until one says PASS, producing a record that looks like a passing review. This is the load-bearing rule of the whole feature.
- **`unparseable-output` does not advance** because it indicates a prompt-contract or CLI-version mismatch — a configuration bug that should surface rather than be masked by trying another vendor.
- **`login-required` and `quota-exhausted` detection is not implemented.** Both enum members stay in `ReviewUnavailableReason` unused. Detecting them requires per-vendor stderr string matching, which breaks on CLI updates and buys only a prettier message; an unauthenticated CLI exits non-zero and lands correctly on "terminal".
  - Consequence to handle explicitly: the single most common first-run failure is an unauthenticated CLI, and it will present as one unexplained review failure. The failure output must therefore point at doctor (`Run: agent-ops doctor --check-auth to verify target authentication.`).

### Output parsing

- **Two layers.** A per-target `extractFinalMessage(target, stdout)` handles the transport differences, then a single shared `extractJsonObject(text)` handles content. Never run a "last balanced `{…}`" scan over a whole stdout: the envelopes are themselves JSON objects, so a flat scan could capture the envelope instead of the model's answer — a silent, hard-to-reproduce wrong result.
  - `codex`: stdout verbatim. No envelope, no parsing (progress goes to stderr).
  - `claude`: `JSON.parse(stdout).result`.
  - `agy`: `JSON.parse(stdout).response`. **Not `.result`** — verify against the fixture, not against intuition.
  - Each branch is distinct; do not attempt to share one.
- **No structured-output flags, and therefore no temp files at all.** `codex --output-schema` and `agy --json-schema` were considered as belt-and-braces on top of the prompt contract and are deliberately dropped: they were the only thing in this feature that needed a scratch file, so dropping them removes `fs.mkdtemp`, the cleanup path, and the "temp files are removed even on timeout" test. The prompt contract already carries the requirement; add the flags only if real runs show models violating it. codex's `-o <FILE>` is likewise unnecessary now that stdout is known to be clean.
- **Protocol violations are `NOT_RUN`, not `FAIL`.** `aggregateReviewResults` (`runtime/src/review/result.ts:14`) currently sets `valid = false` — and therefore an overall `FAIL` — when a criterion is missing, duplicated, unrequested, or has empty evidence. Combined with "FAIL is terminal and gets recorded", one sloppy model response would end the chain and write a false failure into task evidence that `service.ts:304` then makes hard to correct. `FAIL` must mean "the reviewer looked and judged it inadequate". Change the `valid` flag's exit path so the runner can report `unparseable-output`; `ReviewCriterionResult.status` stays `"PASS" | "FAIL"`.

### Content and persistence

- **Criteria descriptions come from the task store.** Read the `AgentTask` bound to the current session (`AGENT_OPS_SESSION_ID`, `runtime/src/task/service.ts:268`) and use its real `AcceptanceCriterion.description`. `--criteria` degrades to a filter over those ids, so `args.ts:225` parsing is unchanged. Pass `verifierIds` into the prompt too, so the reviewer is told which criteria machine verification already covers and does not burn tokens redoing `runVerificationCommand`'s work.
- **No bound task is `NOT_RUN` with a new reason `no-task-context`,** not a fallback to id-as-description. A review with no criteria descriptions is guaranteed meaningless, and producing a record that looks reviewed is worse than reporting that it could not run.
- **Results are written through the existing `recordCriterionEvidence`, with each evidence string prefixed `review:<target>:`.** `CriterionEvidenceInput` (`service.ts:37`) is `Record<criterionId, readonly string[]>` and `ReviewCriterionResult` is `{ criterionId, status, evidence }` — the shapes already match, so no new persistence code is needed. The prefix exists because `VerificationEvidence` otherwise means "replayable machine fact" (`argv`, `exitCode`, `testCount`, `configHash`); an LLM's claim and a passing test suite differ by an order of magnitude in trustworthiness and must stay distinguishable, and greppable.
- **Write only while the task is `active`. When it is `complete`, print without writing.** `service.ts:304-311` rejects evidence that differs from what a completed task recorded; a re-run whose wording differs would throw. That check guards completed records against retroactive edits and must not be loosened for review.

### init

- **Interactive flow: a yes/no question defaulting to No, then a multi-select, then a real login probe per selected target.** The probe is a minimal print call — the only check that actually proves authentication. Credential-file checks lie (file present, token expired) and self-declaration ("already logged in? y/N") lies on the user's behalf; a check that can lie is worse than no check.
- **Probe failure warns, never blocks installation.** Login state is a mutable environment fact; blocking a one-time setup on a transient condition is wrong. Print the fix and continue.
- **The non-interactive init path skips the probe entirely** (`wizard.ts:160-170`). CI must not make network calls.
- **Non-interactive configuration uses a repeatable `--review-target <id>` flag,** matching the existing repeatable `--profile` accumulation in `args.ts`. A comma-separated variant would be the only flag in the CLI with that shape.
- **All three defaults point the same way: field absent, flag absent, and the interactive question's default all mean the feature is off.** Defaulting on would make an uninformed user spend money on their first `agent-ops review`. Three entry points giving one answer is the shape that does not produce bugs.

### doctor

- **One new check, `review-targets`, whose depth is controlled by a dedicated `--check-auth` flag.** By default it only verifies executable presence (zero tokens, zero network) because doctor runs often, including in CI. `--check-auth` additionally runs the init probe.
  - **Do not reuse `--yes` for this.** `docs/plans/2026-08-05-doctor-remediation-and-exit-codes.md` recorded that `--yes` stays inert for doctor specifically so a diagnostic command does not acquire side effects from a generic flag. Spending tokens and making network calls is a side effect, so that decision applies here; `--check-auth` states exactly what it authorizes.
- **Guidance ships in `DoctorCheck.message`, not in a `remediation` field.** As of this plan the 2026-08-05 doctor remediation plan is **unimplemented** — `grep -rn remediation runtime packages tests` returns nothing and no branch carries it. Using `message` removes any dependency on that plan; if it lands later, moving these strings into `remediation` is mechanical.
- **Two checks (`-installed` / `-auth`) are not used.** A permanently-`UNKNOWN` check would reopen the exact "a healthy install exits non-zero" problem in `packages/cli/src/commands/doctor.ts` that the 2026-08-05 plan exists to fix.
- **`--fix` (interactive `codex login` handoff) is explicitly out of scope for this plan.** Every target authenticates through interactive OAuth, so no fix can be automated — only handed to a human. That handoff needs a second spawn path (`stdio: "inherit"`, no capture, no timeout, no teardown — the inverse of `runVerificationCommand`), a fake-TTY test path, and it would make doctor's first side-effecting behavior. It is a clean additive follow-up: one flag plus one spawn path, requiring nothing reserved here.

### Testing

- **No real CLI in the test suite.** Both injection seams already exist: `runIndependentReview({ execute })` (`runner.ts:44`) and `runVerificationCommand({ runner })` (`spawn.ts:59`). Real CLIs would need network, authentication, and money, and would verify "the CLI is still the CLI" — which is doctor's job.
- Chain behavior is tested by injecting a fake runner that returns a scripted `failureClass` sequence. This is the riskiest logic (FAIL terminal, timeout advancing) and also the most easily tested; skipping it would leave the only mandatory tests unwritten.

## Check / message table

| Situation | status | message |
|---|---|---|
| `targets` empty or absent | PASS | `External review disabled. Re-run agent-ops init to enable.` |
| Executable not found | FAIL | `<target> not found. Install it, or remove "<target>" from reviewRoles[].targets.` |
| Executable present, `--check-auth` not passed | PASS | `<target> found. Login state unverified; run: agent-ops doctor --check-auth` |
| `--check-auth` probe failed | FAIL | `<target> is installed but not authenticated. Run: <target> login` |

## Acceptance criteria

- `agent-ops review --yes` on a repo with `targets: ["codex"]` and an active task invokes `codex exec` once, read-only, and reports PASS or FAIL from the model's JSON.
- With `targets: ["codex", "agy"]` and `codex` absent from `PATH`, `agy` is invoked; with `codex` present and returning FAIL, `agy` is never invoked.
- `"opencode"` is rejected by config validation as an unknown target id.
- No temp file is created anywhere in the review path.
- Running from Claude Code (`CLAUDECODE` set) with `targets: ["claude", "codex"]` invokes `codex` first; with `targets: ["claude"]` it invokes `claude` and the output contains a `reviewer == host` warning.
- A model response missing one requested criterion yields `NOT_RUN / unparseable-output`, writes no evidence, and does not advance the chain.
- No bound task yields `NOT_RUN / no-task-context` and invokes nothing.
- Evidence written for an active task carries the `review:<target>:` prefix; a `complete` task produces printed output and no write.
- `agent-ops init` with the feature declined writes no `reviewRoles`; a config without `reviewRoles` validates and reports the feature as disabled.
- `agent-ops doctor` makes no network call; `agent-ops doctor --check-auth` probes each configured target once.
- `agent-ops review` without `--yes` still reports `NOT_RUN / authorization-required` and spawns nothing.

## Task 1: Config field, types, and chain ordering

**Files:**

- Modify: `runtime/src/review/roles.ts`
- Modify: `runtime/src/contracts.ts`
- Modify: `schemas/config.schema.json`
- Modify: `runtime/src/config/` loader (wherever `loadEffectiveConfig` merges optional sections)
- Test: `tests/review/targets.test.ts` (new)

**Step 1: Write failing tests**

- A config with no `reviewRoles` loads, validates, and resolves to an empty target list.
- A config with `reviewRoles` round-trips through schema validation.
- A `reviewRoles` entry with an unknown target id fails validation with a dot-notation path — assert this specifically for `"opencode"`, which is a plausible-looking value a user may try because it is a supported *harness*.
- `orderChain(targets, host)` moves a detected host to the end; returns the single target unchanged when it is also the host; is a stable sort otherwise.
- `schemaVersion` stays `2` across all of the above.

**Step 2: Run the focused test**

Run: `npm run test:compile && node scripts/run-tests.mjs .tmp/test-dist/tests/review/targets.test.js`

**Step 3: Implement**

Add `ReviewTargetId`. Rename `ReviewRoleConfig.harness` to `targets: readonly ReviewTargetId[]` and add optional `timeoutMs`. Declare `reviewRoles` in the schema (`additionalProperties: false` on each entry, `targets` a non-empty array of the three literals). Add `orderChain()` and a `detectHostTarget()` that reads only `CLAUDECODE`.

**Step 4: Re-run the focused test**

## Task 2: Invocation table and output extraction

**Files:**

- Create: `runtime/src/review/invocation.ts`
- Create: `runtime/src/review/extract.ts`
- Test: `tests/review/invocation.test.ts` (new)
- Test: `tests/review/extract.test.ts` (new)
- Fixtures: `tests/fixtures/review/` (already captured — see Prerequisite)

**Step 1: Write failing tests**

Table-driven over the three targets:

- `buildTargetInvocation()` emits the correct executable and subcommand (`claude -p`, `agy -p`, `codex exec`), the read-only flag (`--permission-mode plan`, `--sandbox --mode plan`, `-s read-only`), and the model flag (`--model`, `--model`, `-m`).
- Effort: `claude` and `agy` receive `--effort <value>`; `codex` receives `-c model_reasoning_effort=<value>`.
- Output format: `claude` and `agy` receive `--output-format json`; `codex` receives **no** output-format flag.
- No invocation contains a path to a temp file.
- A target with no read-only flag available is reported ineligible rather than returning an invocation (guards the rule that excluded opencode).
- `extractFinalMessage()` returns `"OK"` from each committed fixture: `claude` via `.result`, `agy` via `.response`, `codex` from stdout verbatim.
- `extractFinalMessage("agy", claudeFixture)` and the reverse both miss — proves the branches are not interchangeable.
- Malformed stdout (truncated JSON, empty string) returns a miss, not a throw.
- `extractJsonObject()` recovers the object from a fenced block, from surrounding prose, and returns a miss for text containing no object.
- Composed path: feeding a full envelope fixture through `extractFinalMessage` then `extractJsonObject` yields the model's object, never the envelope itself.

**Step 2: Run the focused tests**

**Step 3: Implement**

Pure functions only — no spawning, no filesystem access at all.

**Step 4: Re-run the focused tests**

## Task 3: The executor and the fallback chain

**Files:**

- Create: `runtime/src/review/execute.ts`
- Modify: `runtime/src/review/runner.ts` (prompt text, new reasons)
- Modify: `runtime/src/review/result.ts` (protocol-violation exit path)
- Test: `tests/review/chain.test.ts` (new)

**Step 1: Write failing tests**

With an injected fake `VerificationProcessRunner` returning scripted outcomes:

- `[missing-executable, timeout, FAIL]` over `["codex", "agy", "claude"]`: all three attempted, in that order, and the verdict is the third target's FAIL.
- `[missing-executable, FAIL, PASS]` over the same chain: exactly two attempted — the FAIL is terminal and `claude` is never reached.
- A `FAIL` from the first target: exactly one attempt.
- `unparseable-output` from the first target: exactly one attempt, terminal.
- All targets missing: `NOT_RUN / missing-cli`.
- Each attempt emits one progress line naming the target and the reason it advanced.
- A response missing a criterion, containing a duplicate, or carrying empty evidence yields `unparseable-output` — not `FAIL`.
- The outgoing prompt contains no diff content and no secret material.
- A target whose stdout is truncated by the output limit yields `unparseable-output` and does not advance.
- stderr content is never fed to the extraction pipeline — codex writes 12KB of banner and hook noise there, and stdout is the only input.

**Step 2: Run the focused test**

**Step 3: Implement**

`execute` builds the invocation, calls `runVerificationCommand` with a 120s default timeout, maps `failureClass` to advance/terminal per the table above, and composes `extractFinalMessage` → `extractJsonObject` → validated `ReviewCriterionResult[]`. Extend `promptFor()` to state the read-only expectation, instruct self-inspection of the repository, list criterion descriptions and `verifierIds`, and specify the exact JSON response object. Add `unparseable-output` and `no-task-context` to `ReviewUnavailableReason`.

**Step 4: Re-run the focused test**

## Task 4: Task-store criteria and evidence write-back

**Files:**

- Modify: `packages/cli/src/commands/review.ts`
- Modify: `packages/cli/src/bin.ts`
- Test: `tests/cli/review-task-context.test.ts` (new)

**Step 1: Write failing tests**

- Criterion descriptions in the prompt come from the bound task, not from the id.
- `--criteria` filters the bound task's criteria; an id not on the task is rejected.
- No bound session task: `NOT_RUN / no-task-context`, nothing spawned.
- A PASS result on an `active` task writes evidence with the `review:<target>:` prefix.
- The same result on a `complete` task writes nothing and still prints.
- `--yes` absent: `NOT_RUN / authorization-required`, nothing spawned, no write.

**Step 2: Run the focused test**

**Step 3: Implement**

Pass the already-constructed `TaskService` and `AGENT_OPS_SESSION_ID` into `runReviewCommand`. Replace the `ids.map(id => ({ id, description: id }))` fabrication. Wire `roles` from the loaded config. Record evidence only for `active` tasks.

**Step 4: Re-run the focused test**

## Task 5: init wizard and the `--review-target` flag

**Files:**

- Modify: `packages/cli/src/wizard.ts`
- Modify: `packages/cli/src/args.ts`
- Modify: `runtime/src/install/plan.ts` (write `reviewRoles` into the generated config)
- Test: `tests/cli/init-review-targets.test.ts` (new)

**Step 1: Write failing tests**

- The interactive yes/no question defaults to No; declining writes no `reviewRoles`.
- Accepting then selecting `codex` and `agy` writes `targets: ["codex", "agy"]` in declaration order regardless of toggle order.
- Each selected target is probed exactly once; a failing probe prints the fix and still completes the install.
- The non-interactive path accepts repeated `--review-target` flags, runs no probe, and makes no network call.
- The non-interactive path with no `--review-target` writes no `reviewRoles`.
- A non-TTY interactive invocation does not hang waiting for the yes/no answer.

**Step 2: Run the focused test**

**Step 3: Implement**

Add the confirm question and a third `selectOptions` call with the three targets in default order. Probe with the Task 3 executor against a fixed trivial prompt, read-only, short timeout. Add the repeatable flag mirroring `--profile`.

**Step 4: Re-run the focused test**

## Task 6: The `review-targets` doctor check

**Files:**

- Modify: `runtime/src/install/doctor.ts`
- Modify: `packages/cli/src/commands/doctor.ts`
- Modify: `packages/cli/src/bin.ts`
- Modify: `packages/cli/src/args.ts`
- Test: `tests/install/doctor-review-targets.test.ts` (new)

**Step 1: Write failing tests**

- Empty/absent `targets`: PASS with the disabled message.
- Executable missing: FAIL with the install-or-remove message.
- Executable present without `--check-auth`: PASS with the unverified message, and **zero** probe invocations.
- `--check-auth` with a failing probe: FAIL with the login message.
- `--check-auth` probes each configured target exactly once.
- The check never reports UNKNOWN — so a healthy install's exit code is unaffected.

**Step 2: Run the focused test**

**Step 3: Implement**

Add the check with an injected probe (default: executable presence via `--version` through `runVerificationCommand`). Thread the new `--check-auth` flag from `args.ts` through `bin.ts:191`. Leave `--yes` inert for doctor.

**Step 4: Re-run the focused test**

## Task 7: Documentation and changelog

**Files:**

- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/zh-TW/` and `docs/en/` as their existing structure requires

Document the `reviewRoles` config shape, the three supported targets and their read-only flags, **why opencode is not among them despite being a supported harness** (no read-only primary agent; silent fallback to a writable one), the fallback-chain semantics (especially that FAIL is terminal), `--review-target`, `--check-auth`, and the fact that `--yes` is still required for every review run. State plainly that `--fix` for interactive login is not implemented.
