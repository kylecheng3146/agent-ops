# Harness Adapters

OpenCode plugin behavior in this document was checked against the [official
plugin documentation](https://opencode.ai/docs/plugins/) and [Bun shell
documentation](https://bun.sh/docs/runtime/shell) on 2026-07-31. Codex and
Claude Code loop-hook behavior was checked against their [Codex hook
documentation](https://developers.openai.com/codex/config-advanced#hooks) and
[Claude Code hook documentation](https://code.claude.com/docs/en/hooks) on
2026-08-03. Agy hook behavior was checked against the [official Antigravity
hook documentation](https://antigravity.google/docs/hooks) on 2026-08-28.
Revalidate: when any vendor reference changes.

## HARNESS-ADAPTER-001

An adapter MUST preserve native harness semantics and MUST declare each
capability as supported, degraded, unsupported, or unknown.

- Trigger: Mapping portable lifecycle or review behavior into a native harness.
- Action: Keep ownership narrow, retain user configuration, and document limitations.
- Evidence: Adapter tests cover existing configuration, support declarations,
  and native failure outcomes.
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
- Negative: `Add an opencode.json instructions entry or register a plugin for a core-only profile with Office disabled.`

## HARNESS-ADAPTER-004

The opencode shim MUST invoke the absolute runtime path from the selected
project directory, MUST fail open for
advisory events, and MUST throw its documented command-policy error when the
runtime is unavailable.

- Trigger: The generated plugin invokes `agent-ops` or receives an invalid runtime decision.
- Action: Keep normalization and native output encoding in the runtime adapter,
  throw its documented policy reason for a deny decision, and run
  lifecycle-summary through the shared advisory implementation. App-scoped
  plugin initialization remains degraded for per-session lifecycle fidelity.
- Evidence: Shim import tests cover allow, deny, and missing-runtime behavior;
  denial fixtures assert output shape only; doctor reports OpenCode lifecycle
  support as `DEGRADED`.
- Positive: `When the runtime is unavailable, SessionStart stays fail-open and the generated plugin throws its documented command-policy error for a Bash pre-tool hook.`
- Negative: `Fall back to a PATH-resolved agent-ops executable, claim an OpenCode host honors a thrown denial, or claim app initialization is a per-session Stop-equivalent.`

## HARNESS-ADAPTER-005

Each descriptor MUST expose separate control and runtime adapters. The control
adapter owns installation planning, routing, ownership, probes, and the
in-memory capability registration matrix. The runtime adapter owns native input
decoding, normalized events, native output encoding, and runtime-failure output.

- Trigger: Adding a harness surface or a generic capability.
- Action: Add the capability-to-native registration to the owning harness,
  including its support level and runtime-failure mode; do not add native
  events to a universal union.
- Evidence: Every declared `supported` registration is exercised through the
  real CLI hook process; denial-shape fixtures assert documented wire shapes,
  not host runtime enforcement; unsupported Stop/lifecycle registrations are
  not reported as enforcement success.
- Positive: `A fail-closed Claude command-policy runtime failure produces the documented PreToolUse denial shape through runHookCommand.`
- Negative: `Mark SessionStart supported while dispatchHookEvent has no advisory implementation.`

## HARNESS-ADAPTER-006

The project-local `loop` profile MUST be opt-in, project scoped, and use one
shared runtime behind minimal Codex and Claude Code launchers; agy uses its
native supported lifecycle subset and is reported as degraded. It MUST NOT copy
policy into project-specific scripts or alter an ordinary permission request.

- Trigger: A project selects `loop` with agy, Codex, Claude Code, or any combination.
- Action: Generate only the selected `.codex/hooks/agent-ops-loop.sh` and/or
  Claude's `.claude/hooks/agent-ops-loop.sh` plus
  `.claude/hooks/agent-ops-loop.ps1` launchers, register the documented loop
  lifecycle events except `Stop`, and preserve foreign hook groups. For agy,
  register only native `PreInvocation`/`PreToolUse(run_command)` hooks and do
  not generate a shell launcher. Block only
  high-confidence literal credentials at `UserPromptSubmit` or Bash
  `PreToolUse`, and dangerous Bash commands at `PreToolUse`, using the documented native denial shape. Emit no
  decision for `PermissionRequest`, including escalated permissions.
- Evidence: Install-plan, loop-runtime, update, uninstall, and doctor tests
  cover generated paths, Codex/Claude wire output, privacy bounds,
  configuration conflict handling, state preservation, and registration drift.
- Positive: `A Claude PreToolUse dangerous Bash command receives a native deny while a PermissionRequest produces no allow or deny decision.`
- Negative: `Copy a project loop policy into both shell launchers, auto-approve sandbox escalation, or add a loop Stop handler.`

The current registration matrix is intentionally asymmetric:

| Capability | agy | Codex | Claude Code | OpenCode |
| --- | --- | --- | --- | --- |
| office-presence (Preview) | degraded | degraded | supported | degraded |
| lifecycle-summary | degraded | supported | supported | degraded |
| command-policy | supported | unknown | supported | supported |
| completion-gate | supported | unsupported | unsupported | unsupported |
| optional-stop-verify | degraded | unsupported | supported | degraded |

For runtime-failure handling, only `command-policy` is fail-closed. Claude
Code can emit its documented `PreToolUse` denial shape for a classified invalid
installed configuration; the managed OpenCode `tool.execute.before` plugin can
throw its documented denial or unavailable-runtime error for its supported Bash
surface. Codex remains `unknown` and never emits a denial. Fixture tests assert
these wire and plugin shapes only; they do not prove that a host honors a
denial. Every `SessionStart` and `Stop` failure path remains fail-open.

The agy adapter uses native project `GEMINI.md` routing to
`.agent-ops/GEMINI.md`;
at user scope it manages `.agent-ops/GEMINI.md` and a managed block in the
shared `.gemini/GEMINI.md` rule surface. Its native hooks use camelCase input,
return `decision: "deny"` for command-policy blocks, and, only when the
completion gate is explicitly enabled, return `decision: "continue"` for an
unproven final changed conversation. Read-only conversations stop normally.
On Windows the generated command is invoked through `cmd /c`.

Stop verification is explicit, trusted, report-only, and disabled by default.
Every Stop result continues the native harness and may carry only bounded
command evidence; it is never task-completion evidence.

The `loop` profile is separate from the ordinary capability matrix above. It
stores only bounded local event metadata, returns bounded redacted session
context, and preserves local goal, state, telemetry, and Codex TOML files on
update or uninstall. A clearly parsed `[features]` / `hooks = false` in an
existing Codex configuration MUST reject loop planning before any write.

## HARNESS-ADAPTER-007

The `run` profile MUST be opt-in, select `core` and `loop` with it, and add only
the `auto-run` capability. With it, the Claude Code and Codex managed rules hand
a change that needs more than five acceptance criteria to `agent-ops run`; five
or fewer stay in the session. agy rules, and every rule file without `auto-run`,
MUST stay byte-identical to the rules without the profile.

- Trigger: A project selects `run`, and a Claude Code or Codex session meets a
  change that needs more than five acceptance criteria.
- Action: From the main checkout and before any `task create`, the agent writes
  the user's prompt verbatim and its proposed acceptance criteria, marked as
  proposals, to the gitignored `.agent-ops/state/run-goal.md`, then starts
  `agent-ops run --goal-file .agent-ops/state/run-goal.md --host <claude|codex> --wait`
  as a background shell command. Codex starts it like review: an outer request
  with `sandbox_permissions: "require_escalated"` and
  `env -u CODEX_SANDBOX_NETWORK_DISABLED`. An awaiting-input result is relayed
  to the user and answered with `agent-ops run respond`. A start refused with
  `RUN_TARGET_REQUIRED`, `RUN_BACKGROUND_UNSUPPORTED`, `RUN_TARGET_DIRTY` or
  `WORKTREE_NESTED` is reported in one line naming the code and falls back to
  the subtask flow; `RUN_REPO_UNTRUSTED` stops and asks the user. A run that
  ends without completing (blocked, budget exhausted, stopped, failing review)
  is reported with its `run status` state and code, its last `run logs` events,
  and the exact `agent-ops run resume <id>` and `agent-ops run stop <id>`
  commands, and is never resumed automatically or taken over by the session.
  With worktree auto mode, the Claude `PreToolUse` worktree guard allows a
  write to exactly `.agent-ops/state/run-goal.md` in the main checkout without
  creating a worktree. Confirmed init/update pre-authorizes `agent-ops run`:
  `Bash(agent-ops run *)` for Claude Code, and an escalated prefix rule for
  `env -u CODEX_SANDBOX_NETWORK_DISABLED agent-ops run` for Codex.
- Evidence: Profile, managed-rule digest, pre-authorization, and worktree-guard
  tests cover the resolved profiles, the unchanged rules, the added entries, and
  the single exempt path.
- Positive: `A Claude Code session with the run profile writes .agent-ops/state/run-goal.md in the main checkout and starts agent-ops run --host claude --wait in the background.`
- Negative: `Split an eight-criteria change into subtasks while the run profile is active, add auto-run text to GEMINI.md, or resume a blocked run without the user.`

## HARNESS-ADAPTER-008

`agent-ops office` (Preview) MUST show progress read-only from agent-ops state alone. The
supervisor records an optional phase per run and worker (`planning`,
`implementing`, `verifying`, `reviewing`, `integrating`) at deterministic
transitions, and each task's latest verify and review result with passed/total
criteria. Run state written before phases existed MUST still validate and show
as `unknown`. Changed files come from each worktree's own `git diff` against its
base; narration uses paths only (`docs/**` is "writing docs", `tests/**` is
"writing tests", otherwise "editing <file>"). The office MUST NOT read native
Claude or Codex transcripts or file contents.

- Office Preview is opt-in via `features.office.enabled`. Init MUST offer an
  off-by-default choice; interactive update MUST default to the existing choice.
  Non-interactive update MUST preserve it unless `--office on|off` is supplied.
  Older configs without the optional field remain valid and mean disabled.
  Enabling Office MUST install its presence hooks even with only `core`; this
  MUST NOT opt into command policy, Stop verification or lifecycle summaries.
  Office-only OpenCode runtime failure MUST remain fail-open; adding Office to
  command policy MUST preserve policy denial and unavailable-runtime behavior.
  Agy startup is per invocation, OpenCode startup is app-scoped, and Codex
  Stop delivery is unavailable in some execution modes; stale presence expires
  using the bounded hook-activity timeout rather than assuming native Stop.
  Features retain their existing whole-object layer precedence. Disabled hooks
  MUST NOT record Office presence or start/open Office; the explicit command
  MUST explain how to enable it. A running server MUST close after observing a
  disabled choice on its next 15-second lifecycle check.
- Trigger: When enabled, a managed ordinary session starts or reports activity, or a user runs
  `agent-ops office`, `agent-ops run start` or `agent-ops run status`.
- Action: The command reuses the user's one live server recorded in
  `~/.agent-ops/state/office/office.json` (under `AGENT_OPS_HOME` when set), or
  starts one, and prints its URL. Ordinary session hooks also start or reuse it,
  including before a task or worktree exists. Only the successful new-server
  owner opens the browser; sessions in every repository share the same Office.
  An Office-enabled repository registers its main root and Git common directory
  in `repos.json` beside that record. Each collection re-checks that the
  directory exists and the repository still opts in, and forgets a repository
  quiet for two hours with nothing left to show. Rooms carry their repository's
  name, their keys are scoped by it, and the page filters by repository. The
  first report from a repository that still has a 0.7 per-repository record
  boots its launchd job out and removes that record; its pid is never signalled.
  A successful `worktree finish` records the session's completion so its room
  closes; only a new start or an active task reopens it. With Office enabled,
  Claude Code also gets a managed `SessionEnd` hook: when the conversation
  closes, its room closes too, even without a task. It writes no output and
  never fails the host. Other hosts publish no end event and rely on the
  activity timeout. A session that has only started is idle; a submitted
  prompt or tool activity marks it active, and agy's per-invocation start
  counts as activity. Outside the project loop, Claude Code and Codex get a
  managed `UserPromptSubmit` hook whenever Office or command policy is enabled:
  Office records the turn's start, and command policy refuses a prompt carrying
  a literal credential in the host's native shape (Claude `decision: "block"`,
  Codex exit code 2). Its runtime failures let the prompt through. A room without a task shows a no-task board rather than
  pending verification and review. Session metadata contains bounded
  identifiers, known work state and activity times, never native transcripts,
  prompts or tool/file contents. Startup and observation failures are advisory.
  The server binds
  127.0.0.1 on a random port, requires the URL's unguessable token, refuses any
  Host other than that address and port, answers every non-GET with 405, and
  exits 10 minutes after neither a run nor an ordinary session is active.
  Ordinary-session liveness follows hooks, with stale presence expiring after
  30 minutes without activity; it does not inspect native host processes.
  Its single inline page uses cozy cream, oak and sage in-code 16-color scene
  sprites with no image assets. Each 32×48 character uses its own fixed skin,
  hair and clothing palette, four-direction walking, and localized role labels.
  The viewer's badge displays `You` in English and `你` in Chinese; its overview size matches the largest room's
  characters. The fixed-viewport overview
  fills the available page below the header and shows all furnished work-unit
  rooms, shrinking rooms as necessary without document scrolling. A shared
  hallway connects the rooms. The user controls a local Supervisor with arrow
  keys or WASD, can walk into every room and return to the overview, without
  model requests or network mutations. Each run team shares a room; each ordinary session has its own,
  and running reviews remain visible. Clicking a room enters a larger detail
  view with a return control. Every room contains planning, development,
  verification, review and integration areas. Characters walk to their known
  phase's zone, use light phase-driven animation, and have short name/status
  labels; unknown state is not inferred from dialogue. Whiteboards show task
  criteria progress, verify/review outcomes and pending questions, with `!` for
  unanswered questions. Clicking a whiteboard or progress board opens the room
  work list; workstations and phase areas show the known work in that phase.
  Pending markers open complete questions with the existing copyable commands.
  The same paged views are available with `L` (work list), `1–5` (phases) and
  `Q` (questions). Clicking an actor opens bounded, paged status details
  with copyable commands. Completed rooms are available through Recently
  completed for at most two hours. Chinese/English switching remembers the
  choice, and keyboard navigation and reduced motion are supported. A failure
  to start the office never fails a hook, `run start` or `run status`.
- Evidence: Phase, snapshot, server, scene and CLI tests cover legacy state,
  aggregation and narration, ordinary-session registration and startup-once,
  the two-hour completion boundary, token/Host/method guards, reuse and the
  injected-clock idle exit, viewport/room navigation, localization, and the
  printed URL. A browser read-back checks the rendered single-page layout.
- Positive: `An ordinary session opens the shared Office, where its room is visible before it creates a worktree; entering a team room shows the coordinator at the verification bench and a whiteboard with 2 of 6 criteria passed.`
- Negative: `Serve the office on 0.0.0.0, accept a POST, read a worker's transcript to narrate it, or bundle a PNG sprite sheet.`
