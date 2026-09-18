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

## DELEGATE-ISOLATION-001

並行的委派寫入者 MUST NOT 共用同一個工作區。

- Trigger: 同一任務中有超過一個委派 agent 會修改檔案。
- Action: 讓委派的修改依序進行，或為每個寫入者配置獨立 Git worktree，合併後再驗證。
- Evidence: `agent-ops verify` 該次執行回傳非 `UNKNOWN` 的狀態。
- Positive: `唯讀掃描並行執行；唯一的修改在協調者工作區進行。`
- Negative: `兩個 subagent 在驗證執行期間修改相同檔案。`
