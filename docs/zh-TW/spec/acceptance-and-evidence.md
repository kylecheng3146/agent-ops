# 驗收與證據

English source version: 2026-07-23. Revalidate: when the English specification changes.

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
