# Harness Adapters

OpenCode plugin behavior in this document was checked against the [official
plugin documentation](https://opencode.ai/docs/plugins/) and [Bun shell
documentation](https://bun.sh/docs/runtime/shell) on 2026-07-31. Codex and
Claude Code loop-hook behavior was checked against their [Codex hook
documentation](https://developers.openai.com/codex/config-advanced#hooks) and
[Claude Code hook documentation](https://code.claude.com/docs/en/hooks) on
2026-08-03. Revalidate: when any vendor reference changes.

## HARNESS-ADAPTER-001

An adapter MUST preserve native harness semantics and MUST declare each
capability as supported, degraded, unsupported, or unknown.

- Trigger: Mapping portable lifecycle or review behavior into a native harness.
- Action: Keep ownership narrow, retain user configuration, and document limitations.
- Evidence: Adapter tests cover existing configuration, support declarations,
  and native failure outcomes.
- Positive: `A Codex blocking outcome remains UNKNOWN when native denial is unconfirmed.`
- Negative: `Assume Claude exit semantics apply to Codex.`

## HARNESS-ADAPTER-002

An adapter MUST be idempotent and MUST avoid deleting user-owned handlers.

- Trigger: Installing, updating, or removing managed harness configuration.
- Action: Change only stable managed markers or owned handlers.
- Evidence: Existing configuration fixtures remain intact after apply and uninstall.
- Positive: `Managed handler updates while unrelated handlers remain byte-for-byte present.`
- Negative: `Replace the complete settings file with toolkit defaults.`

## HARNESS-ADAPTER-003

A file-backed adapter MUST register only hooks implied by the active
capabilities and MUST track generated source as one whole-file artifact.

- Trigger: Installing or probing a harness whose extension point is a plugin file.
- Action: For opencode, manage `.opencode/plugins/agent-ops.js` in a project or `.config/opencode/plugins/agent-ops.js` at user scope (`$XDG_CONFIG_HOME/opencode/plugins/agent-ops.js` when configured inside the managed user root, or `$OPENCODE_CONFIG_DIR/plugins/agent-ops.js` when that native config directory is configured), leave `opencode.json` untouched, and deduplicate a project `AGENTS.md` contribution by path.
- Evidence: The manifest contains the plugin hash, the generated source contains only the selected hook registrations, and shared project markers occur once.
- Positive: `codex,opencode` produces one project AGENTS route and one hashed opencode plugin.
- Negative: `Add an opencode.json instructions entry or register a plugin for a core-only profile.`

## HARNESS-ADAPTER-004

The opencode shim MUST invoke the absolute runtime path from the selected
project directory, MUST fail open for
advisory events, and MUST throw its documented command-policy error when the
runtime is unavailable.

- Trigger: The generated plugin invokes `agent-ops` or receives an invalid runtime decision.
- Action: Keep normalization and native output encoding in the runtime adapter,
  throw its documented policy reason for a deny decision, and run
  lifecycle-summary through the shared advisory implementation. App-scoped
  plugin initialization remains degraded for per-session lifecycle fidelity.
- Evidence: Shim import tests cover allow, deny, and missing-runtime behavior;
  denial fixtures assert output shape only; doctor reports OpenCode lifecycle
  support as `DEGRADED`.
- Positive: `When the runtime is unavailable, SessionStart stays fail-open and the generated plugin throws its documented command-policy error for a Bash pre-tool hook.`
- Negative: `Fall back to a PATH-resolved agent-ops executable, claim an OpenCode host honors a thrown denial, or claim app initialization is a per-session Stop-equivalent.`

## HARNESS-ADAPTER-005

Each descriptor MUST expose separate control and runtime adapters. The control
adapter owns installation planning, routing, ownership, probes, and the
in-memory capability registration matrix. The runtime adapter owns native input
decoding, normalized events, native output encoding, and runtime-failure output.

- Trigger: Adding a harness surface or a generic capability.
- Action: Add the capability-to-native registration to the owning harness,
  including its support level and runtime-failure mode; do not add native
  events to a universal union.
- Evidence: Every declared `supported` registration is exercised through the
  real CLI hook process; denial-shape fixtures assert documented wire shapes,
  not host runtime enforcement; unsupported Stop/lifecycle registrations are
  not reported as enforcement success.
- Positive: `A fail-closed Claude command-policy runtime failure produces the documented PreToolUse denial shape through runHookCommand.`
- Negative: `Mark SessionStart supported while dispatchHookEvent has no advisory implementation.`

## HARNESS-ADAPTER-006

The project-local `loop` profile MUST be opt-in, project scoped, and use one
shared runtime behind minimal Codex and Claude Code launchers. It MUST NOT copy
policy into project-specific scripts or alter an ordinary permission request.

- Trigger: A project selects `loop` with Codex, Claude Code, or both.
- Action: Generate only the selected `.codex/hooks/agent-ops-loop.sh` and/or
  Claude's `.claude/hooks/agent-ops-loop.sh` plus
  `.claude/hooks/agent-ops-loop.ps1` launchers, register the documented loop
  lifecycle events except `Stop`, and preserve foreign hook groups. Block only
  high-confidence literal credentials at `UserPromptSubmit` or Bash
  `PreToolUse`, and dangerous Bash commands at `PreToolUse`, using the documented native denial shape. Emit no
  decision for `PermissionRequest`, including escalated permissions.
- Evidence: Install-plan, loop-runtime, update, uninstall, and doctor tests
  cover generated paths, Codex/Claude wire output, privacy bounds,
  configuration conflict handling, state preservation, and registration drift.
- Positive: `A Claude PreToolUse dangerous Bash command receives a native deny while a PermissionRequest produces no allow or deny decision.`
- Negative: `Copy a project loop policy into both shell launchers, auto-approve sandbox escalation, or add a loop Stop handler.`

The current registration matrix is intentionally asymmetric:

| Capability | Codex | Claude Code | OpenCode |
| --- | --- | --- | --- |
| lifecycle-summary | supported | supported | degraded |
| command-policy | unknown | supported | supported |
| optional-stop-verify | unsupported | supported | degraded |

For runtime-failure handling, only `command-policy` is fail-closed. Claude
Code can emit its documented `PreToolUse` denial shape for a classified invalid
installed configuration; the managed OpenCode `tool.execute.before` plugin can
throw its documented denial or unavailable-runtime error for its supported Bash
surface. Codex remains `unknown` and never emits a denial. Fixture tests assert
these wire and plugin shapes only; they do not prove that a host honors a
denial. Every `SessionStart` and `Stop` failure path remains fail-open.

Stop verification is explicit, trusted, report-only, and disabled by default.
Every Stop result continues the native harness and may carry only bounded
command evidence; it is never task-completion evidence.

The `loop` profile is separate from the ordinary capability matrix above. It
stores only bounded local event metadata, returns bounded redacted session
context, and preserves local goal, state, telemetry, and Codex TOML files on
update or uninstall. A clearly parsed `[features]` / `hooks = false` in an
existing Codex configuration MUST reject loop planning before any write.
