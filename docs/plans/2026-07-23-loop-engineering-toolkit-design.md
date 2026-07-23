# Loop Engineering Toolkit Design

**Status:** Approved on 2026-07-23

**Product name:** Loop Engineering Toolkit

**Repository:** `kylecheng3146/agent-ops`

**Package candidate:** `@kylecheng3146/agent-ops`

## Goal

Build a reusable, evidence-driven development-loop toolkit for Codex and
Claude Code. The toolkit turns acceptance criteria, explicit verification,
safe lifecycle hooks, cross-session task state, and independent review into a
repeatable workflow without assuming any application, company, or technology
stack.

## Non-goals

- Copying source-project-specific rules, paths, commands, telemetry, prompts,
  or research data.
- Uploading prompts, commands, repository metadata, or diagnostic telemetry.
- Treating a successful hook exit as proof that a task is complete.
- Guessing verifier commands or running repository-provided code before trust.
- Publishing npm version `0.1.0` as part of the initial implementation PR.
- Loading arbitrary third-party executable plugins in the first release.

## Repository architecture

```text
agent-ops/
├── packages/cli/          # CLI entry point and commands
├── runtime/               # Portable Node.js hook and policy runtime
├── schemas/               # Config, task, evidence, and manifest schemas
├── templates/             # Managed Codex and Claude Code installation assets
├── docs/
│   ├── en/spec/           # Sole normative source
│   ├── en/guides/         # Tutorials and operator guidance
│   ├── zh-TW/spec/        # Complete Traditional Chinese translation
│   ├── zh-TW/guides/
│   └── plans/             # Approved design and implementation plans
├── research/              # Reproducible methods, fixtures, and result schemas
├── tests/fixtures/        # OS, harness, migration, and security fixtures
└── .github/               # CI, issue templates, and protected release workflow
```

The repository is one publishable npm package. TypeScript source is compiled to
JavaScript before packaging. The published package has no runtime dependencies;
TypeScript and Node type declarations are development-only dependencies.

## Installation model

The CLI supports project and user scopes. Project scope is the default. User
scope requires the explicit `--scope user` flag. Interactive terminals receive
a wizard; non-interactive environments must provide every required choice.

The lifecycle is transactional:

```text
discover → validate → calculate → dry-run → approve → back up → stage
         → validate staged state → atomically apply → doctor → manifest
```

Every plan records precondition hashes. Concurrent changes invalidate the plan
instead of being overwritten. Failed apply or validation restores the backup.
`update` and `uninstall` operate only on files and marker blocks recorded in the
manifest.

Project content is installed under `.agent-ops/`. Existing `AGENTS.md` and
`CLAUDE.md` files receive only bounded, marked routing blocks. User content is
never replaced wholesale. Managed marker damage is reported as a conflict.

## Profiles

Profiles are composable views of one implementation, not copied runtimes:

- `core`: normative rules, config, task, verify, review, and lifecycle CLI.
- `advisory`: local reminders, summaries, compaction state, and lifecycle logs.
- `guardrails`: high-confidence secret and destructive-action protections plus
  optional Stop verification.

Advisory failures are fail-open. High-confidence guardrail failures are
fail-closed or delegated to the harness approval system. Verification failures,
timeouts, zero-test runs, and unparseable evidence are `FAIL` or `UNKNOWN` and
can never be rewritten as `PASS`.

## Configuration and trust

`.agent-ops/config.json` is the verifier authority. Discovery adapters for
Node package managers, Python, Go, Rust, and Make only propose commands. A user
must confirm commands before the toolkit stores or executes them.

Commands use separate `command`, `args`, and `cwd` fields and run with
`shell: false`. Shell execution is an explicit, warned exception.

User and project configuration merge with provenance. Project values may
override normal user defaults by stable ID. Project guardrails may strengthen
but cannot silently weaken user guardrails. `config explain` reports the source
of every effective value.

Repository trust binds canonical path, Git remote identity, and config hash.
New repositories do not execute project commands. Changes to identity, config,
or managed scripts invalidate trust. Trust records are user-local and are never
committed.

## Task and evidence model

Every task has an independent ID and 2–5 mechanically verifiable acceptance
criteria. Sessions attach to one task; historical tasks are background context,
not new requirements. Project task state is ignored by Git unless explicitly
exported for team review.

