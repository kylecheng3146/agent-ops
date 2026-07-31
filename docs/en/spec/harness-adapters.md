# Harness Adapters

OpenCode plugin behavior in this document was checked against the [official
plugin documentation](https://opencode.ai/docs/plugins/) and [Bun shell
documentation](https://bun.sh/docs/runtime/shell) on 2026-07-31. Revalidate:
when either vendor reference changes.

## HARNESS-ADAPTER-001

An adapter MUST preserve native harness semantics and MUST label unsupported behavior as UNKNOWN.

- Trigger: Mapping portable lifecycle or review behavior into a native harness.
- Action: Keep ownership narrow, retain user configuration, and document limitations.
- Evidence: Adapter tests cover existing configuration and unsupported outcomes.
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
- Action: Keep normalization in the adapter, throw the policy reason for a deny decision, and report lifecycle-summary as degraded because plugin initialization is app-scoped rather than per-session.
- Evidence: Shim import tests cover allow, deny, and missing-runtime behavior; doctor reports `DEGRADED` for opencode lifecycle summaries.
- Positive: `A missing runtime does not block SessionStart but blocks a bash tool before execution.`
- Negative: `Fall back to a PATH-resolved agent-ops executable or claim app initialization is a per-session Stop-equivalent.`
