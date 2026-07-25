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
