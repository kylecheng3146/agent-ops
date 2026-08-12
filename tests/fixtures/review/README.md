# Review target stdout fixtures

Real transport-layer output captured 2026-08-12, one trivial print call per target
(prompt: `reply with the single word OK`). These are transport-shape samples for
`extractFinalMessage()`, not assertions about model behaviour.

| File | Captured with |
|---|---|
| `claude-stdout.txt` | `claude -p … --output-format json --permission-mode plan` |
| `agy-stdout.txt` | `agy -p … --output-format json --sandbox --mode plan` |
| `codex-stdout.txt` | `codex exec -s read-only …` |
| `codex-stderr.txt` | same run, first 20 lines — evidence that codex sends all progress to stderr and leaves stdout as the bare final message |

The final message lives under a different key in every envelope: claude `.result`,
agy `.response`, codex the whole of stdout. No two targets share a branch.

No `opencode` fixture: `--agent plan` is rejected as a subagent and silently falls
back to a writable agent, so opencode cannot satisfy the read-only precondition and
is not a supported review target. See
`docs/plans/2026-08-12-external-review-cli-targets.md`.
