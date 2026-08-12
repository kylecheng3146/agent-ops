# Configuration

Keep project configuration explicit and layered. Choose scope, harness, and profile deliberately; do not infer trust or security exceptions from `--yes`.

Use `--harness all` to select Codex, Claude Code, and opencode, or pass a
comma-separated subset such as `codex,opencode`. `both` remains an input alias
for the legacy Codex plus Claude selection.

Project Codex and opencode installations share the managed supplemental
`AGENTS.md` routing block and the `.agent-ops/AGENTS.md` rules artifact. The
block loads the managed baseline while project-specific instructions remain
authoritative. Claude uses the corresponding `CLAUDE.md` route and
`.agent-ops/CLAUDE.md` artifact. Opencode additionally gets
the agent-ops-owned `.opencode/plugins/agent-ops.js` file; `opencode.json` is
never modified. The plugin is generated with the installed absolute runtime
path, so update it through `agent-ops update` rather than editing it manually.

At user scope, Codex and opencode keep separate routing files under `.codex/`
and `.opencode/`; the global opencode plugin is placed under
`.config/opencode/plugins/`, or under `$XDG_CONFIG_HOME/opencode/plugins/`
when that variable points inside the managed user root. If OpenCode is
configured with `$OPENCODE_CONFIG_DIR`, the plugin is placed under its
`plugins/` directory instead. The installer discovers writable harness
surfaces and applies the selected target policy; use
`--hook-target <harness>=<surface-id>` when the managed default is not the
intended surface. Project-local Claude hooks use `.claude/settings.json` by
default; select `.claude/settings.local.json` explicitly when that is the
intended surface.
Advisory and guardrail hooks are registered only when the selected profile
implies them. Advisory runs through the real SessionStart path and is
fail-open. Claude and Codex lifecycle support is `supported`; OpenCode begins
at app initialization and is honestly reported as `degraded`.

### External review targets

`agent-ops review` can call another agent CLI to review your work. It is
disabled by default: an absent `reviewRoles` field, an absent
`--review-target` flag, and the interactive question's default all mean off.
Enable it during `agent-ops init`, or by hand:

```json
{
  "reviewRoles": [
    { "role": "independent-review", "targets": ["codex", "agy"] }
  ]
}
```

`targets` is an **ordered fallback chain**. Supported targets and the read-only
flags they are launched with:

| Target | Invocation | Read-only |
| --- | --- | --- |
| `codex` | `codex exec` | `-s read-only` |
| `agy` (Antigravity) | `agy -p` | `--sandbox --mode plan` |
| `claude` | `claude -p` | `--permission-mode plan` |

`opencode` is **not** a review target even though it is a supported harness.
Its `--agent plan` is rejected as a subagent and silently falls back to a
writable agent, so it cannot satisfy the read-only precondition. A target with
no read-only flag is skipped rather than run unsandboxed.

The chain advances only when no review happened — the executable is missing,
the spawn failed, or the attempt timed out (120s per target by default,
overridable with `timeoutMs`). A `FAIL` verdict is **terminal**: the chain
never retries another target after a real verdict, because that would be
automated review shopping. Unparseable output is terminal too, since it points
at a prompt or CLI-version mismatch worth surfacing.

If Claude Code is the host (`CLAUDECODE` is set), `claude` is moved to the end
of the chain. It still runs when it is the only configured target, with a
`reviewer == host` warning.

Criterion descriptions come from the task bound to the current session, so a
review needs an attached task; `--criterion` filters those ids. Results are
appended to the task's evidence with a `review:<target>:` prefix, and only
while the task is active — a completed task is printed, never rewritten.

`--yes` is still required for every review run: init selection decides which
targets are permitted, `--yes` decides whether to spend money now.

Because target authentication is not sniffed from stderr, an unauthenticated
CLI surfaces as one review failure. Diagnose it with:

```bash
agent-ops doctor              # presence only: no tokens, no network
agent-ops doctor --check-auth # one real print call per target
```

`--check-auth` is a dedicated flag; `--yes` stays inert for doctor. Doctor
reports what to do but never fixes it: every target authenticates through
interactive OAuth, so there is no `--fix`. Run `<target> login` yourself.

### Project-local loop profile

`--profile loop` is an opt-in project-scope profile. Select `codex`, `claude`,
or both (for example, `--harness codex,claude`); it requires a
POSIX-compatible `bash` and does not support Windows launchers yet. Start with
a dry run:

```bash
agent-ops init --dry-run --scope project --harness codex,claude --profile loop --json
agent-ops init --scope project --harness codex,claude --profile loop --yes
```

For each selected supported harness, agent-ops owns exactly one small launcher:
`.codex/hooks/agent-ops-loop.sh` or `.claude/hooks/agent-ops-loop.sh`. Both
launchers delegate to the same installed Node runtime, so they do not copy a
project-specific loop script. Codex also gets `.codex/config.toml` only when it
is absent. First installation seeds, without replacing existing content,
`loop-goal.md`, `loop-state.md`, and `loop-telemetry.jsonl` under the selected
harness directory. A hash-commented `.gitignore` block ignores those local
files.

