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
- Action: 第一次修改前，在主 checkout 執行 `agent-ops worktree add <name> --session <id>`，只在印出的路徑中工作；task 以印出的 `--base` 完成後，用 `agent-ops worktree finish <name>` 合併。合併目標是 session 開始時主 checkout 所在的 branch，不論該 checkout 現在在哪裡。
- Evidence: `agent-ops worktree list` 顯示每個修改中的 session 各有一個 worktree，且每次 finish 都回報 fast-forward 合併。
- Positive: `兩個對話分別修改 .worktrees/login 與 .worktrees/cart；各自驗證、review 並 finish。`
- Negative: `兩個對話同時修改主 checkout，彼此的寫入讓對方的驗證與 review 全部作廢。`

## DELEGATE-ISOLATION-003

同一個 session 中會寫入檔案的 subagent MUST 各自在自己的 agent-ops worktree 中工作，並各自擁有 task、開工前修改意圖與局部驗證。

- Trigger: `worktree.mode` 為 `auto`，且 subagent 寫入檔案。subagent 內的 hook 呼叫會在父對話的 `session_id` 之下帶有自己的 `agent_id`；沒有 `agent_id` 的 payload 視為該 session 的主執行緒。
- Action: 第一次被擋下的寫入會配發一個屬於該 session 與該 agent 的 worktree；之後用絕對路徑在那裡編輯，因為 hook 的 `cwd` 不會跟著 `cd` 改變。每個 subagent 編輯前用 `task create --intent` 記錄意圖，提交後在自己的 worktree 執行 `agent-ops verify --task`。協調者從主 checkout 執行 `agent-ops task advance --task <parent-id> --session <id> --yes`：整合子 worktree，在同一候選版本驗證所有 criteria、完成兩輪全樹 review、保存本地證據，再執行 finish。存在兄弟子 worktree 時，直接 finish 單一子 worktree 會被拒絕。
- Evidence: `agent-ops worktree list` 為每個子 worktree 顯示 `agent:`；`.git/agent-ops/receipts/` 的最終收據保存整合後 task tree、意圖、驗證證據與 review 報告。
- Positive: `兩個 subagent 各自提交並驗證；一次 task advance 整合兩者並完成最終證據門檻後 finish。`
- Negative: `subagent 修改協調者的 worktree，或兩個 subagent 修改同一個 worktree，導致一次 review 涵蓋兩個 task 的變更。`
