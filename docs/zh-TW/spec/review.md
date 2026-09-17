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

完整 review MUST 使用 configured independent-review target selection；review
指令 MUST NOT 接受單次 harness override。

- Trigger: 執行 `review`。
- Action: 解析設定的 targets，規劃恰好兩個全新 session。
- Evidence: argument parsing 拒絕 `--harness`；`init --review-target` 仍是設定入口。
- Positive: `review --task <id> --yes` 回報設定的 `plannedTargets`。
- Negative: `review --task <id> --yes --harness claude` 改變 reviewer 集合。

設定三個 target 時，`AGENT_OPS_HOST` MUST 指出目前 host；該 target 會被排除，
若可用則 agy 為 primary。設定兩個時依順序執行，即使其中一個是 host；設定一個
時，在全新 session 執行兩次。

## REVIEW-READONLY-001

review target MUST 以其自身的唯讀機制啟動；沒有唯讀機制的 target MUST 被跳過，而非在無沙箱狀態下執行。

- Trigger: 為已設定的 target 組建 review invocation。
- Action: 傳入 `-s read-only`（codex）、`--sandbox --mode plan`（agy）或 `--permission-mode plan`（claude）；agy 必須在一次性 repository clone 中執行；其餘 target 視為不合格。
- Evidence: spawn 出的 argv 含該 target 的唯讀旗標。
- Positive: `agy 使用 sandboxed plan mode；opencode 仍不合格。`
- Negative: `信任 prompt 能阻止審查者修改檔案。`

每次 review 都 MUST 使用全新 session（`sessionIsolation: "fresh"`）並在
disposable repository clone 中執行。同 target pair 仍因 session 與 clone 全新而
具獨立性。不得 resume 開發 session 作為獨立審查。

Capability 與模型啟動進度即使在 JSON 模式也寫到 stderr；reviewer 原始輸出仍
維持 bounded capture，不直接串流。SIGINT 或 SIGTERM 會中止 active process
tree，不 fallback、不寫 attestation；timeout 保留獨立 NOT_RUN reason，不得被
扁平化為 `missing-cli`。

## REVIEW-CHAIN-001

兩個規劃的 session MUST 依序為必要 reviewer 與 adversarial 複審。第一個
session 遇到 FAIL 或 NOT_RUN MUST 立即停止；不會在該結果後 fallback。

- Trigger: 第一個 target 不存在、未登入、不可用或回傳 malformed report。
- Action: 回傳含第一個 attempt 診斷的 NOT_RUN，不啟動第二個 session。
- Evidence: `attempts` 有第一個 diagnostic 且沒有第二個 attempt。
- Positive: `primary NOT_RUN` 是終局 NOT_RUN。
- Negative: `必要 reviewer 沒跑成後仍啟動第二個 target`。

## REVIEW-ADVERSARIAL-001

PASS MUST 交給第二個規劃的 target 嘗試反駁，且反駁成立時 MUST 使整體判定為 FAIL。

- Trigger: primary target 回報 PASS。
- Action: 將前一份 report 以不可信資料交給該 target 並要求它反駁；反駁成立即回報 FAIL，且無論結果都記錄為 `adversarial`。
- Evidence: `adversarial` 記載挑戰者與是否反駁成立；未能產出 report 的挑戰者則記錄在 attempt 清單。
- Positive: `codex 判 PASS，claude 找到 blocking 缺陷，整體判定 FAIL。`
- Negative: `為了讓複查看起來有效而編造反駁。`
- Note: 只有一個設定 target 時，會在全新 session 再呼叫同一 target。FAIL 已是終局，不再複查。

## REVIEW-HOST-001

Host 缺少 network 或 loopback 能力時，MUST 在任何 reviewer invocation 前
fail closed。

- Trigger: host 宣告 network disabled 或 loopback probe 失敗。
- Action: 回傳 `REVIEW_NOT_RUN / host-required` 與 host restriction。
- Evidence: `attempts` 為空，沒有 target preflight 或 reviewer process 執行。
- Positive: 可信任的外部 host runner 在任何 reviewer invocation 前，以兩項能力啟動同一指令一次。
- Negative: 把 child login error 當作 authenticated reviewer 不可用的證明。

Managed host 規則要求在第一次呼叫前完成這個 handoff。repository 不提供
permission bypass。外部 host runner 不可用時，結果 MUST 保持 NOT_RUN，不得
製造 PASS。

## REVIEW-EVIDENCE-001

完整 PASS MUST 在寫入 attestation 前具備 primary report、adversarial report、
兩個帶 fresh session ID 的 PASS attempt、穩定 source fingerprint，以及私密且
有大小上限的 report artifact。artifact 或 attestation 寫入失敗 MUST 回傳 NOT_RUN。

- Trigger: reviewer chain 得到 PASS verdict。
- Action: 寫入 attestation 前驗證兩份 report、兩個 fresh attempt、source
  fingerprint 與私密且有大小上限的 artifact。
- Evidence: attestation 與 artifact 的 task、host、targets、session IDs、report
  digests 及 source fingerprint 完全一致。
- Positive: 完整 pair 寫入 artifact 與相符的 PASS attestation。
- Negative: 不完整 PASS 或 evidence 寫入失敗會降為 NOT_RUN。

## REVIEW-CONTRACT-001

違反回覆約定的回應 MUST 回報為 NOT_RUN，而非 FAIL。

- Trigger: 審查者遺漏、重複或憑空新增 criterion，或給出空白 evidence。
- Action: 以 reason `unparseable-output` 回報 `NOT_RUN`，不寫入任何 evidence，並保留 FAIL 表示「經審查判定不合格」。
- Evidence: 結果的 reason 能區分協議違規與判定結果。
- Positive: `NOT_RUN：unparseable-output；缺少一條 criterion。`
- Negative: `因為模型的 JSON 格式錯誤就記錄一次失敗的審查。`
