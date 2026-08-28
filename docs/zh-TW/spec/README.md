# Loop Engineering 規範

此目錄是英文規範的繁體中文導讀；規範 rule ID 以英文版本為準。

Harness adapter 規則涵蓋 agy、Codex、Claude Code 與 opencode。opencode 整合是
產生的 local plugin，不管理 `opencode.json`。agy 在 project scope 使用
`GEMINI.md` routing 與原生 hooks，對不足以完整支援 loop 的 lifecycle
能力明確標示 degraded。

Configuration 與 manifest 分開版本化。舊 config 會遷移為 Stop verification 與
agy completion gate 預設 disabled 的 config v3；變更 capability 後必須執行經確認的 project
`agent-ops update`，有 verifier 時會一併更新 trust。Stop verification 必須明確啟用、具備 trust、
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
