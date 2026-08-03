# Generic Codex Loop Installation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let any project explicitly install one generic, agent-ops-managed loop for Codex, Claude Code, or both. It records bounded harness-local state and blocks high-confidence secrets and destructive Bash commands.

**Architecture:** Add a project-only loop profile. When selected with Codex and/or Claude Code, it generates one tiny Bash launcher for each selected native hook surface (`.codex/hooks/agent-ops-loop.sh` and/or `.claude/hooks/agent-ops-loop.sh`), registers documented lifecycle events in the matching hook settings file, seeds user-owned local state files under that harness directory, and adds one hash-commented `.gitignore` block. Both launchers delegate to one generic Node runtime; policy is never copied from a project-specific script.

**Tech Stack:** TypeScript 7, Node.js 22 ESM, node:test, existing transaction/manifest ownership system, Codex JSON hooks, Bash/POSIX shell.

## Acceptance criteria

1. A project Codex and/or Claude Code loop install creates exactly one managed launcher for each selected harness, seeds its requested local files when absent, and registers loop events without deleting foreign hooks.
2. The generated loop blocks high-confidence literal secrets on UserPromptSubmit and dangerous Bash commands on PreToolUse using each harness's native denial, while permission/escalation requests still reach the harness's normal approval flow.
3. An existing `.codex/config.toml` with explicit `[features] hooks = false` fails a Codex loop install before any writes; other project configuration is never overwritten.
4. Update rewrites only agent-ops-owned loop artifacts and handlers; uninstall removes the wrapper, registrations, and exact .gitignore block while retaining goal, state, and telemetry data.
5. Focused tests, the full suite, typecheck, build, package check, and independent review pass.

### Task 1: Model the opt-in loop capability and public CLI surface

**Files:**

- Modify: runtime/src/contracts.ts
- Modify: schemas/config.schema.json
- Modify: runtime/src/install/types.ts
- Modify: runtime/src/install/profiles.ts
- Modify: packages/cli/src/args.ts
- Modify: packages/cli/src/wizard.ts
- Test: tests/install/profiles.test.ts
- Test: tests/cli/args.test.ts
- Test: tests/cli/ui.test.ts

**Step 1: Write failing profile and parser tests**

Add tests that accept `--profile loop`, resolve loop with its core baseline and a `project-loop` capability, preserve canonical ordering, and reject loop outside project scope or when neither Codex nor Claude Code is selected.

**Step 2: Run the focused tests to prove the option is unavailable**

Run: npm run test:compile && node scripts/run-tests.mjs .tmp/test-dist/tests/install/profiles.test.js .tmp/test-dist/tests/cli/args.test.js

Expected: failure because loop is not a recognized profile/capability.

**Step 3: Add the minimal public model**

Extend the Profile union and JSON schema enum with `loop`. Add `project-loop` to Capability, make loop imply core, validate it requires `scope === "project"` plus at least one supported loop harness (Codex or Claude Code), and expose it in parser help and the interactive selector.

**Step 4: Re-run focused tests**

Expected: all focused tests pass, including invalid scope/harness combinations.

### Task 2: Generate and own the generic project loop assets

**Files:**

- Create: runtime/src/install/codex-loop.ts
- Modify: runtime/src/install/harness.ts
- Modify: runtime/src/install/plan.ts
- Modify: runtime/src/install/ownership.ts
- Modify: runtime/src/contracts.ts
- Modify: schemas/manifest.schema.json
- Test: tests/install/plan.test.ts
- Test: tests/install/init.test.ts
- Test: tests/install/project-neutrality.test.ts

**Step 1: Write failing install-plan tests**

Cover a project loop install that plans a managed launcher for each selected harness: Codex gets `.codex/hooks/agent-ops-loop.sh`, create-once user-owned `.codex/config.toml` and `.codex/loop-goal.md`, plus `.codex/loop-state.md` and `.codex/loop-telemetry.jsonl`; Claude Code gets the parallel `.claude` launcher and state files. Both use one shared Node runtime and one managed hash-comment `.gitignore` block.

