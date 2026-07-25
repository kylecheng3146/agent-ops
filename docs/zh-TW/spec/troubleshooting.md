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
