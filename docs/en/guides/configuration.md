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
`plugins/` directory instead. Advisory and guardrail hooks are registered
only when the selected profile implies them.
Opencode lifecycle-summary starts at plugin initialization, so `doctor`
reports that check as `DEGRADED` rather than claiming per-session coverage.

To narrow an existing installation, pass the desired list to `agent-ops update
--harness`; shared paths remain managed while removed harness-owned artifacts,
markers, and hooks are reconciled.

Installations using the previous canonical routing wording are migrated by
`agent-ops update`. If a managed block was edited, the command fails closed
until the change is reviewed.

Use the [acceptance and evidence rules](../spec/acceptance-and-evidence.md)
when adding verification commands, and the [adapter rules](../spec/harness-adapters.md)
when configuring Codex, Claude Code, or opencode behavior.
