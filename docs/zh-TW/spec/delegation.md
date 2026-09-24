# 委派

English source version: 2026-09-24. Revalidate: when the English specification changes.

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

## DELEGATE-ISOLATION-002

同一個 repository 中並行修改檔案的對話 MUST 各自在自己的 agent-ops worktree 中工作。

- Trigger: `worktree.mode` 為 `auto`，或另一個對話仍開著時，第二個對話也要修改這個 repository。
- Action: 第一次修改前，在主 checkout 執行 `agent-ops worktree add <name> --session <id>`，只在印出的路徑中工作；task 以印出的 `--base` 完成後，用 `agent-ops worktree finish <name>` 合併。
- Evidence: `agent-ops worktree list` 顯示每個修改中的 session 各有一個 worktree，且每次 finish 都回報 fast-forward 合併。
- Positive: `兩個對話分別修改 .worktrees/login 與 .worktrees/cart；各自驗證、review 並 finish。`
- Negative: `兩個對話同時修改主 checkout，彼此的寫入讓對方的驗證與 review 全部作廢。`
