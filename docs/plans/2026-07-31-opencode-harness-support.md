# Add opencode as a third harness

Date: 2026-07-31
Status: planned

## Goal

Support `opencode` alongside `codex` and `claude` in `agent-ops init`, hook
registration, and `doctor`, without leaving behind a fourth copy of the
existing two-harness branching.

## Assessment of the current mechanism

The harness abstraction exists but only covers artifact planning.

Working today:

- `HarnessInstallAdapter` (`runtime/src/install/harness.ts:32`) already models a
  harness as "produce artifacts plus managed blocks".
- Adapters are directory-scoped (`runtime/src/adapters/codex/`,
  `runtime/src/adapters/claude/`) with a consistent `config` / `events` /
  `input` / `output` shape.
- Hook registration has an owned-handler strip/merge convention that preserves
  foreign hooks (`runtime/src/adapters/*/config.ts`).
- Hook input normalization is already harness-agnostic: adapters translate into
  `NormalizedHookEvent` (`runtime/src/hooks/events.ts`), and policy runs on the
  normalized form.

Blockers for a third harness:

1. `Harness = "both" | "claude" | "codex"` (`runtime/src/contracts.ts:100`).
   `"both"` has no meaning with three harnesses. It is baked into
   `schemas/manifest.schema.json:16`, `packages/cli/src/args.ts:17`, and
   `packages/cli/src/wizard.ts:35`.
2. Dispatch is ternary rather than registry lookup:
   `runtime/src/install/hooks.ts:57,73,85,116,137` and
   `runtime/src/install/probes.ts:77-88`.
3. `HarnessId` is duplicated as an inline union in four places:
   `ManagedHookRecord.harness` (`contracts.ts:123`), `ReviewRoleConfig.harness`
   (`review/roles.ts`), `ReviewInvocation.harness` (`review/runner.ts`), and the
   `harness()` narrowing in `packages/cli/src/commands/review.ts:35`.
4. `commonHarnessAdapters()` derives the instruction filename with
   `id === "codex" ? "AGENTS.md" : "CLAUDE.md"`. That is adapter data, not a
   branch.
5. `HookRegistrationInput` (`probes.ts:10`) has one fixed field per harness.
6. Pre-existing inconsistency: claude hooks invoke an absolute runtime path
   (`adapters/claude/config.ts:56-67`) while codex hooks invoke the bare
   `agent-ops hook codex ` command (`adapters/codex/config.ts:31`), which is
   PATH-resolvable and therefore hijackable from inside a cloned repository.
7. `review/claude-runner.ts` and `review/codex-runner.ts` are pass-through
   wrappers with no logic, and `commands/review.ts:74` defaults `execute` to
   `NOT_RUN / missing-cli` — the whole review execution path is a stub.

## opencode facts this design depends on

Source: opencode.ai/docs/rules, opencode.ai/docs/config, opencode.ai/docs/plugins.

- Instruction file is `AGENTS.md` — the same filename codex uses.
- Config is `opencode.json` (project) or `~/.config/opencode/opencode.json`
  (user), with an `instructions: []` array of paths and globs.
- There is no command-type hook. Extension happens through JS/TS plugin
  modules auto-loaded from `.opencode/plugins/` (project) or
  `~/.config/opencode/plugins/` (user). No config entry is needed for local
  plugins.
- Relevant plugin hooks: `tool.execute.before` (throwing blocks the tool),
  `event` (bus events such as `event.type === "session.idle"`), and
  `experimental.session.compacting`.
- The bash tool's argument is a single command string at
  `output.args.command`, which matches the existing
  `normalizeShellHookEvent(command, projectRoot)` signature.

## Decisions

