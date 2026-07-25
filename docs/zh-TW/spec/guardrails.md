# 防護規則

English source version: 2026-07-23. Revalidate: when the English specification changes.

## GUARDRAIL-SECRET-001

系統 MUST 遮罩憑證，且 MUST NOT 將秘密持久化到 prompt、log、fixture 或報告。

- Trigger: 處理命令輸出、設定或外部輸入。
- Action: 使用共用 redaction 邊界，只保留有界證據。
- Evidence: redaction 測試證明代表性憑證形式不存在。
- Positive: `Authorization header 變成 redacted marker。`
- Negative: `為了除錯保存原始環境變數。`

## GUARDRAIL-DESTRUCTIVE-001

破壞性或強制命令 MUST 在沒有精確明確例外時被阻擋。

- Trigger: 命令會刪除、覆寫、force-push 或改變受保護狀態。
- Action: 預設阻擋並回報穩定 rule ID。
- Evidence: 正反命令 fixture 展示邊界。
- Positive: `git push --mirror 被阻擋。`
- Negative: `允許所有包含熟悉子字串的命令。`
