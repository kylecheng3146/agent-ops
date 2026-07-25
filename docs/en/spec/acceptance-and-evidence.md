# Acceptance and Evidence

## EVIDENCE-CRITERION-001

Every acceptance criterion MUST map to observable evidence.

- Trigger: Defining or reviewing task completion.
- Action: Name a command, read-back, or artifact for each criterion.
- Evidence: The final report contains one evidence reference per criterion.
- Positive: `criterion tests → npm test (354 passing tests)`.
- Negative: `The implementation looks correct, so no evidence is needed.`

## EVIDENCE-AGGREGATE-001

The verifier MUST return FAIL when a criterion is missing, duplicated, unknown, or has empty evidence.

- Trigger: Combining independent verifier results.
- Action: Require the exact requested criterion set once each; require non-empty evidence.
- Evidence: The aggregate lists the criterion IDs and their evidence references.
- Positive: `tests PASS [report.json]; scope PASS [diff.txt]`.
- Negative: `tests PASS; tests PASS; extra PASS`.
