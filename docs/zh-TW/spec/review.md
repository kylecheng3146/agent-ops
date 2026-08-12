# 審查

English source version: 2026-07-23. Revalidate: when the English specification changes.

## REVIEW-INDEPENDENT-001

獨立審查者 MUST 只收到包含請求、條件、產物參照與證據要求的最小 packet。

- Trigger: 多步驟變更到達審查 checkpoint。
- Action: 排除實作理由、隱藏推理、原始 log 與憑證。
- Evidence: 可見 packet keys 與產物參照，且不含敏感內容。
- Positive: `Packet 僅含條件、檔案與證據要求。`
- Negative: `轉送完整 session transcript 與環境。`

## REVIEW-RESULT-001

審查結果 MUST 保留 PASS、FAIL 或 NOT_RUN，且 MUST NOT 把 NOT_RUN 轉成 PASS。

- Trigger: 審查 CLI 缺少、未登入或 quota 不足。
- Action: 回傳 NOT_RUN、可複製 prompt 與限制原因。
- Evidence: 結果列出 harness、設定的 model 或限制、effort 與原因。
- Positive: `NOT_RUN：需要登入；prompt 可複製。`
- Negative: `沒有審查執行，仍標示 PASS。`

## REVIEW-HARNESS-001

即使 installation 支援多個 harness，一次 review invocation MUST 解析成恰好一個 concrete review target。

- Trigger: 使用 harness selection 執行 `review`。
- Action: 從 `codex`、`agy` 或 `claude` 中選一個；multi-harness installation 與 review execution 分開處理。
- Evidence: argument parsing 會拒絕 review 使用 `all`、`both` 或逗號分隔的多 harness 值。
- Positive: `review --harness claude` 解析成一個 target。
- Negative: `讓一次 review invocation 隱式跑過所有已安裝 harness。`

## REVIEW-READONLY-001

review target MUST 以其自身的唯讀機制啟動；沒有唯讀機制的 target MUST 被跳過，而非在無沙箱狀態下執行。

- Trigger: 為已設定的 target 組建 review invocation。
- Action: 傳入 `-s read-only`（codex）、`--sandbox --mode plan`（agy）或 `--permission-mode plan`（claude）；其餘 target 視為不合格。
- Evidence: spawn 出的 argv 含該 target 的唯讀旗標。
- Positive: `opencode 不是 review target：--agent plan 會靜默退回可寫入的 agent。`
- Negative: `信任 prompt 能阻止審查者修改檔案。`

## REVIEW-CHAIN-001

已設定的 targets 組成有序後備鏈，MUST 僅在「沒有審到」時換下一家，且 MUST NOT 在取得判定後繼續往下試。

- Trigger: 某個已設定的 target 不存在、spawn 失敗或逾時。
- Action: 試下一個 target；遇到 PASS、FAIL 或無法解析的輸出即停止並回報該結果。
- Evidence: spawn 次數等於判定之前的失敗次數。
- Positive: `codex 的 FAIL 是終局；不會再問 agy 第二意見。`
- Negative: `FAIL 之後改試其他 target，直到有人回報 PASS。`

## REVIEW-CONTRACT-001

違反回覆約定的回應 MUST 回報為 NOT_RUN，而非 FAIL。

- Trigger: 審查者遺漏、重複或憑空新增 criterion，或給出空白 evidence。
- Action: 以 reason `unparseable-output` 回報 `NOT_RUN`，不寫入任何 evidence，並保留 FAIL 表示「經審查判定不合格」。
- Evidence: 結果的 reason 能區分協議違規與判定結果。
- Positive: `NOT_RUN：unparseable-output；缺少一條 criterion。`
- Negative: `因為模型的 JSON 格式錯誤就記錄一次失敗的審查。`
