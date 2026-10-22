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
- New runs have no total time cap (`budget.limitMs: null`). Active interval unions
  still measure setup, proof, review and integration. Legacy finite runs upgrade
  only on manual resume, retaining the old limit, intervals, elapsed time, usage
  epochs and blocker history. Reads and installation never upgrade or awaken runs.
  Command/review timeouts, provider quotas and no-progress/stop
  controls remain independent and effective. Explicit --time-budget is rejected.
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
  and a finite one-hour authorization window. Explicit native or organization denial cannot be bypassed.
  Policy changes fence all writers, preserve frozen deliveries and journal contract
  synchronization before new generations acquire leases. This never grants global
  repository trust. Native decisions retain redacted command scope and rationale;
  absent provider evidence remains UNKNOWN.
  Active execution automatically renews an expired grant only when the original
  repository trust, config, executable runtime and operation scope still match.
  Renewal is digest-bound to its predecessor, preserves assessments, rejects
  invalid/backward clocks, and loses to concurrent stop, denial or scope changes.
  Changed/revoked authority requires genuine authorization through the existing
  trust/resume process; renewal never grants permanent trust or clears denial.
  Explicit resume reconciles immutable renewal lineage before policy synchronization.
  An answer uses the same recovery checks; neither action can revive an explicit denial.
  `run resume <id> --retry-approval <auth-event-id>` MAY explicitly retry a
  Codex automatic approval review that failed with its usage-limit wrapper.
  Each selected failure MUST retain its original private artifact, digest,
  worker identity and policy lineage; unrelated or genuine denials still block.
  Repeat the flag for multiple failures. Successful acknowledgements are audited
  and revalidated on later resumes. This grants no command permission: native
  approval runs again. Existing writer-death, checkout, trust and budget checks apply.
  Initial recovery after a current manual resume MAY ignore an owned Codex limit
  snapshot received before activation whose native update second strictly predates
  that resume. Automatic restarts, unknown/equal/future timestamps, clock rollback,
  and every limit received after activation starts remain authoritative. Native
  activation MUST acknowledge an active goal before starting or steering a turn.
  Manual resume releases derivative `RUN_POLICY_DISABLED` task blocks while
  preserving IDs, accounting, history and unrelated product failures.
- Convergence compares actual per-check statuses and outstanding finding pins.
  Source fingerprints, timing and diagnostics alone cannot establish progress.

For any `jobs` value, the coordinator MUST yield only through an explicit
`action=wait` request sent after it has planned its children; the supervisor
never stops a coordinator that is still planning. A wait confirms coordinator
process death, frees its slot and drops its native thread, so the coordinator does
not poll `run status` while children work. Recovery leaves a waiting coordinator
stopped; once every child is delivered, complete or blocked, it restarts under a
new generation in a fresh native session whose instructions list each child's
status and delivered commit. With `jobs=1`, child execution MUST wait for that
confirmed death. Native registration, recovery and start MUST enforce at most
`jobs` active agents; changing task slot accounting alone is insufficient.

This module defines the bounded loop used to plan, implement, verify, and hand off work.

## LOOP-START-001

The operator MUST audit the change's surfaces, then state acceptance criteria before editing, and MUST stop when each criterion has evidence.

- Trigger: Starting a multi-step implementation or debugging loop.
- Action: Record the surface audit ([EVIDENCE-SURFACE-001](acceptance-and-evidence.md#evidence-surface-001)), then 2–5 observable criteria, then inspect only the files within the audited scope that the current step needs.
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