Assert that the wrapper has an agent-ops ownership marker, contains no WixGo token, and existing state files or configuration are never overwritten.

**Step 2: Run focused install tests and confirm failure**

Run: npm run test:compile && node scripts/run-tests.mjs .tmp/test-dist/tests/install/plan.test.js .tmp/test-dist/tests/install/init.test.js .tmp/test-dist/tests/install/project-neutrality.test.js

Expected: failure because no loop assets or seed planning exists.

**Step 3: Implement a dedicated loop asset planner**

Create a portable Bash wrapper shaped as:

    #!/usr/bin/env bash
    # agent-ops: generated codex loop v1
    set -uo pipefail
    exec node "<absolute-runtime>/loop-entry.js" "$@"

Render initial state templates and exact # agent-ops:start ... .gitignore entries. Plan seed writes only on first installation and only when the target is absent. Record only the wrapper as an artifact; goal/state/telemetry/config remain user-owned after creation.

**Step 4: Add hash-comment managed-block support**

Extend managed-block rendering and ownership verification with an explicit comment-marker style so .gitignore receives valid # comments rather than HTML markers. Preserve HTML markers as the default for AGENTS files.

**Step 5: Integrate contributions and manifest ownership**

Add launcher artifacts and the ignore marker only for project loop installs on Codex and/or Claude Code. Permit exactly those fixed paths in `assertSupportedManifestOwnership`; continue rejecting arbitrary forged artifacts.

**Step 6: Re-run focused install tests**

Expected: installation is transactional, foreign files are preserved, and generated output remains project-neutral.

### Task 3: Register loop lifecycle handlers without duplicating ordinary Codex hooks

**Files:**

- Modify: runtime/src/contracts.ts
- Modify: schemas/manifest.schema.json
- Modify: runtime/src/adapters/codex/config.ts
- Modify: runtime/src/adapters/codex/events.ts
- Modify: runtime/src/install/hooks.ts
- Test: tests/adapters/codex.test.ts
- Test: tests/install/hooks.test.ts

**Step 1: Write failing hook-registration tests**

