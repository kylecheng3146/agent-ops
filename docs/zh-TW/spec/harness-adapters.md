# Harness Adapter

English source version: 2026-07-23. Revalidate: when the English specification changes.

## HARNESS-ADAPTER-001

Adapter MUST 保留原生 harness 語意，並將未支援行為標示為 UNKNOWN。

- Trigger: 將可攜 lifecycle 或 review 行為映射到原生 harness。
- Action: 保持 ownership 狹窄、保留使用者設定並記錄限制。
- Evidence: adapter 測試涵蓋既有設定與未支援結果。
- Positive: `Codex blocking outcome 未確認原生 denial 時保持 UNKNOWN。`
- Negative: `假設 Claude exit semantics 適用 Codex。`

## HARNESS-ADAPTER-002

Adapter MUST 具備冪等性，且 MUST NOT 刪除使用者擁有的 handler。

- Trigger: 安裝、更新或移除 managed harness 設定。
- Action: 只變更穩定 managed marker 或 owned handler。
- Evidence: 既有設定 fixture 在 apply 與 uninstall 後保持完整。
- Positive: `更新 managed handler，無關 handler 仍逐位元存在。`
- Negative: `以 toolkit defaults 取代整份 settings。`
