# 判斷

English source version: 2026-07-23. Revalidate: when the English specification changes.

## JUDGMENT-STOP-001

當需求、授權或必要決策有重大歧義時，操作者 MUST 停止。

- Trigger: 下一步會替使用者選擇產品意圖、安全政策或架構。
- Action: 說明具體歧義並請使用者決定。
- Evidence: 交接內容列出受阻選擇與安全替代方案。
- Positive: `套用安裝前詢問要 project 或 user scope。`
- Negative: `因為方便就假設 project scope。`

## JUDGMENT-RETRY-001

相同失敗在沒有新資訊時重複發生，操作者 MUST 改變方法。

- Trigger: 同一命令或診斷失敗兩次。
- Action: 檢查失敗邊界，改用另一個有界檢查或停止。
- Evidence: 報告記錄重複失敗與改用的檢查。
- Positive: `兩次相同失敗後改查隔離 fixture。`
- Negative: `無限重跑完全相同的失敗命令。`
