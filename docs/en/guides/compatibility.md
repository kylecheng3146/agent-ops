# Compatibility

From 1.0.0, agent-ops follows Semantic Versioning: within 1.x, a release does
not break the guaranteed interfaces below. Before 1.0.0, minor releases may
still change them, and the changelog marks each breaking change.

## Guaranteed interfaces

- Commands and flags of the `agent-ops` CLI and their documented behavior.
- The JSON envelope printed with `--json` or written by `--output`: `code`,
  `status`, `data`, `errors`, and the documented fields of `data`.
- Error codes named in the README, the guides or the specification.
- Exit codes: `0` for success, `2` when review or batch did not run
  (`REVIEW_NOT_RUN`, `BATCH_NOT_RUN`), `1` for any other error.
- `.agent-ops/config.json`, the `--surface-file` audit format, and the JSON
  schemas shipped in `schemas/`.
- Data committed to the repository: the escape ledger in `.agent-ops-escapes/`
  and finish notes in `refs/notes/agent-ops`.
- Local state across upgrades: a newer 1.x release reads, or migrates, config
  and state written by an older 1.x release.

## Not guaranteed

- Preview features, currently Office (`agent-ops office`).
- Human-readable text output; parse `--json` instead.
- The internal formats of local state in `.agent-ops/tasks/`,
  `.agent-ops/state/` and the Git common directory (run state, receipts,
  checkpoints).
- The text of managed rule files such as `.agent-ops/CLAUDE.md` and
  `.agent-ops/AGENTS.md`; `agent-ops update` rewrites them.
- Reviewer and advisory prompts.
- Hook wire formats, which each host defines.

## Gate changes

Gates (surface audit, verify, review and the completion gate) get stricter as
gaps are found. A gate that becomes stricter or looser ships in a minor
release with a `Gate:` entry in the changelog. A fix that closes a way to pass
a gate without proof may ship in a patch release. Removing or renaming a
documented error code is a breaking change and waits for a major release.

## Deprecation

A deprecated command or flag keeps working for at least one minor release,
prints a warning on stderr whenever it is used, is listed as deprecated in the
changelog, and is removed only in the next major release.

## Upgrades and migration

`agent-ops update` brings installed files to the current release. A newer 1.x
release reads or migrates config and state from an older 1.x release.
Downgrading is not supported: an older release may refuse state written by a
newer one.

## Supported releases

Only the latest 1.x minor release receives fixes, including security fixes;
upgrade to receive them. The package requires the Node.js versions in
`engines`; dropping a Node.js release that has reached end of life is a minor
release.

## Platforms and hosts

| Area | Support |
| --- | --- |
| macOS | All features, including background native runs (`agent-ops run`). |
| Linux and Windows | All features except background native runs, which stop with `RUN_BACKGROUND_UNSUPPORTED`. |
| Hosts | Each host's capabilities follow the [harness adapter matrix](../spec/harness-adapters.md); the completion gate runs on agy and Claude Code. |

A change to a platform or host tier is listed in the changelog.
