# 委派

English source version: 2026-07-23. Revalidate: when the English specification changes.

## DELEGATE-SCOPE-001

委派 MUST 使用有界任務，並明確指定產物、驗收條件與回傳格式。

- Trigger: 調查涉及未知檔案、廣泛掃描或獨立工作流。
- Action: 僅傳送必要上下文，要求有證據的發現。
- Evidence: 委派紀錄列出範圍、輸出與驗證方式。
- Positive: `檢查 runtime/src/review，回傳受影響檔案與測試。`
- Negative: `探索整個 repo 並修正任何你看到的問題。`

## DELEGATE-OWNERSHIP-001

協調者 MUST 保留最終整合與驗證責任。

- Trigger: 委派任務回傳程式碼、發現或變更提案。
- Action: 讀回產物、調和衝突並執行必要 gate。
- Evidence: 協調者記錄最終命令輸出。
- Positive: `審查者回傳 PASS；協調者重新跑 typecheck 與測試。`
- Negative: `不看 diff 就接受委派者的完成宣告。`