Verification inspects staged, unstaged, and untracked changes. Explicit path
mappings select workspace checks. Unknown, shared, or conflicting scope falls
back to all required checks rather than skipping work.

Persistent evidence contains command ID, argv, cwd, scope, timestamps, exit
code, test count, tool versions, and config hash. Redacted failure output is a
short-lived local artifact. Prompts and raw command output are not persisted by
default.

The same failure fingerprint appearing twice triggers a change-of-approach
warning. The toolkit must not recommend weakening checks, ignoring errors, or
changing tests merely to accommodate an incorrect implementation.

## Independent review

`review prepare` creates a reviewer packet containing the original request,
acceptance criteria, and current artifacts, but not implementation rationale.
`review run --harness codex|claude` may start a read-only fresh reviewer after
explicit authorization. If the CLI, login, or quota is unavailable, the command
prints a copyable prompt and reports that review did not run.

Reviewer results are criterion-level `PASS` or `FAIL` with evidence. The total
is `PASS` only when every criterion passes.

Model dispatch is role-based (`mechanical`, `implementation`,
`deep-reasoning`, `independent-review`). Harness adapters or user configuration
map roles to current models and effort. The normative spec never hardcodes
temporary model names, prices, or quotas.

## Hook runtime

Hooks are implemented in portable Node.js and normalize Codex and Claude Code
payloads into an internal event contract. Unsupported harness events remain
explicitly unsupported. The adapters preserve each harness's native trust,
matcher, input, output, and exit semantics.

Codex currently discovers `hooks.json` or inline hooks next to active config
layers, accumulates hooks across layers, requires exact-definition trust for
non-managed hooks, and can load project hooks only for trusted projects. The
installer therefore prefers one representation per managed layer and never
assumes a project hook replaces a user hook.

Claude Code stores user, project, and local settings separately, embeds hooks
inside settings rather than a standalone `.claude/hooks.json`, and concatenates
instruction files as model context rather than enforcing a hard override
precedence. Its event-specific JSON decisions and exit-code behavior are not
reused for Codex. The adapter prefers Claude's direct exec form where a stable
path is available and treats shell and Windows fallbacks as explicit,
fixture-tested compatibility paths.

Stop verification is opt-in. It runs only confirmed commands selected by scope
mapping and emits command, test-count, exit-code, config-hash, and timestamp
evidence. Passing Stop verification does not complete a task; requirement audit
and independent review remain required.

## Guardrails and privacy

High-confidence credential disclosure, broad recursive deletion, dangerous
reset, and force-push patterns can block or request approval. Ambiguous matches
warn. Exceptions are rule-, scope-, and time-bound; there is no global force
switch.

Logs use allowlisted fields, redaction, restrictive permissions, and time/size
rotation. No network telemetry exists. `init`, `doctor`, `verify`, task, review,
and hook commands are offline by default. Only an explicit `update` queries the
npm registry.

The release pipeline rejects configured source-project terms, internal domains,
personal absolute paths, credential material, and unexpected network calls in
fixtures or npm package contents.

## Documentation and research

English specifications are canonical. They use stable rule IDs and normative
`MUST`, `MUST NOT`, `SHOULD`, and `MAY` language. Core rules use
trigger → action → evidence and include positive and negative examples.
Traditional Chinese files mirror rule IDs and record their source version.

Tutorials and generated CLI/config references do not redefine normative rules.
CI checks links, examples, schemas, translation structure, and source-version
markers.

The first release publishes research protocols, sanitized fixtures, and result
schemas only. Existing internal data is excluded. Results become normative
evidence only after they are rerun in a clean repository with harness, version,
date, sample-size, and limitation metadata.

## Platform, version, and release policy

- Runtime: Node.js `>=22.14.0`.
- CI: exact minimum, latest Node 22, Node 24, and Node 26 compatibility.
- Operating systems: macOS, Linux, and Windows.
- Versioning: Semantic Versioning with versioned config and migrations.
- License: MIT, Copyright (c) 2026 Kyle Cheng.
- Distribution: scoped npm package plus matching GitHub releases.
- Telemetry: none.

Pull requests run type-check, tests, build, package inspection, documentation,
translation, lifecycle, migration, and security fixtures. Publishing requires a
protected manual workflow approval and npm OIDC trusted publishing. Merge never
publishes automatically.

The first implementation delivery ends with a reviewable feature PR and a
verified local `npm pack`. It does not create npm version `0.1.0`.

