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

明確指定的 target MUST 已存在於 configured independent-review role。它只會將
configured chain 縮窄為單一 target，並保留 model、effort 與 timeout policy。
未提供 `--harness` 時，完整 configured chain 仍套用 host-aware ordering；每個
結果都以 `plannedTargets` 保存這個實際順序。

## REVIEW-READONLY-001

review target MUST 以其自身的唯讀機制啟動；沒有唯讀機制的 target MUST 被跳過，而非在無沙箱狀態下執行。

- Trigger: 為已設定的 target 組建 review invocation。
- Action: 傳入 `-s read-only`（codex）、`--sandbox --mode plan`（agy）或 `--permission-mode plan`（claude）；agy 必須在一次性 repository clone 中執行；其餘 target 視為不合格。
- Evidence: spawn 出的 argv 含該 target 的唯讀旗標。
- Positive: `agy 使用 sandboxed plan mode；opencode 仍不合格。`
- Negative: `信任 prompt 能阻止審查者修改檔案。`

每次 review 都 MUST 使用全新 session（`sessionIsolation: "fresh"`）並在
disposable repository clone 中執行。review chain 優先選擇不同於 hosting CLI 的
target；沒有其他可用 target 時，才允許同 CLI 的 fresh review，但輸出 MUST 明確
標示 `DEGRADED: isolated self-review`。不得 resume 開發 session 作為獨立審查。

Capability 與模型啟動進度即使在 JSON 模式也寫到 stderr；reviewer 原始輸出仍
維持 bounded capture，不直接串流。SIGINT 或 SIGTERM 會中止 active process
tree，不 fallback、不寫 attestation；timeout 保留獨立 NOT_RUN reason，不得被
扁平化為 `missing-cli`。

## REVIEW-CHAIN-001

已設定的 targets 組成有序後備鏈，MUST 僅在「沒有審到」時換下一家，且 MUST NOT 在取得判定後繼續往下試。

- Trigger: 某個已設定的 target 不存在、spawn 失敗或逾時。
- Action: 無法解析輸出時試下一個 target；遇到第一個 PASS 或 FAIL 即停止並回報。
- Evidence: spawn 次數等於判定之前的失敗次數。
- Positive: `codex 的 FAIL 是終局；不會再問任何 target 第二意見。`
- Negative: `FAIL 之後改試其他 target，直到有人回報 PASS。`

## REVIEW-ADVERSARIAL-001

PASS MUST 交給另一個合格 target 嘗試反駁，且反駁成立時 MUST 使整體判定為 FAIL。

- Trigger: primary target 回報 PASS，且尚有未走過的合格 target。host target 永不擔任挑戰者。
- Action: 將前一份 report 以不可信資料交給該 target 並要求它反駁；反駁成立即回報 FAIL，且無論結果都記錄為 `adversarial`。
- Evidence: `adversarial` 記載挑戰者與是否反駁成立；未能產出 report 的挑戰者則記錄在 attempt 清單。
- Positive: `codex 判 PASS，claude 找到 blocking 缺陷，整體判定 FAIL。`
- Negative: `為了讓複查看起來有效而編造反駁。`
- Note: 只有一個可用 target 時，primary 判定不受挑戰即成立。FAIL 已是終局，不再複查。

## REVIEW-CONTRACT-001

違反回覆約定的回應 MUST 回報為 NOT_RUN，而非 FAIL。

- Trigger: 審查者遺漏、重複或憑空新增 criterion，或給出空白 evidence。
- Action: 以 reason `unparseable-output` 回報 `NOT_RUN`，不寫入任何 evidence，並保留 FAIL 表示「經審查判定不合格」。
- Evidence: 結果的 reason 能區分協議違規與判定結果。
- Positive: `NOT_RUN：unparseable-output；缺少一條 criterion。`
- Negative: `因為模型的 JSON 格式錯誤就記錄一次失敗的審查。`
