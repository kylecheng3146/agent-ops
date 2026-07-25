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