| # | Decision |
|---|---|
| 1 | `Harness` becomes `HarnessId[]`. CLI accepts `--harness codex,opencode`; `--harness all` selects every harness. `both` is accepted at the args layer and mapped to `["codex","claude"]` for backward compatibility. |
| 2 | The init wizard uses the existing `selectOptions` multi-select with `selectAll: true`. Non-TTY fallback takes a comma-separated list. |
| 3 | Manifest stores `harness` as an array and gets its own `MANIFEST_SCHEMA_VERSION = 2`. `SCHEMA_VERSION` stays `1` for config, task, and evidence. Loading a legacy string value migrates it. |
| 4 | Routing blocks and rules artifacts are deduplicated by path, not by harness. `AGENTS.md` gets one shared block. Block IDs become path-derived (`agents-routing`, `claude-routing`). |
| 5 | opencode hooks ship as an agent-ops-owned plugin file tracked as a `HarnessArtifact` with a hash — not as a `ManagedHookRecord`. `opencode.json` is never touched. |
| 6 | `SessionStart` maps to plugin initialization. `doctor` reports `lifecycle-summary` as `DEGRADED` for opencode, noting it fires at app init rather than per session. |
| 7 | The plugin is a dumb shim: it pipes opencode's raw input as JSON to `agent-ops hook opencode <event>` and reads a JSON decision back. All normalization stays in `adapters/opencode/input.ts`. |
| 8 | All three harnesses invoke hooks through an absolute runtime path. Codex switches away from the bare command. |
| 9 | `probes.ts` generalizes to `{ harness: HarnessId[], profiles, sources: Partial<Record<HarnessId, unknown>> }`, and each adapter implements `hookRegistered`. |
| 10 | Review is only widened to typecheck (`HarnessId` in place of the duplicated unions; `--harness` for review must resolve to exactly one). No `opencode-runner.ts`; the two existing pass-through runners are deleted. |
| 11 | Shim verification is two-layer: unit tests on the generated string, plus behavioral tests that `import()` the shim with an injected fake `$` and fake CLI output. No opencode installation in CI. |

Rejected: publishing the plugin as an npm export and registering it in
`opencode.json` (adds a config-merge surface for no gain); having the plugin
import the runtime directly (breaks module resolution for user-scope installs);
implementing real review spawning as part of this work (a separate problem on
an unbuilt foundation); skipping opencode hook probing (guardrails silently
failing is not acceptable).

## PR 1 — security patch (shippable alone as 0.1.5)

1. `runtime/src/adapters/codex/config.ts`: build the hook command as
   `node <runtimePath> codex <event> --managed-by=agent-ops`. `buildCodexHookConfig`
   takes a `runtimePath` argument and validates it the way
   `buildClaudeHookSettings` already does. Owned-handler detection switches from
   the command prefix to the `--managed-by=agent-ops` marker.
2. `runtime/src/install/probes.ts`: drop `CODEX_COMMAND_PREFIX`; codex uses the
   same marker check as claude. Without this, `doctor` reports codex hooks as
   unregistered after step 1.
3. `runtime/src/install/hooks.ts`: thread `runtimePath` through the codex path.
4. Tests: `tests/adapters/codex.test.ts`, `tests/install/probes.test.ts`,
   `tests/install/hooks.test.ts`.
5. CHANGELOG: note that `update` rewrites `.codex/hooks.json` because the
   managed command changed, and say why.

## PR 2 — de-binarize the harness abstraction (no opencode)

`HarnessId` still has two values at the end of this PR. User-visible behavior is
unchanged apart from the manifest shape.

1. `runtime/src/contracts.ts`: `HarnessId` moves here as the single definition.
   `Harness` becomes `HarnessId[]`. `ManagedHookRecord.harness` uses `HarnessId`.
   Add `MANIFEST_SCHEMA_VERSION = 2`.
2. `runtime/src/install/harness.ts`: adapters carry their own descriptor
   (`instructionFile`, `hookTargetPath`, `hookRegistered`). Build a registry
   keyed by `HarnessId` and expose `adapterFor(id)`. Delete
   `requestedHarnessIds`. Deduplicate contributions by artifact/block path and
   assert that deduplicated entries have identical content rather than dropping
   silently.
3. `runtime/src/install/hooks.ts`: replace the `harness === "claude" ? … : …`
   branches at lines 57, 73, 85, 116, and 137 with registry lookups.
4. `runtime/src/install/probes.ts`: adopt the generalized
   `HookRegistrationInput` and iterate over the selected harnesses.
5. `schemas/manifest.schema.json`: `harness` becomes an array with
   `minItems: 1`, `uniqueItems: true`; `schemaVersion` allows `2`.
   `runtime/src/config/migrate.ts` maps a legacy string (`both` →
   `["codex","claude"]`, otherwise `[value]`) and `update` rewrites the manifest.