The loop runs `SessionStart`, `UserPromptSubmit`, `PreToolUse`,
`PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`,
`SubagentStart`, and `SubagentStop`, but never adds `Stop`. It blocks only
high-confidence literal secrets in prompts or Bash commands, plus dangerous
Bash commands (including broad recursive deletion and `git reset --hard`). Codex uses its native
exit-code blocking mechanism; Claude Code receives its documented native JSON
decision shape. A `PermissionRequest`, including
`sandbox_permissions: "require_escalated"`, only records an outcome and emits
no allow or deny decision, preserving the host's normal approval flow.

Session context, telemetry, and compaction state are deliberately bounded.
Telemetry contains only timestamp, event, outcome, and rule identifier—not raw
prompts, commands, or credentials—and rotates by byte size. A pre-compaction
Git-status snapshot is redacted and written into a dedicated block in
`loop-state.md`, leaving surrounding user content intact. Installer update and
uninstall own only the launchers, native handler registrations, and exact
`.gitignore` block; goals, state, telemetry, and `config.toml` remain local
user files. If an existing `.codex/config.toml` explicitly says
`[features]` then `hooks = false`, planning stops with
`CODEX_LOOP_HOOKS_DISABLED` before any write.

Codex and Claude Code require their normal project-hook trust/review flow for
these generated handlers. The loop is a focused guardrail, not a complete
sandbox, permission bypass, or Stop-verification feature. See the [Codex hook
documentation](https://developers.openai.com/codex/config-advanced#hooks) and
the [Claude Code hook documentation](https://code.claude.com/docs/en/hooks)
before enabling it.

### Runtime-failure safeguards

For the ordinary `guardrails` profile, `command-policy` is the only capability with a fail-closed failure mode. Claude
Code can emit its documented denial shape at native `PreToolUse` for a
classified invalid installed configuration. The managed OpenCode
`tool.execute.before` plugin can throw its documented command-policy denial or
unavailable-runtime error for its supported Bash surface. Codex is explicitly
non-enforcing (`unknown`). These are agent-ops output and plugin contracts, not
proof that a host honors a denial. `SessionStart` and `Stop` failure paths stay
fail-open for every adapter.

Claude's invalid-config fallback has four safeguards: (1) an absent project
configuration stays fail-open, so only an invalid `.agent-ops/config.json` can
reach the fallback; (2) the manifest must safely prove that the current harness
is installed; (3) a human can export `AGENT_OPS_DISABLE=1` in the shell before
launching the host to restore fail-open temporarily; and (4) a Claude Code
denial names the config path and tells the user to repair it or temporarily set
that shell variable. The variable is read only from the hook-process environment
and cannot be set in agent-ops configuration, a manifest, or managed files.

`guardrails` installs command policy but does not enable Stop verification. Stop
is a separate config-v2 feature and must be explicitly enabled with at least
one confirmed command:

```json
{
  "features": { "stopVerification": { "enabled": true } },
  "verification": {
    "commands": [
      {
        "id": "unit",
        "command": "npm",
        "args": ["test"],
        "cwd": ".",
        "required": true,
        "evidence": { "kind": "test-count", "minimum": 1 }
      }
    ]
  }
}
```

Changing this feature changes native registration. Run:

```bash
agent-ops update
agent-ops trust grant
```

Without `update`, doctor can report `UPDATE_REQUIRED` for registration drift.
Separately, after a toolkit upgrade or effective profile or capability change
alters an intact path-independent managed rules artifact,
`artifact-staleness` reports `DEGRADED` with `UPDATE_REQUIRED`. `agent-ops
update` regenerates the artifact and clears that result; a missing or
hash-mismatched artifact remains an `artifacts` `FAIL`. Without the new trust
grant, trust-gated hooks remain stale. Stop is report-only: it continues the
harness for `PASS`, `FAIL`, or `UNKNOWN`, emits only bounded command ID, exit
code, test-count, config-hash, and timestamp evidence, and never completes a
task. Config v1 migrates deterministically to v2 with Stop disabled; old
binaries cannot read the migrated config, and the routing migration is
one-way after it is applied.

To narrow an existing installation, pass the desired list to `agent-ops update
--harness`; shared paths remain managed while removed harness-owned artifacts,
markers, and hooks are reconciled.

Installations using the previous canonical routing wording are migrated by
`agent-ops update`. If a managed block was edited, the command fails closed
until the change is reviewed.

Dry-run human and JSON plans omit raw harness settings content. They expose the
expected hash, content hash, and a safe summary while the internal apply plan
retains the complete merged settings. The manifest remains schema v2.

Use the [acceptance and evidence rules](../spec/acceptance-and-evidence.md)
when adding verification commands, and the [adapter rules](../spec/harness-adapters.md)
when configuring Codex, Claude Code, or opencode behavior.
