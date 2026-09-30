# 審查

English source version: 2026-09-30. Revalidate: when the English specification changes.

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

## REVIEW-BATCH-001

批次審查 MUST 只涵蓋指定 parent 的 active 子 task 以及 parent 本身。

- Trigger: 執行 `batch --parent <task-id>`。
- Action: 依建立順序選出 parent 的 active 子 task，再加上 parent。排除 archived、已完成的 task 與屬於其他 parent 的 task。未知 parent 以 `BATCH_PARENT_NOT_FOUND` 拒絕，非 active 的以 `BATCH_PARENT_NOT_ACTIVE` 拒絕。
- Evidence: `data.tasks` 依序列出的正是這些 task id。
- Positive: `兩個 active 子 task 與 parent 被涵蓋；archived 的子 task 不在內。`
- Negative: `不論 parent 為何，涵蓋 worktree 內所有 task。`

## REVIEW-BATCH-002

每個 task 的 base MUST 依序取自明確旗標、該 task 已記錄的 review base、worktree base。

- Trigger: 決定批次中某個 task 驗證與審查所用的範圍。
- Action: 子 task 用 `--base`，parent 用 `--parent-base`；否則用該 task 已記錄的 `reviewBase`；再否則用 worktree base。都沒有時回報 `BATCH_BASE_UNKNOWN`。
- Evidence: `data.tasks[].base` 指出每個 task 使用的 base。
- Positive: `重跑時沿用每個已 PASS task 記錄的 base，fingerprint 與 attestation 仍然吻合。`
- Negative: `把 --base 套到 parent，或在不知道 base 時退回 HEAD。`

## REVIEW-BATCH-003

驗證 MUST 一次只跑一個 task，每個 task 的審查 MUST 在它自己的驗證通過後立刻開始，同時進行的審查 MUST NOT 超過 `--width`（預設 2）。

- Trigger: 批次中的 task 需要驗證與審查。
- Action: 已有 fresh PASS evidence 的 task 略過驗證，判斷方式與 review 預檢相同。其餘串行驗證。task 驗證通過後立刻開始它的審查。驗證失敗的 task 不開審查，其他 task 繼續。
- Evidence: `data.tasks[].verify` 為 `skipped`、`PASS` 或 `FAIL`，驗證失敗的 task 沒有 review。
- Positive: `task A 審查的同時驗證 task B。`
- Negative: `同時跑每個 task 的完整測試。`

## REVIEW-BATCH-004

暫時性的 NOT_RUN MUST 讓其餘審查的 width 降為 1 並只重試一次，其他結果 MUST 為最終結果。

- Trigger: 批次中的某個審查回傳 NOT_RUN。
- Action: 原因為 `probe-failed`、`stalled`、`timeout`、`quota-exhausted` 或 `network-unreachable` 時，讓所有尚未開始的審查 width 降為 1，並在其餘審查結束後，單獨重試該 task 一次。其他原因不重試，不重試第二次，width 也不再升回。
- Evidence: 被重試的 task `review.retried` 為 true，第二次暫時性 NOT_RUN 仍是 NOT_RUN。
- Positive: `task A 的 probe-failed 使 width 降為 1，A 在其他 task 之後再跑一次。`
- Negative: `對 host-sandboxed 不斷重試直到通過。`

## REVIEW-BATCH-005

來源變動或程序被中斷時，批次 MUST 停止。

- Trigger: HEAD 或工作樹與批次開始時不同，或程序收到 SIGINT 或 SIGTERM。
- Action: 開始前要求工作樹乾淨，每個步驟前檢查 HEAD 與工作樹。發現變動時，中止進行中的審查，不再開始新步驟，並把每個未完成的 task 回報為 `aborted`。訊號以 130 或 143 結束。
- Evidence: 每個未完成的 task 其 `data.tasks[].aborted` 為 true。
- Positive: `批次進行中發生 commit 就中止，未完成的 task 標示 aborted。`
- Negative: `讓進行中的審查對已不吻合的 HEAD 跑完。`

## REVIEW-BATCH-006

批次 MUST 在探測成功時對每個審查 target 最多探測一次，且 MUST NOT 快取失敗的探測。

- Trigger: 批次中的審查需要 target 預檢。
- Action: 同時進行的審查共用進行中的探測，成功的答案在批次剩餘期間保留。失敗的答案丟棄，讓 task 的重試再探測一次。
- Evidence: 多個審查的批次每個 target 只探測一次，失敗後的重試會產生新的探測。
- Positive: `五個審查共用一次成功的 agy 探測。`
- Negative: `快取 probe-failed 並拒絕其餘所有 task。`

## REVIEW-BATCH-007

批次結果 MUST 回報每個 task 的結果，且 MUST 僅在每個 task 都通過時以 0 結束。

- Trigger: 批次結束。
- Action: 回傳 `BATCH_RESULT`、`BATCH_FAILED` 或 `BATCH_NOT_RUN`，`data.tasks[]` 含每個 task 的 id、base、驗證狀態、審查狀態與原因、`reused`、`retried` 與 `aborted`，不含完整報告（報告留在 `.agent-ops/reviews/`）。全數通過以 0 結束，任一審查或驗證失敗以 1 結束，其餘以 2 結束。`batch` 的啟動方式與 `review` 相同：需要 `--yes` 與 trust，且適用 REVIEW-HOST-001。
- Evidence: envelope code 與 exit code 與各 task 的結果一致。
- Positive: `一個 FAIL 與一個 NOT_RUN 以 1 結束，先處理缺陷。`
- Negative: `仍有 task 是 NOT_RUN 卻以 0 結束。`
