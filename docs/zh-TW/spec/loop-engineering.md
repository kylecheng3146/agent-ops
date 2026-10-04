# 迴圈工程

## LOOP-RUN-001

`run` MUST 保留原始使用者目標，並要求目前有效的 agent-ops 證據。

- Trigger: 啟動、修復或恢復 native goal run。
- Action: writer 綁定目前 lease，並要求最終 verify、雙 review 與 receipt 證據。
- Evidence: run ledger 與封存 receipt 綁定目前 candidate 及原始目標。
- Positive: 恢復未完成清理時，保留 target 與已保存的 final proof。
- Negative: 只因 native goal completion 就把 run 標為 complete。

- macOS supervisor 在啟動 goal 前保存 Claude／Codex native 身份。同 host writers 使用獨立 worktrees 與目前 generation lease；coordinator 計入最多兩個 writer。依賴以固定交付提供，child baseline 在依賴 commits 進入 checkout 後建立。
- 預設 60 分鐘預算計算 active intervals 聯集，包含 setup、verify、review、整合。resume 保留時間與 usage epochs；缺少計數維持 UNKNOWN，partial usage 不算完整成本。
- 實質疑問暫停並要求明確回答。修復保留目標與失敗紀錄；連續兩次相同失敗且無進展停止該 worker 及其依賴，獨立 task 仍可執行。review findings 在下次 final gate 前必須有回歸 pin 或記錄 review-only fallback。
- native completion 僅是觀察。完成必須有必要驗證、兩輪 fresh review、完成的 task state、綁定 target 的 receipt。整合在移動 target 前封存 candidate，記錄 task、receipt、note、cleanup 進度；恢復驗證封存證據，不重做成功的 target mutation。不一致的 target 維持 blocked。
- Stop 先保存禁止續跑，再確認受管 process group 死亡。crash recovery 不得取代仍存活或身份不明的 writer。dirty checkout、版本漂移、restart storm 保留現場。重開機／login 改變必須明確 resume；不修改全域 host policy。

English source version: 2026-07-23. Revalidate: when the English specification changes.

## LOOP-START-001

操作者 MUST 在編輯前列出驗收條件，並在每項條件都有證據時停止。

- Trigger: 開始多步驟實作或除錯迴圈。
- Action: 記錄 2–5 個可觀察條件，只檢查目前步驟所需檔案。
- Evidence: 任務紀錄與最終報告把每項條件連到命令或讀回內容。
- Positive: `條件：測試通過；套件建置；讀回變更檔案。`
- Negative: `先修改，再決定成功標準。`

## LOOP-VERIFY-001

操作者 MUST 在宣告完成前，為每項驗收條件執行最小且可靠的證明。

- Trigger: 變更看似完成或迴圈準備停止。
- Action: 先跑針對性測試，再跑必要 gate，並回報失敗或不可用檢查。
- Evidence: 命令輸出包含非零測試數與結果。
- Positive: `npm run typecheck && npm test` 且所有測試通過。
- Negative: `命令 exit 0 但沒有發現測試，仍視為證明。`
