# Maintenance

## MAINTAIN-BACKUP-001

Before editing a rule, prompt, model table, memory, or hook, the operator MUST create and verify a recoverable backup when it contains no literal secret.

- Trigger: A maintained policy or lifecycle file will change.
- Action: Copy the source to the dated backup path and compare it before editing.
- Evidence: The backup path and comparison command are recorded.
- Positive: `cmp source backup` succeeds before the patch.
- Negative: `Edit a hook in place without a recoverable copy.`

## MAINTAIN-FACT-001

Volatile harness facts MUST live in adapter or research documentation and MUST include a revalidation condition.

- Trigger: Recording a versioned or vendor-specific behavior.
- Action: State the source date and when it must be checked again.
- Evidence: The document has a source and `Revalidate:` condition.
- Positive: `Revalidate: when the vendor hook reference changes.`
- Negative: `Treat a transient CLI flag as a permanent core rule.`
