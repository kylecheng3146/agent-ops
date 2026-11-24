# Independent QA

Independent QA adds a separate tester to the delivery loop: an agent that never
shared the developer's conversation plans the tests before implementation, writes
its own test materials against the integrated candidate, and has the controller
execute them. Its sealed PASS becomes a required delivery gate next to verify and
the two fresh reviews; it never replaces either.

## Scope and defaults

- QA **defaults ON for macOS project init/update**. An explicit `--qa off` writes
  `"qa": {"enabled": false}` and later updates preserve that choice. Re-enable with
  `agent-ops update --qa on` (or `agent-ops init --qa on`). The plan preview shows
  `Independent QA: enabled …` before confirmation; the normal init/update trust
  grant covers the changed config. `--qa` is project-only; `--scope user` refuses it.
  Linux/Windows and user-scope installs keep the existing default without QA.
- v1 is **macOS only**. An opted-in project on Linux or Windows refuses to enroll
  new tasks and blocks any enrolled delivery with `QA_UNSUPPORTED_PLATFORM`; it
  never passes silently.
- Enrollment applies to **new delivery root tasks**: `task create` binds a frozen QA
  policy to the task contract. Subtasks keep their local verify; their integrated
  root is what QA tests. Existing tasks keep their contract until you adopt them
  explicitly (below). Completed deliveries are never re-judged.
- Turning QA off later never removes the gate of a task that is already enrolled.
- A task that was never enrolled reads **not enrolled (not required)** in
  `task status`, `qa show` and Office. That is never a QA PASS.

## What happens

1. **Plan, before implementation.** After the criteria advisory, one read-only
   planner in a separate session reads the repository snapshot, consumes the
   advisory as data, and records cases mapped to criteria and surfaces
   (happy, negative, boundary, retry/concurrency and recovery as risk demands),
   the configured runners each case uses, required environment and any genuinely
   open question.
2. **Implement and commit** as usual; children run their own local verify.
3. **Test the integrated candidate.** For an enrolled ordinary task,
   `agent-ops verify --task <id>` runs QA first; `agent-ops qa run --task <id> --yes`
   runs it on its own. A fresh writable Claude or Codex session in a separate
   session works in an **isolated clone** at the exact committed candidate and may
   add only new test, fixture or helper files. Requests to change existing files
   go back to the developer. The controller validates paths, ownership and
   versions, imports and commits the materials (HEAD moves), then executes every
   case through the project's configured, trusted acceptance runners: behavioral
   cases must fail by assertion at the baseline and pass on the candidate.
   Nonmechanical cases (for example prose accuracy) are reasoned inspection that
   both final reviewers examine; they are never executed proof.
   Before starting any planner or author session for an implemented delivery,
   `verify --task`, `qa run` and `task advance` run the review-time surface gate:
   if review would stop (for example `SURFACE_UNCLASSIFIED`), QA stops first with
   `QA_SURFACE_NOT_READY` and the paths to classify, and no session is spent.
   Plan-only QA after the criteria advisory and an already sealed, current QA skip
   this check. Discovery does not derive queries from files the QA controller
   imported in the reviewed range while their bytes still match the recorded QA
   material digests, so tokens in QA tests never make product files unclassified.
