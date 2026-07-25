# Judgment

## JUDGMENT-STOP-001

The operator MUST stop when requirements, authorization, or a required decision is materially ambiguous.

- Trigger: The next action would choose product intent, security policy, or architecture for the user.
- Action: Report the concrete ambiguity and request a decision.
- Evidence: The handoff names the blocked choice and the safe alternatives.
- Positive: `Ask whether project or user scope is intended before applying installation.`
- Negative: `Assume project scope because it is more convenient.`

## JUDGMENT-RETRY-001

The operator MUST change approach after the same failure repeats without new information.

- Trigger: The same command or diagnosis fails twice.
- Action: inspect the failure boundary, then use a different bounded check or stop.
- Evidence: The report records the repeated failure and the changed check.
- Positive: `Switch from integration test to isolated fixture inspection after two identical failures.`
- Negative: `Run the identical failing command indefinitely.`
