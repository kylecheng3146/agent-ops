# Harness Adapters

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