Assert that a loop install adds owned handlers for `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `SubagentStart`, and `SubagentStop` on each selected harness; assert it does not add `Stop`. Existing non-agent-ops groups must remain byte-for-byte present.

**Step 2: Run focused registration tests and confirm failure**

Run: npm run test:compile && node scripts/run-tests.mjs .tmp/test-dist/tests/adapters/codex.test.js .tmp/test-dist/tests/install/hooks.test.js

Expected: failure because the manifest event union and Codex hook builder only support three events.

**Step 3: Implement loop registrations**

Use Codex commands shaped as:

    bash "$(git rev-parse --show-toplevel)/.codex/hooks/agent-ops-loop.sh" PreToolUse --managed-by=agent-ops

Use Claude commands that call its native launcher through `${CLAUDE_PROJECT_DIR}`. When `project-loop` is enabled, use the loop handler for its `SessionStart` and `PreToolUse` paths instead of duplicate ordinary advisory/guardrail handlers. Preserve explicit Stop verification behavior independently.

**Step 4: Re-run focused registration tests**

Expected: only owned loop handlers are added/removed and foreign hooks survive.

### Task 4: Implement the generic Codex loop runtime with TDD

**Files:**

- Create: packages/cli/src/loop-entry.ts
- Create: packages/cli/src/codex-loop-process.ts
- Create: runtime/src/hooks/codex-loop.ts
- Test: tests/hooks/codex-loop.test.ts
- Test: tests/cli/hook-process.test.ts

**Step 1: Write failing runtime tests for each observable event**

Tests must prove:

- literal secret prompt returns exit code 2 and a redacted reason;
- high-confidence broad recursive delete or git reset --hard returns exit code 2 before execution;
- sandbox_permissions: "require_escalated" is not auto-approved or blocked by the loop;
- SessionStart returns bounded goal/telemetry context without raw log entries;
- PreCompact writes only a bounded Git-status snapshot;
- telemetry excludes raw prompt, raw command, and secrets and is bounded/rotated;
- malformed input and runtime I/O errors fail open.

**Step 2: Run the runtime test file and confirm failure**

Run: npm run test:compile && node scripts/run-tests.mjs .tmp/test-dist/tests/hooks/codex-loop.test.js

Expected: failure because no loop entrypoint exists.

**Step 3: Implement the narrow runtime**

Reuse `evaluateGuardrail` for high-confidence secret and destructive-command decisions. Parse only documented shared fields: `prompt`, `tool_name`, `tool_input.command`, `sandbox_permissions`, `cwd`, and lifecycle names. Format block decisions with each harness's native output schema (Codex exit code 2; Claude Code's `UserPromptSubmit` / `PreToolUse` decision JSON); never serialize unsafe content. Use safe project-contained filesystem helpers, bounded JSONL retention, and no shell interpolation.

**Step 4: Re-run loop runtime tests**

Expected: all event, privacy, and fail-open cases pass.

### Task 5: Enforce configuration safety and lifecycle cleanup

**Files:**

- Modify: runtime/src/install/codex-loop.ts
- Modify: runtime/src/install/plan.ts
- Modify: runtime/src/install/ownership.ts
- Modify: runtime/src/install/uninstall.ts
- Modify: runtime/src/install/doctor.ts
- Test: tests/install/uninstall.test.ts
- Test: tests/install/update.test.ts
- Test: tests/install/doctor.test.ts

**Step 1: Write failing lifecycle tests**

Cover an explicit project [features] hooks = false conflict, update of an owned wrapper while preserving dynamic files, uninstall removal of wrapper/loop groups/ignore block while retaining state, fail-closed tamper handling, and doctor registration drift.

**Step 2: Run focused lifecycle tests and confirm failure**

Run: npm run test:compile && node scripts/run-tests.mjs .tmp/test-dist/tests/install/uninstall.test.js .tmp/test-dist/tests/install/update.test.js .tmp/test-dist/tests/install/doctor.test.js

Expected: failure because loop ownership and config conflict checks are absent.

**Step 3: Implement minimal safety checks**

Treat a clearly parsed project `[features] hooks = false` as `CODEX_LOOP_HOOKS_DISABLED` and do not rewrite that file. Ensure update/uninstall own only launchers, markers, and handlers. Dynamic seeds are never manifest artifacts and remain untouched.

**Step 4: Re-run focused lifecycle tests**

Expected: update/uninstall is reversible for managed policy and non-destructive for user state.

### Task 6: Document and verify the feature

**Files:**

- Modify: README.md
- Modify: docs/en/guides/configuration.md
- Modify: docs/zh-TW/guides/configuration.md
- Modify: docs/en/spec/harness-adapters.md
- Modify: docs/zh-TW/spec/harness-adapters.md
- Test: tests/docs/translation.test.ts
- Test: tests/docs/spec.test.ts

**Step 1: Add concise usage and boundary documentation**

Document `--profile loop`, project/Codex-or-Claude/Bash requirements, the hook trust model for each harness, generated files, `.gitignore` behavior, no Stop auto-verification, privacy limits, and explicit non-goals.

**Step 2: Run focused docs tests**

Run: npm run test:compile && node scripts/run-tests.mjs .tmp/test-dist/tests/docs/spec.test.js .tmp/test-dist/tests/docs/translation.test.js

Expected: pass.

**Step 3: Run final verification**

Run:

    npm run typecheck
    npm test
    npm run build
    npm run package:check
    git diff --check

Expected: all commands exit 0.

**Step 4: Perform an independent review**

Run the repository read-only review workflow against the feature diff, address every actionable finding, then re-run affected verification.
