# Changelog

All notable changes to this unreleased project are documented here.

## [Unreleased]

- Added a banner and an arrow-key Yes/No selector to interactive `init`, `update`, `uninstall`, and `trust grant` confirmations. Decorative only: skipped for `--json`, non-interactive runs, and narrow terminals, with no runtime dependency added.
- Fixed a Windows-only flake where private-state locks failed because a cold PowerShell start exceeded the process identity timeout.
- Added hook registration to `init` and `update`, writing agent-ops owned handlers into `.claude/settings.json` and `.codex/hooks.json` for profiles that enable lifecycle capabilities.
- Added the `agent-ops hook <harness> <event>` runtime entry point and a Claude hook entry script, both fail-open.
- Added hook removal to `uninstall`, which strips only owned handlers and preserves foreign settings.

## [0.1.2]

- Fixed filesystem identity snapshots to preserve 64-bit Windows file indexes exactly.

## [0.1.0]

- Added cross-platform CI coverage for macOS, Linux, and Windows across the supported Node matrix.
- Added a protected, dispatch-only release workflow prepared for npm trusted publishing.
- Added installed-package smoke checks, issue forms, pull request evidence requirements, and release policy tests.
- Added source-checkout quick-start and CLI usage documentation.
