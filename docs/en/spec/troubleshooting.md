# Troubleshooting

## TROUBLESHOOT-REPRO-001

Troubleshooting MUST first capture a minimal reproducible symptom and its boundary.

- Trigger: A failure is vague, intermittent, or crosses layers.
- Action: Record the command, inputs, observed output, and smallest suspected owner.
- Evidence: A fixture or command reproduces the symptom.
- Positive: `Fixture reproduces the parser failure with exact argv.`
- Negative: `Rewrite unrelated modules before reproducing the report.`

## TROUBLESHOOT-SAFETY-001

The operator MUST preserve the failing evidence before applying a fix.

- Trigger: A regression test or diagnostic is available.
- Action: Add or retain a regression test, then implement the smallest correction.
- Evidence: The test fails before the fix and passes after it.
- Positive: `RED parser test → GREEN parser test.`
- Negative: `Delete the failing test because it is inconvenient.`

## TROUBLESHOOT-DRIFT-001

An update that reports `repaired:` lines or a doctor check that reports drift MUST be read as managed content that no longer matched the manifest, not as a failed update.

- Trigger: `agent-ops doctor` reports `UPDATE_REQUIRED` for managed artifacts or DEGRADED managed blocks, or `agent-ops update` prints `repaired: <path> (<reason>)`.
- Action: Run `agent-ops update`. It rewrites a drifted managed artifact or the content between intact block markers. It still fails on `.agent-ops/config.json`, `agent-ops uninstall`, paths absent from the manifest, and blocks with missing, duplicated or reordered markers; fix those by hand, then update again. See MAINTAIN-DRIFT-001.
- Evidence: The update output names each repaired path and a second `agent-ops doctor` reports no drift.
- Positive: `A restored older GEMINI.md is rewritten and listed as "repaired: .agent-ops/GEMINI.md (artifact drift)".`
- Negative: `Delete the manifest to silence MANAGED_BLOCK_CHANGED on a block whose end marker is missing.`
