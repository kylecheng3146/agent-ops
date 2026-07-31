# Contributing

Contributions are welcome through GitHub issues and pull requests. The project
is currently pre-1.0, so discuss large behavioral, schema, security, or release
changes before implementing them.

## Expectations

- Keep changes focused and preserve backward compatibility unless a breaking
  change is explicitly approved.
- Add observable tests for behavior changes and regression tests for fixes.
- Update English canonical documentation and the corresponding Traditional
  Chinese translation together when normative rules change.
- Never commit credentials, private prompts, internal service details, personal
  absolute paths, or project-specific data.
- Describe the commands run and their outcomes in the pull request.

## Local verification

The repository is not published to npm yet. From a source checkout, install the
locked development dependencies and run the same checks used by CI:

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run package:check
```

Before release, perform a manual opencode smoke check on a machine with
opencode installed; CI intentionally does not install that application. In a
throwaway project, preview and apply `agent-ops init --scope project
--harness opencode --profile advisory --yes`, confirm that only
`.opencode/plugins/agent-ops.js` and the shared managed instruction artifacts
changed, and verify that `opencode.json` was untouched. Repeat with
`--profile guardrails` using a harmless bash command and confirm that
`agent-ops doctor --json` reports the lifecycle-summary caveat as `DEGRADED`.
Do not use a destructive command for this smoke check.

Changes to workflows, release policy, issue forms, or pull request governance
must include focused policy tests and must not add npm tokens or publish from a
pull request or ordinary branch push.

## Maintainer release boundary

The package is prepared as version 0.1.0 but has not been published yet. Before
publication, configure npm Trusted Publishing for this repository and the
`release` GitHub Environment, create a matching `v<version>` tag on `main`, and
run the dispatch-only Release workflow. The workflow performs the full gate and
publishes with OIDC provenance; it does not use an npm token.

The project does not require a Contributor License Agreement or Developer
Certificate of Origin. Contributions are provided under the repository's MIT
License.
