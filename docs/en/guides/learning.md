# Local advisory learning

`agent-ops learn` is an opt-in, one-round experiment on acceptance-criteria
scenario omission detection. Model weights stay fixed. It consumes existing CLI
quota, with at most two candidates, one composition and twelve CLI invocations.
Invocation counts are not provider-call counts. Token/cost fields are recorded
only when reported; dollar estimates are not subscription bills.

Run from a trusted, clean checkout. Commit an independently labelled JSON suite
before authoring candidates. It needs at least two probe tasks and two different
held-out tasks. See `tests/learning/scenarios.json` for the shape, not evidence of
real-world improvement. Each snapshot needs originalGoal, 2–5 criteria and an
included surface. Expected labels use the fixed five scenario dimensions.
Do not put holdout tasks or answers in the source task's diff, goal or evidence.
The controller rejects visible holdout IDs/goals in authoring prompts.

```sh
agent-ops learn run --receipt <local-finish-receipt.json> --suite tests/learning/scenarios.json --model <explicit-versioned-model-id>
agent-ops learn list
agent-ops learn show <trial-digest>
agent-ops learn replay <trial-digest>
agent-ops learn retire --reason 'Observed advice is no longer applicable'
agent-ops learn rollback <previously-adopted-version-digest> --reason 'Restore prior guidance'
```

`--target` may select only a configured independent-review target. For a
multi-task receipt select `--task`. `--no-execute` saves NOT_RUN with no model
calls. Only final, sealed, contract-bound delivery receipts are accepted. Normal
successful tasks need no escape declaration. Collection preserves task, diff,
verification and both review rounds, redacting strings before model use/storage.

The baseline and every candidate execute twice in fresh empty workspaces, with
the same explicit model, effort, read-only flags, environment digest and frozen
inputs. Strategies are matched to each task's included surface just as in the
ordinary advisory. Propose sees delivered evidence and baseline probe behavior;
Compose sees probe contrasts from all candidates, never holdout results or
expected labels. The composed strategy executes twice again. No model can edit
the trusted evaluator, suite, tests, trust, sandbox or completion policy.

The fixed evaluator counts missed expected dimensions and extra dimensions.
Every omission must reference a concrete ordinary advisory recommendation;
unclassified extra recommendations count as false positives. Promotion requires
strictly fewer held-out misses, no extra false positives and no probe regression
in both repetitions. Every individual probe/holdout case must also preserve its
previously detected expected dimensions, introduce no new false-positive dimension,
and not increase its unclassified recommendation count. Gains cannot offset another case's loss.
An unchanged composition, including strategy/path reorderings, retains baseline
without further model evaluation. Inconsistent omission/score results, invalid/missing
output, execution failure, unchanged candidates or changed execution conditions
retain baseline. This checks dimension classification, not the semantic quality
of every sentence. Small-sample adoption is provisional, not a claim of general
coding success or statistical significance.

A strategy must actually reach the evaluated cases: out-of-scope additions do
not create an intervention. A graded outcome change on a case receiving identical
baseline/composition inputs is unsupported contrast and retains baseline.

Duplicate candidates and overlapping strategy scopes are refused. Scopes are
exact paths or `directory/**`. Adopted entries accumulate unchanged (up to 16);
automatic revision/removal of an old entry is deferred until its original
regression cases can be retained. Compose may revise new proposals. Retire or
rollback handles invalidation explicitly with a reason; no age-based automatic
deletion occurs. A stale concurrent baseline cannot overwrite a newer revision.

Private state is shared by linked worktrees under the Git common directory at
`agent-ops/learning/`: immutable digest-named trials/versions/use records and a
locked generation-checked active pointer/history. Trials record prompts, schemas,
outputs, scores, model/permissions/environment binding, duration and reported
usage. `replay` re-scores saved outputs and checks their sequence/conditions; it
does not call the provider or promise identical fresh stochastic outputs.

New related criteria advisory attempts load the adopted revision as untrusted
context. A recommendation materially using it cites
`[experience:<id>@<revision>]` in its reason. Use records distinguish loaded
context from **model-reported use**; citations alone are not causal proof.
Existing attempts remain historical snapshots, like escape lesson context; they
are not automatically rerun when the library changes. Explicit advisory rerun
uses current context. This avoids spending quota merely to refresh old advice.

Collection and experiments write only private state, after reading sealed
delivery evidence. Adoption writes its immutable trial/version before switching
the pointer; recovery changes only that pointer/history. Advisory attempts write
their private snapshot/use record. These writes do not alter source fingerprints,
task criteria, verification evidence or formal review attestations. The normal
task → commit → verify → two fresh reviews → finish chain remains required.

There is no background model work, extra dependency, cross-machine sharing,
training, editable grading policy or automatic repair of product code.
