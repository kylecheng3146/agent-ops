# 疑難排解

English source version: 2026-07-23. Revalidate: when the English specification changes.

## TROUBLESHOOT-REPRO-001

疑難排解 MUST 先捕捉最小可重現症狀與邊界。

- Trigger: 失敗模糊、間歇性或跨越多層。
- Action: 記錄命令、輸入、觀察輸出與最小疑似 owner。
- Evidence: fixture 或命令能重現症狀。
- Positive: `fixture 以精確 argv 重現 parser 失敗。`
- Negative: `先重寫無關模組再重現報告。`

## TROUBLESHOOT-SAFETY-001

操作者 MUST 在修正前保留失敗證據。

- Trigger: 已有 regression test 或診斷。
- Action: 新增或保留 regression test，再實作最小修正。
- Evidence: 測試在修正前失敗、修正後通過。
- Positive: `RED parser test → GREEN parser test。`
- Negative: `因為不方便就刪除失敗測試。`

## TROUBLESHOOT-DRIFT-001

update 輸出 `repaired:` 行，或 doctor 回報漂移時，MUST 視為 managed 內容與 manifest 不符，而不是 update 失敗。

- Trigger: `agent-ops doctor` 對 managed artifact 回報 `UPDATE_REQUIRED`，或對 managed block 回報 DEGRADED，或 `agent-ops update` 輸出 `repaired: <path> (<reason>)`。
- Action: 執行 `agent-ops update`。它會重寫已漂移的 managed artifact，或標記完整的 block 標記之間的內容。`.agent-ops/config.json`、`agent-ops uninstall`、不在 manifest 內的路徑，以及標記缺失、重複或順序顛倒的 block 仍會失敗；這些要手動修正後再 update。見 MAINTAIN-DRIFT-001。
- Evidence: update 輸出列出每個被修復的路徑，且再跑一次 `agent-ops doctor` 不再回報漂移。
- Positive: `被還原的舊版 GEMINI.md 被重寫，並列出 "repaired: .agent-ops/GEMINI.md (artifact drift)"。`
- Negative: `為了消除結束標記缺失的 MANAGED_BLOCK_CHANGED 而刪除 manifest。`
