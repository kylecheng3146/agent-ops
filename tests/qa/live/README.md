# Live independent QA evidence

The evidence JSON files summarize retained private fixture records. Each external
fixture has its own independent plan, fresh material author, trusted controller
executions, mandatory verify, two fresh reviews and ordinary task completion.
The source repository's static checks validate the committed summaries; they do
not replace those external executions or turn reasoned inspection into a test.

| Fixture | Requirement |
| --- | --- |
| A | Ordered duration components, both original seeded regression pins, rejection and the human-selected safe range for new h/m forms. |
| B | Human-selected bare-number seconds and canonical input policy; completed history is retained unchanged. |
| C | Real browser success/error rendering and same-tab reload, with the existing shared parser and no dependency/build step. |

References name the original immutable records; copied summaries omit raw local
paths, temporary names, credentials, logs and model transcripts. Original failed
reviews, blocked/UNKNOWN executions, rejected plans and native refusals remain
private. A later PASS never erases an earlier failure.

B's original human decisions retain their old plan, version and answer times.
They predate implementation and are historical provenance, not answers to a later
plan. Its current attestation decision list remains unchanged. The original
implementation session could not be established; current operator metadata does
not establish that historical author identity. Reasoned cases and remaining
limits are explicit in each record.

A's human-selected policy limits only new h/m and compound forms to exact safe
integer seconds. Legacy pure `digits+s` Number conversion, including its existing
rounding/Infinity behavior, and leading zeros remain compatible.

`browser.mjs` is a developer environment probe using installed Chrome and the
Node standard library. It serves a supplied fixture repository on loopback and
uses CDP `Page.reload` in the same tab, checking that a document marker disappears.
The private profile and warnings are returned for diagnosis. This probe is not an
independent QA attestation, does not install a browser and is not run by CI.

```sh
node tests/qa/live/browser.mjs <fixture-repository> 'ui/index.html?d=90s' 'ui/index.html?d=abc' 'ui/index.html' 'ui/index.html?d='
```

Keep its full output private. Only sanitized observations belong in source.
