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

## MAINTAIN-PLUGIN-001

Generated harness plugins MUST be treated as managed artifacts and MUST NOT be
hand-edited in place.

- Trigger: Updating the runtime, capabilities, or a vendor plugin contract.
- Action: Regenerate the opencode shim, verify its manifest hash, and revalidate the vendor behavior before release.
- Evidence: The artifact hash and shim import tests pass; release documentation records the revalidation condition.
- Positive: `agent-ops update` rewrites a changed plugin after ownership checks pass.
- Negative: `Patch the opencode plugin manually and retain the old manifest hash.`

## MAINTAIN-DRIFT-001

`agent-ops update` MUST rewrite a managed artifact or managed block whose content drifted from the manifest, MUST report each rewrite, and MUST NOT rewrite anything it cannot prove it owns.

- Trigger: `agent-ops update` finds a managed whole-file artifact whose hash differs from the manifest, or a managed block whose markers are intact but whose content changed, for example after a Git operation restored an older tracked revision.
- Action: Rewrite the artifact, or only the content between the markers, and list it as `repaired: <path> (<reason>)`. Keep `.agent-ops/config.json`, `agent-ops uninstall`, paths absent from the manifest, and blocks with missing, duplicated or reordered markers as errors; the last needs a person to locate the owned span.
- Evidence: `InstallPlan.repaired` and the update output name each rewritten path; text outside the markers is byte-identical afterwards.
- Positive: `A tracked .agent-ops/GEMINI.md restored to an older version is rewritten by update, with "repaired: .agent-ops/GEMINI.md (artifact drift)".`
- Negative: `Rewrite a block whose end marker was deleted, or overwrite .agent-ops/config.json.`
