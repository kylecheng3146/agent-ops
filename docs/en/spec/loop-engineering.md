# Loop Engineering

## LOOP-RUN-001

`run` MUST preserve the original user goal and require current agent-ops proof.

- Trigger: Starting, repairing or recovering a native goal run.
- Action: Bind writers to current leases and require final verification, dual review and receipt proof.
- Evidence: The run ledger and sealed receipt bind the current candidate and original goal.
- Positive: Recovering interrupted cleanup preserves the target and saved final proof.
- Negative: Native goal completion alone changes run state to complete.

- The macOS supervisor registers Claude/Codex native identities before activating
  goals. Same-host writers use isolated worktrees and current generation leases;
  the coordinator counts toward the maximum two writers. Dependencies become
  available only through frozen deliveries; child baselines follow those commits.
- The default 60-minute budget counts the union of active intervals, including
  setup, proof, review and integration. Resume keeps elapsed time and usage epochs.
  Missing counters remain UNKNOWN; partial usage is not a complete cost estimate.
- Questions pause work and require an explicit answer. Repair preserves the goal
  and records failures; two identical rounds without progress stop that worker
  and its dependents. Independent tasks remain eligible. Review findings require
  regression pins or recorded review-only fallback before another final gate.
- Native completion is observational. Finalization requires mandatory verification,
  both fresh reviews, completed task state and a receipt bound to the target.
  Integration seals the candidate before moving the target and records task,
  receipt, note and cleanup progress. Recovery validates that seal and does not
  repeat a successful target mutation. Inconsistent targets remain blocked.
- Stop persists disabled continuation before confirming registered process-group
  death. Crash recovery cannot replace a live or unidentified writer. Dirty
  checkouts, version drift and restart storms preserve the scene for diagnosis.
  Reboot/login changes require explicit resume; no global host policy is changed.
  Startup process identities are saved before the native handshake; a stopped,
  unopened Codex session may initialize afresh only after process death is proved.

- Setup and native-issued local proof commands MUST register dormant process
  groups before execution; Stop also reconciles their descendants. Interrupted
  setup requires explicit resume and retains its checkout and failure artifact.
- A coordinator may assess additional fixed non-dangerous capabilities only under
  a run-scoped policy bound to the original repository trust, executable runtime
  and remaining budget. Explicit native or organization denial cannot be bypassed.
  Policy changes fence all writers, preserve frozen deliveries and journal contract
  synchronization before new generations acquire leases. This never grants global
  repository trust. Native decisions retain redacted command scope and rationale;
  absent provider evidence remains UNKNOWN.
  Explicit resume renews expired authorization from the remaining budget and
  reconciles immutable renewal lineage before policy synchronization. An answer
  uses the same recovery checks; neither action can revive an explicit denial.
- Convergence compares actual per-check statuses and outstanding finding pins.
  Source fingerprints, timing and diagnostics alone cannot establish progress.

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
