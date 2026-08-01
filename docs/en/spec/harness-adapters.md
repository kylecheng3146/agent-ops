# Harness Adapters

OpenCode plugin behavior in this document was checked against the [official
plugin documentation](https://opencode.ai/docs/plugins/) and [Bun shell
documentation](https://bun.sh/docs/runtime/shell) on 2026-07-31. Revalidate:
when either vendor reference changes.

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
advisory events, and MUST fail closed for command-policy events when the
runtime is unavailable.

- Trigger: The generated plugin invokes `agent-ops` or receives an invalid runtime decision.
- Action: Keep normalization and native output encoding in the runtime adapter,
  throw the policy reason for a deny decision, and run lifecycle-summary through
  the shared advisory implementation. App-scoped plugin initialization remains
  degraded for per-session lifecycle fidelity.
- Evidence: Shim import tests cover allow, deny, and missing-runtime behavior;
  doctor reports OpenCode lifecycle support as `DEGRADED`.
- Positive: `A missing runtime does not block SessionStart but blocks a bash tool before execution.`
- Negative: `Fall back to a PATH-resolved agent-ops executable or claim app initialization is a per-session Stop-equivalent.`

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
  real CLI hook process, and unsupported Stop/lifecycle registrations are not
  reported as enforcement success.
- Positive: `Claude command-policy reaches a native PreToolUse denial through runHookCommand.`
- Negative: `Mark SessionStart supported while dispatchHookEvent has no advisory implementation.`

The current registration matrix is intentionally asymmetric:

| Capability | Codex | Claude Code | OpenCode |
| --- | --- | --- | --- |
| lifecycle-summary | supported | supported | degraded |
| command-policy | unknown | supported | supported |
| optional-stop-verify | unsupported | supported | degraded |

Stop verification is explicit, trusted, report-only, and disabled by default.
Every Stop result continues the native harness and may carry only bounded
command evidence; it is never task-completion evidence.
