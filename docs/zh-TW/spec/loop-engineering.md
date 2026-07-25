# 迴圈工程

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