4. **Seal.** Only the controller seals a PASS, bound to the candidate commit,
   source fingerprint, goal, QA task and tree contracts, scope, config and QA policy.
   The QA contracts cover the goal, title, intent, criteria and only the surface's
   included `{id, path}` set (or a child's `covers`): reclassifying the surface
   (exclusions, dismissals, UNKNOWN rows, scenarios, behavior text) keeps the seal
   current, while a new or moved included surface makes it stale. Any other later
   change makes it stale; an unchanged candidate reuses it with no model call,
   and a moved candidate re-executes the existing materials without a new session.
   The configuration binds QA only through `verification.acceptanceRunners` and the
   `qa` field, so editing review roles, verification commands or other settings
   keeps the seal and plan. A QA sealed or planned by 1.4.1 or earlier stays current
   after upgrading while its inputs are unchanged.
   `review` and `batch` first run this zero-spend QA (seal reuse or re-execution);
   when a planner or author session would be needed they report it
   (`qa:session-required`) instead of starting one, and review stops at
   `qa-required` until `agent-ops qa run --task <id> --yes`.
5. **Deliver.** `task complete`, the Stop completion gate, `worktree finish`,
   `task advance`, run finalize and `run land` all require that sealed PASS; both
   reviewers check QA validity, coverage, provenance and fallback reasons under
   the `qa-proof` criterion, and finish receipts keep a sealed copy of the QA plan,
   report, executions, decisions and attestation.

The planner and author prefer a configured host other than the implementer's;
a same-host fresh session is allowed and its fallback reason is recorded. Only
Claude and Codex may author materials; agy stays a read-only reviewer.

QA chooses from the CLI targets explicitly registered across `reviewRoles`;
formal reviews still use only `independent-review`. For two fresh agy review
rounds with a writable Claude QA author, configure `independent-review` with
`targets: ["agy"]` and the existing `implementation` role with
`targets: ["claude"]`. No unconfigured host is added automatically.

Runners must be able to collect newly authored materials. This source repository
provides `node tests/qa/acceptance.mjs`: it loads
`tests/qa/independent/**/*.check.mjs` exporting a `checks` object of stable IDs and
asserting functions. Configure it as a generic acceptance runner through the
normal config/trust preview before enabling QA here. Missing checks, duplicate
IDs, import failures and symlinks never pass.

Replanning receives bounded historical controller results and genuine human
answers as untrusted context, with their original versions and references.
Historical answers never answer a new plan or become current proof. Rejected
planner output is redacted and retained privately in `planning-diagnostics/`;
the prior plan and failures remain intact.

The read-only planner checks external requirements such as an installed browser.
Process launch, loopback ports, temporary profiles and the runner's CDP transport
are execution preconditions: trusted tests must exercise them. Any execution
failure remains UNKNOWN or FAIL. A required environment the planner observed
missing blocks delivery. One it could not probe from read-only planning (an
installed toolchain, a desktop GUI session) is recorded as unknown and does not
block: execution proves mechanical cases, and nonmechanical cases never execute.
Multiple bindings to one runner each retain their exact material
digest and their own baseline/candidate pair.

Both final reviewer clones receive the original sealed QA artifacts and their
trusted replay evidence in bounded, hash-checked bundles indexed by the review
manifest's `qaProofs`. Historical decisions remain separate from the current seal.
`executionTaskContracts` maps verifier evidence hashes; the full task and QA
contracts still bind the delivery. Missing, changed or oversized proof blocks
review rather than replacing it with a summary.

Every independent QA case uses the task's immutable creation baseline, exposed as
`qaBaselines` in the review manifest. A criterion may pin a different baseline
for its separate task verifier; that never overrides QA's baseline. Invariants
must pass on both baseline and candidate. Misclassification remains UNKNOWN.

## Commands

| Command | Effect |
| --- | --- |
| `agent-ops qa plan --task <id> --yes` | Plan or re-plan in a separate read-only session. On an active, not yet enrolled root task it **adopts** QA (required from then on), marked **late** once implementation has started. |
| `agent-ops qa run --task <id> --yes [--base <ref>]` | Author, import, execute and seal on the committed candidate; reports the real state. |
| `agent-ops qa show --task <id> [--json]` | Plan, results, findings, questions, native pause and usage from private state. Starts no model, host or runner. |
| `agent-ops qa respond --task <id> --question <id> --answer <text>` | Records one genuine human answer to a question QA asked. |
| `agent-ops qa stop --task <id>` | Fences and stops this task's ordinary QA writer; continuation stays off until an explicit `qa plan` or `qa run`. The isolated clone is kept for diagnosis. |

`task status` (and its `--json` `qa` field) shows the QA stage, outcome
(PASS, STALE, PENDING or NOT_REQUIRED), open blocking findings, open questions and
blockers, separately from verify coverage. Office shows the same in a room's
details and on the QA board panel, labelled **Independent QA** apart from Verify.
An idle, halted or finished QA view retires from Office after the usual two-hour
window; the private records stay.

## Repair, questions and control

- **`QA_REPAIR_REQUIRED`**: QA found a reproducible in-scope failure. QA writes
  no product code. Fix the product, pin each named `qa:<digest>:<index>` finding
  with `agent-ops task pin-finding <task-id> qa:<digest>:<index> --expected-contract
  <hash> --criterion-file <json>`, commit, and run `verify --task` (or `qa run`)
  again. The pin keeps the exact reproduction; closure needs the same case red then
  green. Nonblocking or unrelated pre-existing findings go to `agent-ops followup`
  with QA provenance.
- **`QA_AWAITING_INPUT`**: QA needs a product decision. An agent relays the
  question; only a person answers with `qa respond`. Agents must never compose
  an answer, and an answer never waives a failure or missing mechanical evidence.
- **`QA_NATIVE_DENIED`**: the native host refused a planning or authoring action.
  Planning retains the refusal, clears the current plan pointer and disables
  automatic continuation; older immutable plans and history remain. Resolve
  the authority before an explicit new `qa plan` or `qa run`. An empty planner
  turn without a native refusal is `QA_PLAN_NOT_RUN`, not invalid plan data.
- **Blocked**: required environment observed missing (`environment:<name>`;
  unknown does not block), a native
  denial or provider limit, or the same semantic failure twice in a row without
  progress. Fix the cause; QA does not install tools or change trust or settings.
- **Never** edit, weaken or delete QA materials, assertions or requirements to
  make QA pass.

## Native runs

Inside `agent-ops run`, the supervisor owns QA: the root gets its plan after the
advisory, and finalize or land runs QA on the integrated candidate. `qa plan`,
`qa run` and `qa stop` refuse with `QA_NATIVE_OWNED` and name the run;
`agent-ops run stop <run-id>` also stops its QA writer. A run agent relays QA
questions with `action=question`; the person answers with `qa respond` and then
resumes the run with `run respond`. A partial `run land` proves exactly the
landed tasks and their dependencies, never the whole goal.

## Cost and usage

There is no total QA time or iteration cap; QA continues while it makes progress,
and existing stop controls, provider limits and command deadlines still apply.
Planning and authoring are real Claude/Codex sessions that cost provider quota.
Usage is what the host reports; anything not reported is `UNKNOWN`, never
estimated. `qa show` and `task status` spend nothing.

## Compatibility

An absent field in an existing raw config remains off until managed init/update
sets the supported project default. Explicit OFF keeps new tasks unenrolled;
existing and completed task contracts, proof and hashes are never retroactively changed. QA data is additive: the config `qa` field, a task's `qa` binding,
QA finding pins and receipt QA proof. An older CLI (1.3.x and earlier) may reject
that data; do not downgrade a project with enrolled tasks. Private QA state lives
under the Git common directory (`agent-ops/qa/`), is redacted, and never enters
source fingerprints.
