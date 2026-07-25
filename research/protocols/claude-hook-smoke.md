# Claude Code lifecycle hook smoke protocol

Verified on 2026-07-25 against:

- Claude Code `2.1.219`
- the official [Hooks reference](https://code.claude.com/docs/en/hooks)
- the official [Settings reference](https://code.claude.com/docs/en/settings)
- the official [CLAUDE.md reference](https://code.claude.com/docs/en/memory)
- the official [Security reference](https://code.claude.com/docs/en/security)

## Normative contract used by the adapter

Claude Code stores hooks inside hierarchical settings:

- user: `~/.claude/settings.json`
- project: `.claude/settings.json`
- local project: `.claude/settings.local.json`

There is no standalone `.claude/hooks.json`. Settings merge across sources;
managed settings have highest precedence, followed by command-line, local,
project, and user settings. The adapter edits only its own hook groups and
preserves unrelated settings and hooks.

`CLAUDE.md` files are concatenated into model context. They are not a hard
policy override. Agent-ops therefore installs a bounded routing block rather
than claiming enforcement through instructions.

Command hooks receive JSON on stdin. The adapter retains only policy inputs:
`hook_event_name`, `cwd`, the Bash tool command, and the Stop recursion marker.
It does not retain `session_id`, transcript paths, or final assistant messages.

Command handlers have two forms:

- exec form supplies `command` plus `args` and invokes the executable without a
  shell;
- shell form omits `args` and uses the platform shell.

Agent-ops prefers exec form with `node` and a separately supplied runtime path.
This keeps paths containing spaces in one argument. On Windows, npm `.cmd` and
`.bat` shims are not directly executable in exec form; invoking the underlying
Node script is the documented cross-platform pattern. Shell form is an
explicit fallback. A Windows-only shell hook may set `shell: "powershell"`;
Claude Code chooses `pwsh.exe` and falls back to `powershell.exe`.

Exit and JSON behavior is native to Claude Code:

- exit zero allows structured JSON on stdout;
- exit two is blocking only for the documented event-specific cases;
- other exit codes are non-blocking errors for ordinary command hooks;
- `PreToolUse` denial uses
  `hookSpecificOutput.permissionDecision: "deny"`;
- `Stop` continuation uses top-level `decision: "block"` plus `reason`;
- JSON is ignored on exit two, so an invocation must choose one signaling
  mechanism.

Injected context is capped at 10,000 characters. Stop input includes
`stop_hook_active`; agent-ops treats `true` as a recursion marker and does not
run verification again.

Project-defined hooks are gated by workspace trust. Claude Code `-p` skips the
workspace trust dialog, so non-interactive execution cannot be presented as
equivalent to an interactive trust decision. `PermissionRequest` hooks also do
not fire in `-p`; automated policy must use `PreToolUse`.

## Bounded smoke

Run:

```text
claude --version
claude --help
```

Observed on 2026-07-25:

```text
2.1.219 (Claude Code)
--include-hook-events
-p ... workspace trust dialog is skipped
```

This confirms the installed CLI exposes hook event streaming and documents the
non-interactive trust limitation. A live lifecycle invocation was not used as
normative evidence because it would require a model turn and an explicit
trusted fixture. Runtime behavior not established by the official references
remains `UNKNOWN`.
