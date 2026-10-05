# Native goal capability probe

This document records the bounded, opt-in probes for the F native-goal hosts. The probe runs each host in a private temporary workspace, uses the host's documented structured transport, allows the native auto approval mode for that invocation, interrupts within a short observation window, and attempts an explicit resume. It never changes global policy and never treats a native completion event as agent-ops evidence.

Run it from the repository root with:

```sh
node scripts/probe-native-goals.mjs --timeout-ms 20000 --out /private/tmp/agent-ops-native-goal-probe.json
```

The JSON artifact contains command arguments, version-independent protocol observations, exit/signal results, and a safety record. It intentionally omits full model output. A host is recorded as observed only when the transport emits the expected initialization and accepts the goal message. The run remains unverified until agent-ops `verify`, task evidence, and review complete.

## Documented transport basis

- Claude Code supports `claude -p` with `/goal <condition>`, `--output-format stream-json --verbose` for incremental events, and `--resume <session-id>` for an active goal. `SIGINT` interrupts a non-interactive goal; an active goal is restored on resume, while the native timer, turn count, and token baseline reset. Auto mode is selected per invocation with `--permission-mode auto --permission-prompts none`. See the [Claude Code headless documentation](https://code.claude.com/docs/en/headless) and [goal documentation](https://code.claude.com/docs/en/goal).
- Codex app-server uses JSONL JSON-RPC over stdio. The host sends `initialize`, `initialized`, `thread/start`, `thread/goal/set`, and `turn/start`; it observes `thread/goal/updated`, `thread/goal/cleared`, and `turn/completed`; resume uses `thread/resume`; interruption uses `turn/interrupt`. The run-scoped approval reviewer is `auto_review`. See the [Codex app-server documentation](https://learn.chatgpt.com/docs/app-server).

## Evidence status

The checked-in source describes the probe and its evidence format. A generated JSON artifact belongs under `/private/tmp` and must be attached to the task or copied into the task evidence record after an authorized local run. `observed`, `unavailable`, and `error` are transport outcomes; none means the product's completion contract passed. Network, authentication, model availability, and version-specific native behavior remain external prerequisites.

## 2026-10-04 local observation

Command:

```sh
node scripts/probe-native-goals.mjs --host all --timeout-ms 15000 --out /private/tmp/agent-ops-native-goal-probe-af-native-final.json
```

The artifact recorded Claude Code `2.1.289` and Codex `0.160.0`. Claude emitted startup hook events followed by `system/init` with the requested session UUID, accepted the structured `/goal` input under auto mode, and a second `--resume` process emitted `system/init` for the same UUID and accepted a continuation input. The first bounded run ended with `result/error_during_execution` during a rate-limited request; the resumed run emitted `result/success`. Codex emitted successful initialize, thread start, goal update, turn start, turn completion, and thread resume responses over stdio JSON-RPC. Both observations were stopped/cleaned by the probe, and the artifact explicitly records `nativeCompletionCountsAsProof: false`.

This demonstrates transport and lifecycle reachability for the installed versions. It does not demonstrate task completion, criterion evidence, reviewer approval, or a successful file change.

## 2026-10-05 complete invariant fixture runs

The toolkit built from `9d90e40264668cf41ec83c922bd8a10def27b546` completed
two private macOS fixture runs through the background `run` command:

| Host | Run | Receipt digest | Active time |
| --- | --- | --- | --- |
| Claude | `run-59de4e32135349dd` | `df489b6ab511f0cca411929e34de223dded9e8af444d943efb6e2c8010743872` | 273670 ms |
| Codex | `run-cb18cbe900db462c` | `5de16b64ea0af74a967127edeaaa62080a68df2bc62d15229ac07f61f16b7c45` | 423538 ms |

Each run used a ten-minute budget and one coordinator slot. The immutable goal
required two invariant checks (`equals-one` and `numeric`), mandatory `npm test`,
and completion without source edits or an empty commit. Both recorded paired
baseline/candidate checks, two different fresh reviewer sessions with PASS,
completed task state, exact candidate/target equality, and cleaned integration.
The summary and original receipt paths are saved in the private artifact
`agent-ops-af-final-native-proof.json`; original receipts remain in each fixture's
Git common directory. This establishes completion for these no-change fixtures,
not behavioral red→green changes, parallel dependencies, recovery under faults,
external adoption, or a reduction in review cost. Native cost remains partial.

## Framework execution conditions

Node uses the structured test reporter; Jest/Vitest reports use their packaged
normalizers. Native Jest JSON and Vitest task results do not preserve enough
provenance to distinguish test-call assertions from every hook or fixture
cleanup assertion. Failed native rows therefore remain UNKNOWN, even when the
error is AssertionError or contains matcher metadata. Behavioral red requires
explicit classified `assertion: true` or `failureClass: "assertion-failed"`
metadata from the repository's reviewed collector, with no lifecycle errors.
Passing reports still require observed single-attempt evidence (`attempts`,
Jest `invocations`, or both Vitest result `retryCount` and `repeatCount`). Reports
without this metadata remain UNKNOWN; success cannot imply one attempt.
Pytest requires an explicit setup/call/teardown sequence for each nodeid, and
the Rust harness requires its explicit attempt count.
On 2026-10-05 actual Jest 29.7.0 and Vitest 2.1.9 executions reproduced assertion,
before/after hook, Vitest fixture-cleanup/onTestFinished, retry and repeat
boundaries. Their reduced native reports and executing sources are preserved
under `tests/fixtures/acceptance/`; original reports remain in the private
temporary probe directory. In particular, Vitest cleanup assertion errors
retained both hook states as `pass`, confirming the provenance limitation.
The local adapter workstream exercised Node, Jest `29.7.0` and Vitest `2.1.9` in
temporary installations. Protocol fixture tests also cover missing/duplicate IDs,
retry, skip, collection and hook errors. Fixture normalization is separate from
the replay tests that run baseline and candidate checkouts with their own builds.

The packaged pytest plugin and Rust stdlib harness can be exercised without
adding repository dependencies:

```sh
node scripts/probe-acceptance-frameworks.mjs --pytest-python /path/to/venv/bin/python --rustc /path/to/rustc --out /private/tmp/framework-probe.json
```

On 2026-10-04 this command passed with pytest `8.4.2` and Rust `1.85.1` on macOS
arm64. It executes real tests and verifies green, assertion failure and UNKNOWN
for fixture failure/xfail/skip (pytest), and for panic (Rust). The Rust harness
classifies an explicit `Err(String)` from a named check as an assertion failure;
a panic is UNKNOWN, including native `assert!` panics. Convert intended contract
assertions to explicit results rather than treating arbitrary panics as red.
The report was written to `/private/tmp/agent-ops-acceptance-framework-probe.json`.
These are bounded compatibility observations for the listed versions; they do
not establish compatibility with every framework version or external user usage.

## macOS background lifecycle probe

After building, run `node scripts/probe-background-run.mjs --out /private/tmp/agent-ops-background-probe.json`
from a macOS GUI login. This opt-in probe creates a private temporary launchd
descriptor, observes a background heartbeat, kills that process and observes a
restart, then disables and boots out the job and verifies no further restart.
It cleans the temporary job and directory. No model is used and no product task
is completed. On 2026-10-04 it passed on macOS arm64 with Node `22.16.0`.
This proves the launchd primitive's observed lifecycle, not the complete F loop.