6. `packages/cli/src/args.ts`: parse `--harness` as a comma-separated list,
   accept `all` and legacy `both`, reject duplicates and empty lists. The
   `harness === "both"` guard at line 426 becomes "review requires exactly one
   harness".
7. `packages/cli/src/wizard.ts`: `HARNESS_CHOICES` drops `both`; use
   `selectOptions` with `selectAll: true` and a default of
   `["codex","claude"]`. Non-TTY prompt takes a comma-separated list, mirroring
   `selectProfiles`.
8. Review typecheck-only changes: `review/roles.ts` and `review/runner.ts` use
   `HarnessId`; `commands/review.ts:35` narrows a one-element list. Delete
   `review/claude-runner.ts` and `review/codex-runner.ts`.
9. Tests: `tests/cli/args.test.ts`, `tests/install/*`, `tests/e2e/harness-matrix.test.ts`,
   plus a new migration test covering a legacy `"both"` manifest.

## PR 3 — opencode adapter

1. Add `"opencode"` to `HarnessId`, the manifest schema enum, `args`, and
   `wizard`.
2. `runtime/src/adapters/opencode/`:
   - `events.ts` — supported event names.
   - `input.ts` — translate `tool.execute.before` (bash only) via
     `normalizeShellHookEvent`, `session.idle` to `stop`, and plugin init to
     `session-start`; everything else to `unsupported`.
   - `output.ts` — emit the decision JSON the shim consumes.
   - `config.ts` — `opencodePluginTarget(scope)` returning
     `.opencode/plugins/agent-ops.js`, plus `buildOpencodePlugin(capabilities, runtimePath)`
     returning the shim source, and `hookRegistered(source, capabilities)`
     comparing against that source.
3. The shim, kept minimal and dependency-injected so it is testable under node:
   it takes `$` from the plugin context, spawns
   `node <absoluteRuntimePath> opencode <event> --managed-by=agent-ops`, writes
   the raw input as JSON to stdin, and parses one JSON decision from stdout.
   A `deny` decision throws with the policy reason. If the runtime path is
   missing, advisory events (`session-start`, `stop`) fail open and guardrail
   events (`tool.execute.before`) fail closed — never a PATH fallback.
   Only the hooks the installed capabilities imply are registered.
4. Register the adapter in the registry with
   `instructionFile: "AGENTS.md"`, so `AGENTS.md` block dedup from PR 2 applies
   automatically when codex and opencode are both selected. User scope stays
   distinct (`.codex/AGENTS.md` vs `.opencode/AGENTS.md`).
5. `doctor`: report `lifecycle-summary` as `DEGRADED` for opencode with the
   app-init caveat.
6. Ownership: `update` narrowing the harness list must not remove a shared path
   that a still-selected harness references. Reference-count shared paths across
   active harnesses instead of attributing them to one harness.
7. Tests:
   - `tests/adapters/opencode.test.ts` — input normalization and generated
     plugin source.
   - `tests/adapters/opencode-shim.test.ts` — `import()` the generated shim with
     a fake `$`: deny throws, allow does not, missing runtime fails open for
     advisory and closed for guardrails.
   - `tests/e2e/harness-matrix.test.ts` — three singles, `codex,opencode` (the
     shared-`AGENTS.md` case), and all three, across all three profiles.
8. Docs, both `docs/en` and `docs/zh-TW` (these ship in npm `files`):
   `spec/harness-adapters.md`, `spec/README.md`, `spec/review.md`,
   `spec/maintenance.md`, `guides/configuration.md`. Update `README.md` and the
   `package.json` description, which currently says "for Codex and Claude Code".

## Out of scope

- Real review execution for any harness.
- `opencode.json` `instructions` management.
- `experimental.session.compacting`.
- Installing opencode in CI; pre-release manual verification is documented in
  `CONTRIBUTING.md` instead.

## Known residual risks

- The generated shim is executable code outside the typechecker. Mitigated by
  the two test layers, not eliminated.
- `session.idle` and the plugin-init timing are behavioral observations of
  opencode, not a stability contract. If opencode changes them, `stop` and
  `session-start` degrade; `tool.execute.before` is the documented hook and is
  the one guardrails depends on.
- PR 1 rewrites `.codex/hooks.json` for existing installs. It must land and be
  released before PR 2 rebases onto it, or the two conflict in
  `adapters/codex/config.ts`.
