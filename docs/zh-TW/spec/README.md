# Loop Engineering 規範

此目錄是英文規範的繁體中文導讀；規範 rule ID 以英文版本為準。

Harness adapter 規則涵蓋 Codex、Claude Code 與 opencode。opencode 整合是
產生的 local plugin，不管理 `opencode.json`。

Configuration 與 manifest 分開版本化。Config v1 會遷移為預設 disabled Stop
verification 的 config v2；變更 capability 後必須先執行 `agent-ops update`，
再執行 `agent-ops trust grant`。Stop verification 必須明確啟用、具備 trust、
為 report-only，且永遠不會完成 task。Dry-run plan 會隱藏 foreign settings
內容；routing migration 一旦套用即為單向。

- [迴圈工程](./loop-engineering.md)
- [驗收與證據](./acceptance-and-evidence.md)
- [判斷](./judgment.md)
- [委派](./delegation.md)
- [審查](./review.md)
- [疑難排解](./troubleshooting.md)
- [防護規則](./guardrails.md)
- [維護](./maintenance.md)
- [Harness adapter](./harness-adapters.md)
