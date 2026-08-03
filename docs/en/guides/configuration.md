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
intended surface. Project-local Claude settings require that explicit target.
Advisory and guardrail hooks are registered only when the selected profile
implies them. Advisory runs through the real SessionStart path and is
fail-open. Claude and Codex lifecycle support is `supported`; OpenCode begins
at app initialization and is honestly reported as `degraded`.

### Runtime-failure safeguards

`command-policy` is the only capability with a fail-closed failure mode. Claude
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
