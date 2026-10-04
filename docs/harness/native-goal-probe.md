# Native goal capability probe

This document records the bounded, opt-in probes for the F native-goal hosts. The probe runs each host in a private temporary workspace, uses the host's documented structured transport, allows the native auto approval mode for that invocation, interrupts within a short observation window, and attempts an explicit resume. It never changes global policy and never treats a native completion event as agent-ops evidence.

Run it from the repository root with:

```sh
node scripts/probe-native-goals.mjs --timeout-ms 20000 --out /private/tmp/agent-ops-native-goal-probe.json
```

The JSON artifact contains command arguments, version-independent protocol observations, exit/signal results, and a safety record. It intentionally omits full model output. A host is recorded as observed only when the transport emits the expected initialization and accepts the goal message. The run remains unverified until agent-ops `verify`, task evidence, and review complete.

## Documented transport basis

- Claude Code supports `claude -p` with `/goal <condition>`, `--output-format stream-json --verbose` for incremental events, and `--resume <session-id>` for an active goal. `SIGINT` interrupts a non-interactive goal; an active goal is restored on resume, while the native timer, turn count, and token baseline reset. Auto mode is selected per invocation with `--permission-mode auto --permission-prompts none`. See the [Claude Code headless documentation](https://code.claude.com/docs/en/headless) and [goal documentation](https://code.claude.com/docs/en/goal).
- Codex app-server uses JSONL JSON-RPC over stdio. The host sends `initialize`, `initialized`, `thread/start`, `thread/goal/set`, and `turn/start`; it observes `thread/goal/updated`, `thread/goal/cleared`, and `turn/completed`; resume uses `thread/resume`; interruption uses `turn/interrupt`. The run-scoped approval reviewer is `auto_review`. See the [Codex app-server documentation](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server).

## Evidence status

The checked-in source describes the probe and its evidence format. A generated JSON artifact belongs under `/private/tmp` and must be attached to the task or copied into the task evidence record after an authorized local run. `observed`, `unavailable`, and `error` are transport outcomes; none means the product's completion contract passed. Network, authentication, model availability, and version-specific native behavior remain external prerequisites.

## 2026-10-04 local observation

Command:

```sh
node scripts/probe-native-goals.mjs --host all --timeout-ms 15000 --out /private/tmp/agent-ops-native-goal-probe-af-native-final.json
```

The artifact recorded Claude Code `2.1.289` and Codex `0.160.0`. Claude emitted startup hook events followed by `system/init` with the requested session UUID, accepted the structured `/goal` input under auto mode, and a second `--resume` process emitted `system/init` for the same UUID and accepted a continuation input. The first bounded run ended with `result/error_during_execution` during a rate-limited request; the resumed run emitted `result/success`. Codex emitted successful initialize, thread start, goal update, turn start, turn completion, and thread resume responses over stdio JSON-RPC. Both observations were stopped/cleaned by the probe, and the artifact explicitly records `nativeCompletionCountsAsProof: false`.

This demonstrates transport and lifecycle reachability for the installed versions. It does not demonstrate task completion, criterion evidence, reviewer approval, or a successful file change.
