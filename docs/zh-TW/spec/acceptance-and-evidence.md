# 驗收與證據

English source version: 2026-09-07. Revalidate: when the English specification changes.

## EVIDENCE-CRITERION-001

每項驗收條件 MUST 對應可觀察的證據。

- Trigger: 定義或審查任務完成度。
- Action: 為每項條件命名命令、讀回內容或產物。
- Evidence: 最終報告為每項條件提供一個證據參照。
- Positive: `tests → npm test（354 個測試通過）`。
- Negative: `看起來正確，所以不需要證據。`

## EVIDENCE-AGGREGATE-001

驗證器 MUST 在條件缺少、重複、未知或證據為空時回傳 FAIL。

- Trigger: 合併獨立驗證器結果。
- Action: 僅接受精確的 criterion 集合且各一次，並要求非空證據。
- Evidence: 聚合結果列出 criterion ID 與證據參照。
- Positive: `tests PASS [report.json]；scope PASS [diff.txt]`。
- Negative: `tests PASS；tests PASS；extra PASS`。

## EVIDENCE-COMPLETION-001

`agent-ops task complete` MUST 獨立於 host、啟用的 profile 與 Stop hook，驗證任務是否可完成。

- Trigger: 完成任務，包括重複提交完成請求。
- Action: 寫入狀態前檢查 required verifier、目前有效的證據、全任務審查與子任務完成狀態。
- Evidence: 僅在檢查通過後回傳 `TASK_COMPLETED`；拒絕請求時保留原狀態。
- Positive: 有目前有效的驗證證據與 task-bound review，且子任務已完成，才允許收口。
- Negative: 填入 `criterion=PASS`、提供舊 review，或封存未完成子任務來繞過檢查。

- 每項 criterion 至少需要一個 required verifier，且其列出的每個 required verifier 都要有目前有效的 PASS evidence。即使 path mapping 選出較小範圍，verify 也會包含 task 明列的 required 命令。請提供 `agent-ops verify --task <id>` 產生的證據檔參照，不能只填命令文字或自行宣稱 PASS。
- 任務的 config baseline、evidence 必須符合目前有效設定與所選 scope 的來源指紋。尚未解決的驗證失敗會阻擋完成；舊 PASS 不能蓋過較新的失敗，同時間戳的矛盾結果也會阻擋。
- 使用 `agent-ops review --task <id> --yes` 審查整個任務。完成時必須有目前有效且綁定該 task 的 PASS attestation；generic review 與只涵蓋部分 criterion 的 review 不算。
- 開始一次已授權的 review 會撤銷該來源指紋先前的 attestation。若 reviewer 未能執行或未通過，完成前必須重新取得成功的全任務 review。
- 所有子任務與後代任務都必須已完成，且沒有尚未解決的失敗。封存未完成工作不算完成；已完成或封存的 parent 不能新增子任務。若放棄某個 subtask，請重建不含該取消分支的 parent task，並重新驗證與審查新的 task tree。
- 證據、來源與設定檢查在 task store 鎖外執行。再次確認來源與設定後，完成操作才短暫鎖住狀態，比對 task 快照（改變時回傳 `TASK_COMPLETION_STATE_CHANGED`）、重查後代任務並原子寫入。慢速檢查不會阻擋 task 讀取或其他修改；完成被拒絕時，併發修改仍會保留。

既有 task 檔案仍可直接讀取，不需資料格式遷移。缺少 config baseline、使用任意文字證據，或含有未完成但已封存子任務的舊任務，必須重建並完成驗證與審查。重複執行 complete 也會重新驗證證據；舊的 completed 狀態本身不夠。Runtime 呼叫端必須提供 `TaskServiceOptions.completion`；缺少此 repository context 時，complete 會拒絕執行，但仍可讀取任務。

Commit 前，verify、review、complete 使用預設 worktree scope。Commit 後，三個命令都使用相同的 `--base <git-ref>`，為已提交範圍重新產生證據；runtime 呼叫端使用 `TaskServiceOptions.completion.base`。Base 模式要求 worktree 乾淨。沒有 worktree 變更又未指定 base 時，complete 會回傳 `TASK_COMPLETION_SCOPE_REQUIRED`。agy Stop gate 仍檢查 worktree scope 的證據：請在 commit 前完成並停止，或由使用者檢查已完成的 base-scope 任務後，核准一次性的 Stop permit。

這項機制強制的是 toolkit 的完成命令，無法阻止 host 直接用自然語言宣稱完成，也無法阻止具有相同檔案權限的 process 直接改寫 task／evidence 檔案；它不會鎖住 Git 或其他來源檔案寫入者。

Project init/update 在所有 harness 與 profile 安裝 `.agent-ops/.gitignore`，忽略 `/tasks/` 與 `/reviews/`；若已有使用者自建的 `.agent-ops/.gitignore`，init/update 會回傳 `UNMANAGED_INSTALL_PATH`：先將原檔備份到其他位置，並將自訂規則移到根目錄 `.gitignore`（加上 `/.agent-ops/` 前綴），再重試。這些目錄若包含 index 中的檔案（即使 tracked 且未修改）或 staged 的 runtime 刪除，Git 範圍收集會回傳 `CHANGE_SURFACE_TRACKED_RUNTIME`。請先移出真正的程式來源、安裝 ignore 規則，再執行 `git rm -r --cached --ignore-unmatch -- .agent-ops/tasks/ .agent-ops/reviews/`，保留本機檔案並解除追蹤。若有 staged 刪除，先提交清理 commit，再重新產生 verify/review 證據。啟用的 completion Stop gate 也會以 `COMPLETION_GATE_TRACKED_RUNTIME` 阻擋此狀況並提供修復訊息。請從 Git repository 根目錄執行 verify/review；目前路徑與指紋收集不支援巢狀 project root。Uninstall 會移除 managed ignore 檔，但保留 runtime 輸出。
