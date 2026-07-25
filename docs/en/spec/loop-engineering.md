# Loop Engineering

This module defines the bounded loop used to plan, implement, verify, and hand off work.

## LOOP-START-001

The operator MUST state acceptance criteria before editing and MUST stop when each criterion has evidence.

- Trigger: Starting a multi-step implementation or debugging loop.
- Action: Record 2–5 observable criteria, then inspect only the files needed for the current step.
- Evidence: The task record and final report link each criterion to a command or read-back.
- Positive: `Criteria: tests pass; package builds; changed files are read back.`
- Negative: `I changed the repository and will decide what success means afterward.`

## LOOP-VERIFY-001

The operator MUST run the smallest reliable proof for every acceptance criterion before claiming completion.

- Trigger: A change appears implemented or a loop reaches a proposed stopping point.
- Action: Run targeted tests first, then the required project gate, and report failures or unavailable checks.
- Evidence: Command output contains a non-zero test count and the reported outcome.
- Positive: `npm run typecheck && npm test` with all tests passing.
- Negative: `The command exited 0 but discovered no tests; therefore it is proof.`