## Initial delivery sequence

1. The foundation root commit establishes `main` with positioning, MIT License,
   ignore rules, and governance.
2. All implementation and design artifacts are developed on
   `feat/loop-engineering-toolkit` in an isolated worktree.
3. CI and a fresh-context reviewer must pass before a pull request is created.
4. The maintainer decides whether to merge.
5. Initial npm publication requires a separate explicit approval.

## Approved decision record

| ID | Decision |
| --- | --- |
| D001 | Build a cross-harness reusable toolkit with no source-project-specific content. |
| D002 | Provide `core`, `advisory`, and opt-in `guardrails` profiles. |
| D003 | Deliver a one-command CLI rather than manual-copy-only installation. |
| D004 | Use a zero-runtime-dependency Node.js CLI. |
| D005 | Support project and user scopes; project is the safe default. |
| D006 | Implement hooks in Node.js, not Bash or dual runtimes. |
| D007 | Ship `init`, `update`, `doctor`, `uninstall`, and rollback lifecycle support. |
| D008 | Store canonical installed content under `.agent-ops/` and use managed entry blocks. |
| D009 | Use English canonical docs with complete Traditional Chinese translations. |
| D010 | Keep the `agent-ops` repo and use Loop Engineering Toolkit as the product name. |
| D011 | License the entire repository under MIT. |
| D012 | Collect no network telemetry; keep minimal local diagnostics. |
| D013 | Make explicit verifier config authoritative; discovery only suggests. |
| D014 | Store task/session records independently. |
| D015 | Create reviewer packets with optional Codex/Claude runner adapters. |
| D016 | Separate stable specifications from dated, reproducible research. |
| D017 | Use Semantic Versioning and explicit schema migrations. |
| D018 | Support macOS, Linux, and Windows. |
| D019 | Use a language-neutral verifier plus bounded official discovery adapters. |
| D020 | Execute argv with `shell: false` by default. |
| D021 | Merge user/project config with provenance and monotonic security. |
| D022 | Block high-confidence risks and warn on ambiguous patterns. |
| D023 | Publish a modular spec with progressive disclosure. |
| D024 | Support TTY wizard and complete non-interactive flags. |
| D025 | Offer opt-in real Stop verification without automatic task completion. |
| D026 | Use explicit scope mappings and fall back to full required checks. |
| D027 | Require repository trust before executing project commands. |
| D028 | Use npm for installation and GitHub Releases for release records. |
| D029 | Develop in TypeScript and publish compiled JavaScript. |
| D030 | Accept external contributions without CLA or DCO. |
| D031 | Use `Copyright (c) 2026 Kyle Cheng`. |
| D032 | Run automatic CI and require manual release approval. |
| D033 | Use GitHub-native Markdown documentation for the first release. |
| D034 | Do not load third-party executable plugins in the first release. |
| D035 | Query npm only when `update` is explicitly invoked. |
| D036 | Require Node.js `>=22.14.0`. |
| D037 | Keep model dispatch role-based and configuration-driven. |
| D038 | Fail open for advisory errors and fail closed/unknown for safety or evidence errors. |
| D039 | Persist minimal structured evidence and short-lived redacted failure output. |
| D040 | Write normative rules in RFC-style trigger/action/evidence form. |
| D041 | Seed foundation `main`, then deliver implementation through a feature PR. |
| D042 | Do not publish npm in the initial implementation task. |
| D043 | Publish clean research methods, not existing internal results. |

## Authoritative external facts used by the design

- Codex project guidance and hook/config discovery:
  <https://learn.chatgpt.com/docs/agent-configuration/agents-md> and
  <https://learn.chatgpt.com/docs/hooks>
- Claude Code settings, instructions, and hooks:
  <https://code.claude.com/docs/en/settings#settings-precedence>,
  <https://code.claude.com/docs/en/memory#how-claude-md-files-load>, and
  <https://code.claude.com/docs/en/hooks>
- Node.js release schedule: <https://github.com/nodejs/Release>
- npm trusted publishing: <https://docs.npmjs.com/trusted-publishers/>
- npm provenance: <https://docs.npmjs.com/generating-provenance-statements/>
- MIT License text: <https://opensource.org/license/mit>

Harness behavior is version-sensitive. Implementation fixtures and operator
documentation must record the verified version and date rather than treating
this design snapshot as permanent truth.
