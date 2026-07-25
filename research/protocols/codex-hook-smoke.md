# Codex lifecycle hook smoke protocol

Verified on 2026-07-25 against:

- Codex CLI `0.145.0`
- the current official [Codex Hooks manual](https://learn.chatgpt.com/docs/hooks)

## Normative contract used by the adapter

The official manual establishes the following behavior:

- Codex discovers `hooks.json` and inline `[hooks]` next to active config
  layers. Matching hooks accumulate across layers. A layer that uses both
  representations loads both and warns, so agent-ops manages only
  `hooks.json`.
- Project-local `.codex` hooks load only after the project is trusted.
  User-level hooks remain independent of project trust.
- Non-managed command hooks are trusted by exact definition hash. New or
  changed definitions require review.
- Matcher groups contain command handlers. Only `type: "command"` runs in the
  verified version. Matching command hooks run concurrently.
- Most hooks default to a 600-second timeout. `SessionEnd` defaults to one
  second and permits up to three seconds.
- `commandWindows` is the Windows command override.
- Common stdin includes `session_id`, `transcript_path`, `cwd`,
  `hook_event_name`, and `model`. The adapter retains only fields used by
  policy and never retains the transcript path.
- `PreToolUse` honors tool-name matchers. `Stop` and `UserPromptSubmit`
  matchers are not supported.
- Exit zero with no output means success and continuation. Shared JSON output
  supports `continue`, `stopReason`, and `systemMessage` only for the events
  listed by the manual. `PreToolUse` supports `systemMessage`, but not the
  shared `continue` or `stopReason` fields.

The official manual does not establish a portable meaning for non-zero hook
exit codes or a hook-output byte limit. Both remain `UNKNOWN`. The adapter
does not copy Claude Code exit behavior into Codex. Because the verified
`PreToolUse` output contract supports `systemMessage` but not shared
`continue` or `stopReason`, native high-confidence blocking also remains
`UNKNOWN`; the adapter surfaces the decision without claiming the tool was
blocked.

Tool-hook coverage is not a complete enforcement boundary. Matching hooks
start concurrently, hosted tools do not use the local tool-hook path, and
specialized tool paths can opt out. Shell input is normalized into a bounded
command batch with ordinary quoting and command separators handled without
executing the input. Unsupported shell constructs remain explicit rather than
being guessed.

## Bounded smoke

Run:

```text
codex --version
codex features list
```

Observed on 2026-07-25:

```text
codex-cli 0.145.0
hooks stable true
```

This confirms that the installed CLI exposes the documented hooks feature.
It does not establish non-zero exit behavior, output-size limits, project
trust, or a lifecycle invocation. Those outcomes remain `UNKNOWN`; a future
invocation smoke must use an isolated, explicitly trusted fixture and must not
promote observations into the normative contract without official
documentation.
