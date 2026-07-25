# Guardrails

## GUARDRAIL-SECRET-001

The system MUST redact credentials and MUST NOT persist secrets in prompts, logs, fixtures, or reports.

- Trigger: Handling command output, configuration, or external input.
- Action: Apply the shared redaction boundary and keep only bounded evidence.
- Evidence: A redaction test proves representative credential forms are absent.
- Positive: `Authorization header becomes a redacted marker.`
- Negative: `Store raw environment variables for later debugging.`

## GUARDRAIL-DESTRUCTIVE-001

Destructive or forceful commands MUST be blocked unless an exact, explicit exception is present.

- Trigger: A command can delete, overwrite, force-push, or alter protected state.
- Action: Block by default and report the stable rule ID.
- Evidence: Positive and negative command fixtures show the boundary.
- Positive: `git push --mirror is blocked.`
- Negative: `Allow every command containing a familiar sub-string.`
