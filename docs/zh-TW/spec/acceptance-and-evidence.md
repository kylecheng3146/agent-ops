# 驗收與證據

## EVIDENCE-CONTRACT-001

可執行驗收 MUST 將目前契約綁定到不可變的 replay 證據。

- Trigger: 驗證或完成 typed 驗收契約。
- Action: 在固定 baseline 與目前 candidate replay 授權 checks，再取得 fresh review。
- Evidence: 綁定摘要的 phase results 與目前 coverage 進入兩輪 reviewer packet。
- Positive: baseline 斷言 FAIL、candidate PASS 證明 behavioral check。
- Negative: 把 fixture error 算 red，或用舊 review 證明修訂後 criteria。

- `behavioral`：指定 red checks 在 baseline 都因斷言失敗，candidate 的必要 checks 全部通過。`invariant`：candidate 的必要 checks 通過，baseline 原本 PASS 有效。`review-only`：兩輪 fresh review 對照原始目標驗收，不宣稱機械證明。
- repo 授權的 `verification.acceptanceRunners` 定義 argv、setup、產品與 test build。task 提供穩定 check IDs 與明列且已 commit 的 test／fixture／helper；兩側各自安裝並 build 其版本，再覆蓋 candidate 材料。task 不能改 runner 命令。
- generic runner 輸出的 check IDs 必須恰好等於共用相同 runner、baseline 與材料之 criteria 所要求的 `checkIds` 聯集；多出的列為 UNKNOWN。若 runner 固定輸出整套 checks，就綁定完整輸出集合，並將 `redCheckIds` 限於實際回歸斷言。
- fixture、collection、build、timeout、取消、輸出截斷、缺少或重複 ID、retry、skip MUST NOT 算 red 或 green。完整 execution artifacts 以摘要綁定契約、材料與 commits。
- 原生 Jest JSON 與 Vitest task errors 無法完整區分 test-call 斷言與 hook／fixture cleanup。除非已 review 的 repo collector 提供明確斷言分類，失敗列 MUST 保持 UNKNOWN；AssertionError 名稱、matcher 資料與 pass 的 hook 狀態都不足。green 需要明確的單次 attempt 證據：attempts、Jest invocations，或 Vitest retryCount 與 repeatCount 兩者。原生 Vitest JSON 省略這些 counters，不能單獨提供機械證明。pytest 每個 nodeid 必須有一組依序的 setup／call／teardown；Rust protocol 必須提供 attempts。缺 metadata MUST NOT 預設為一次成功。
- baseline 固定為建立 commit；finding pin 使用被 FAIL 的 candidate。revise／replan 保留原始目標、全部映射要求與先前契約／證據。新契約必須重新取證並取得兩輪 fresh review。
- `task pin-finding` 驗證已保存 report 的 digest／index 來源。recurrence 明確引用既有 pin。第六條回傳 replan 義務且不修改狀態；映射後必須保留 pin 與全部要求。
- reviewer packet 包含原始目標、修訂歷史、coverage 與 verifier 材料，審查斷言本身與明確的 fallback 理由。機械 green 不會省略必要 policy commands 或任一 fresh review。

task state 寫入 version 2、讀取 version 1；evidence version 4 讀取舊證據，attestation version 3 綁定契約與 coverage。legacy criteria 維持下列 verifier 規則；typed／revised 契約不能沿用舊 review。coverage 分列機械證明、review-only、legacy；runner 綁定本身不算證明。明確 no-change proof 列出固定 candidate 上已 commit 的 regular source files；整合時重新解析支持路徑。一般 empty-diff review 與 empty-branch direct finish 仍拒絕。

English source version: 2026-10-20. Revalidate: when the English specification changes.

## EVIDENCE-CRITERION-001

每項驗收條件 MUST 對應可觀察的證據。

- Trigger: 定義或審查任務完成度。
- Action: 為每項條件命名命令、讀回內容或產物。
- Evidence: 最終報告為每項條件提供一個證據參照。
- Positive: `tests → npm test（354 個測試通過）`。
- Negative: `看起來正確，所以不需要證據。`

## EVIDENCE-INTENT-001

每個子 worktree MUST 在編輯前記錄完整程式修改意圖。

- Trigger: 子 agent 即將在自己的 worktree 編輯。
- Action: 使用 `task create --intent <text>` 記錄使用者同意的行為、限制與整合點；協調者連同子 task 匯入意圖，並在整合候選版本重跑驗證。
- Evidence: 子 task 與最終完成紀錄保留意圖，最終 verifier 證據綁定整合候選版本。
- Positive: `子 agent 先記錄預定 API 修改、提交程式碼，最後完成紀錄包含該意圖與整合後驗證。`
- Negative: `先修改程式碼，交付時才補寫一行事後意圖。`

## EVIDENCE-SURFACE-001

每個新 task MUST 在寫驗收條件前記錄變更還會影響哪些位置（surface audit）；discovery 找到未分類位置時，review MUST NOT 執行。

- Trigger: 建立 task（`task create`，含 `--debug`，或 run plan）、修訂 surface，或審查 task。
- Action: 以記錄下來的固定字串查詢或 `n/a: 理由` 搜尋四個軸向，把每個命中分類為 included、excluded（glob + 理由）或 UNKNOWN，每列 surface 都寫出可觀察的 `behavior`，並宣告每個共享契約為 compatible 或 breaking。以 `task create|revise --surface-file <json>` 提交。
- Evidence: surface 存在 task 上、綁進 contract hash 並保留修訂歷史，review 前以 `git grep -F` 重放，並以 `surface-coverage` 條件交給兩位 reviewer。
- Positive: `diff token 命中三個複製貼上的同類頁面；review 前 audit 已把它們連同行為列入 included。`
- Negative: `以「out of scope」排除 src/**，或只列 diff 已修改的檔案。`

- 軸向：`dependents`（import、呼叫者、讀取者）、`duplicates`（複製的 markup、
  字串或不 import 任何東西的邏輯）、`otherPaths`（同一概念的其他路由、模式、
  入口或重新進入點）、`sharedState`（storage、cache、訊息、外部 API、client
  storage、已發出的 URL）。設計與技術棧無關：相同軸向涵蓋前端、後端、資料庫、
  cache 與訊息流。
- `included` 列含 `id`、`path` glob 與 `behavior`；`excluded` 列含 `glob` 與說明
  該 surface 為何不受影響的理由（「out of scope」不是理由）；`unknown` 列記錄
  repository 看不到的讀取者。`contracts` 宣告 `compatible` 或 `breaking`。只有單一
  surface 也可以。
- 值的語意改變（clear、redact、default、normalize、unit/format）時，
  `valueChanges` `[{producer, kind, change, consumers, indirectConsumers}]` 列出兩層
  consumer。
- `scenarios` 涵蓋五個通用維度：`initialState`（空 vs 既有）、`redo`（重新載入、
  重試、重送、冪等）、`timeBoundary`（日界、TTL、時區）、`identitySwitch`（門市、
  角色、租戶）與 `concurrency`，每項為 `{applies: true, behavior}` 或 `{na: 理由}`。
- 父 task 持有 surface；子 task 宣告 `{"covers": [surface-id]}`，聯集必須等於父
  task 的 included 清單。
- 任何 reviewer 執行前，discovery 以 argv 執行 `git grep -F`（絕不經過 shell，也
  不以 task 文字組 regex），由便宜的來源先跑：記錄的查詢；diff hunk header 的外層
  函式名；template literal 固定片段（至少 4 字元且以分隔符界定，例如 `order:`、
  `user_`、`menu.`）；新增與刪除行的複合識別字（snake_case、camelCase 或含數字，
  因此一般文字單字不會成為查詢）與字串常值（至少 6 字元；命中超過 10 個檔案〈含
  變更檔案〉視為太通用而略過）。diff 與 surface 清單之外的任何命中都會擋下 review。
- 衍生查詢（diff 字詞、template 片段或 hunk header 函式名）的命中若只是巧合，可在
  surface 選用的 `dismissed` 清單中以一筆 `{query, reason}` 排除（理由至多 256
  字元，「out of scope」不是理由），不必逐檔排除。記錄的軸查詢與 escape rule 命中
  不能排除；diff 以外命中少於 4 個檔案的查詢（最可能是兄弟頁面線索）也不能排除；
  至多 128 筆。Reviewer 會看到每筆排除與其命中數，若它隱藏了先前
  `SURFACE_UNCLASSIFIED` 阻擋所列的檔案則會標示出來。
  結果以 HEAD、base、diff、查詢集合與 config hash 快取。
- Review 以 NOT_RUN 回報：`SURFACE_MISSING`（沒有或無法解析的 surface；
  task 建立時也會拒絕）、`SURFACE_UNCLASSIFIED`、`SURFACE_QUERY_TOO_BROAD`（單一
  記錄查詢超過 200 個檔案）、`SURFACE_EXCLUSION_TOO_BROAD`（單一 glob 超過 10 個
  檔案，或包含 diff 內的檔案）、`SURFACE_DISMISSAL_TOO_BROAD`（超過 128 筆排除）、
  `SURFACE_DISMISSAL_INVALID`（記錄的查詢或稀有查詢）、`SCENARIO_MISSING`、`SURFACE_BUDGET_EXCEEDED`
  （總計 120 秒，絕不默默略過）或 `SURFACE_UNASSIGNED`（子 task covers 與父 task
  included 不一致；每次 review 都檢查，包含 advance 與 batch）。
- 修訂 surface 等同修訂 contract：需要新的證據與兩次新的 review。在
  `SURFACE_UNCLASSIFIED` 阻擋之後才加入的排除，會以 post-block exclusion 標示給
  reviewer。
- 本規則上線前建立的 task 不受影響。每個 discovery 來源的 local-log 指標僅供參考、
  fail-open，絕不作為證據。
- 一般 `worktree finish` 也會寫入與 advance 相同的本機 receipt，包含兩輪的 residual
  risks 與 non-blocking findings，在 git note 引用它並印出 residual risks。

## EVIDENCE-ESCAPE-001

bug 修復在已知來源時 SHOULD 宣告 bug 的來源；宣告的逃逸 MUST 以機械方式連結、標記並記錄。此宣告屬建議性質（advisory），絕不阻擋 finish。

- Trigger: DEBUG task（`task create --debug`）或任何 task 修復一個通過了先前關卡的 bug，且已知其來源。
- Action: 以 `task create|revise --escape-of <commit> --escape-label <label> [--escape-receipt <id>]` 宣告 `origin`，DEBUG 與一般 task 相同。0.10 `task debug` 記錄的 `pre-existing` 與 `external` origin（附 `reason`）仍可讀取；未宣告的 origin 另行計數。把 `.agent-ops-escapes/<task-id>.json` 記錄與修復一起 commit。
- Evidence: `origin` 綁進 task contract hash；兩位 reviewer 在 `escape-label` 條件下收到連結狀態、標記、事實與 residual risks。沒有 origin 的 task 仍可 finish；0.10 標記 `originRequired` 的 task 不再被拒絕（`ESCAPE_ORIGIN_MISSING` 已於 0.11.0 移除）。
- Positive: `回歸在 baseline 為紅、修復後為綠；origin escape-of 864dbbe2 label surface；重放把漏掉的頁面標為 surface-unseen；記錄與修復一起 commit。`
- Negative: `把 surface-excluded 的漏網改標成 review，理由是 reviewer「應該注意到」。`

- 宣告是一次 contract revision：重新 verify，然後 review。重新宣告會取代記錄。輸出會列出修復所改或刪行的 `git blame` 提示 commit；blame 只是提示，因為遺漏
  型 bug 存在於沒人寫過的行。
- finish receipt 留在本機 Git common directory。Schema 2 記錄 target..candidate 的每個
  commit 與逐檔 diff fingerprint（去掉 blob id 與 hunk 位置，squash merge 後仍相同）；
  schema 1 receipt 仍可載入，但只以 exact head 連結。
- 連結狀態分開計數：`gated`（找到 receipt）、帶理由的 `unresolved`（Git note 或
  `--escape-receipt` 指向本機沒有的 receipt 時為 `receipt-not-local`，另有
  `ambiguous-receipt`、`link-unavailable`）與 `ungated`（沒有 receipt 也沒有 note）。
  解析順序：`--escape-receipt` 覆寫、commit 位於某 receipt 記錄的範圍內（schema 1：exact
  head）、逐檔 fingerprint 相符，最後才是 unresolved 或 ungated。
- 標記：單一主要標記，取最早能抓到此逃逸的關卡 —— `requirement`、`surface`、
  `scenario`、`criteria`、`verify`、`review` —— 或 `flagged`（residual risk 或 finding 已
  提過）或 `out-of-model`。由 agent 提議；以 `git grep -F` 在被連結 receipt 的 candidate
  上重放其記錄的 surface 查詢，把修復碰到的每個檔標為 included、excluded、hit、unseen 或
  absent，`surface-excluded` 或 `surface-unseen` 會覆寫任何較晚的標記。兩位 reviewer 裁決。
- ledger 受 git 追蹤且只含資料（commit、路徑、標記、理由、計數；絕不含檔案內容或對話紀錄），
  每個 task 一個檔案，平行 worktree 不會衝突。關卡攔截（`SURFACE_*` 與 `SCENARIO_MISSING`
  review 阻擋、review FAIL、verify 由紅轉綠）會附加僅含 code 與 task id 的參考性 local-log
  `gate-catch` 事件；記錄失敗時 fail-open，origin 要求則 fail-closed。
- 範圍 R1 只負責記錄。由逃逸學到的規則、重放證明、回測、`--escape-fix` 與
  `agent-ops escapes` 報表屬於 R2（[EVIDENCE-ESCAPE-002](#evidence-escape-002)）。

## EVIDENCE-ESCAPE-002

surface 逃逸 SHOULD 變成已證明、受追蹤的規則；學到的規則 MUST 只能收緊 surface gate。此證明屬建議性質，絕不阻擋 finish。

- Trigger: 已宣告的 escape-of origin（EVIDENCE-ESCAPE-001），或以 `task create --escape-of <commit> --escape-label <label> --escape-fix <fix-commit>` 回填的過去逃逸。
- Action: 標記為 `surface`、`surface-unseen` 或 `surface-excluded` 時，commit 一條規則 `.agent-ops-escapes/rules/<rule-id>.json`，形狀為 `{"id", "escape", "label", "trigger": {"paths", "tokens"}, "expand": {"paths", "queries"}, "noExclude"}`，並重新宣告 origin。`criteria` 或 `verify` 以 `--escape-promote <runnerId:checkId>`（origin 欄位 `"promote"`）指名修復 task 由紅轉綠的 check。其他標記記錄為 lesson。
- Evidence: 宣告 origin 時執行證明，失敗時印出 `ESCAPE_RULE_UNPROVEN`、`ESCAPE_RULE_TOO_BROAD` 或 `SURFACE_BUDGET_EXCEEDED`；自 0.11.0 起 finish 不再因此拒絕。ledger 記錄保存證明用規則、其內容 hash 與回測的 fires、commits 與比率。
- Positive: `逃逸 surface-unseen；規則 image-size-siblings 在被逃逸 commit 上觸發，其查詢在該 commit 命中兩個漏掉的兄弟頁面，且在最近 200 個 commit 中只觸發 2 次。`
- Negative: `規則從未在被逃逸 commit 上觸發卻把 surface 逃逸報為已證明，或新增可排除路徑的規則欄位。`

- 規則只含資料且不需要 trust：trigger 與 expand 變成 argv `git grep -F` 查詢與路徑
  glob，絕不經過 shell 或 regex。嚴格 schema 沒有任何能移除查詢、新增排除或放寬關卡的
  欄位。無效規則以 review NOT_RUN `ESCAPE_RULE_INVALID` fail-closed；symlink 或非一般
  檔案的規則目錄或檔案則為 `ESCAPE_RULE_UNSAFE`。
- Surface gate：只有 task diff 符合 trigger 路徑 glob，或某個變更行包含 trigger token
  時，規則才會觸發。已觸發規則的每個 expand 命中都必須位於 diff、included、UNKNOWN 或
  excluded，否則為 `SURFACE_UNCLASSIFIED`；有 `noExclude` 時，被排除的命中為
  `ESCAPE_RULE_NO_EXCLUDE`。每條規則的觸發與 included/excluded 計數寫入 local-log
  `escape-rule` 事件（fail-open）。
- 證明：規則必須指名被逃逸 commit、在該 commit 自身的 diff 上觸發，並在該 commit 重放時
  命中當時已存在的每個漏掉路徑。有 `--escape-fix` 時漏掉路徑取自 fix commit，否則取自
  task diff。`criteria`/`verify` 逃逸需要其 promoted check 是修復 task 某個已證明
  behavioral 條件的 `redCheckIds` 項目（baseline 紅、candidate 綠）；輸出會印出新增
  required verifier 的 config 提案，agent-ops 絕不寫入 `.agent-ops/config.json`。
  `scenario`、`review`、`requirement`、`flagged` 與 `out-of-model` 記錄帶理由的未證明
  lesson，不阻擋。絕不在被逃逸 commit 上執行 review 或測試。
- 回測：以一次 argv `git log` 把 trigger 比對最近 200 個 first-parent commit 的 diff；
  觸發比率超過 30% 為 `ESCAPE_RULE_TOO_BROAD`。回測有時間預算（超出為
  `SURFACE_BUDGET_EXCEEDED`，絕不默默通過），並以 HEAD 與規則 hash 快取。編輯證明用規則
  會讓 ledger 記錄過期，直到重新宣告。
- `agent-ops escapes [--json]` 是唯讀、fail-open 的報表：來自 ledger 的各標記漏網數、
  來自 local log 的 `gate-catch` code、origin 組成、帶 unresolved 理由的連結狀態組成，
  以及每條規則的觸發/included/excluded 計數與時間窗，皆為附 n 的原始計數，n < 10 時標為
  `insufficient-data`。至少觸發 10 次且從無 included 命中的規則列為退役候選；移除一律
  經過審查的 commit，絕不自動。
- R2 取代 phase-2 的 `surface.aliases` 設定（改為受追蹤規則）與 `surface stats`
  （改為 `agent-ops escapes`）。

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
- task、來源、criteria 與 config 不變時，重新驗證後可沿用原 PASS review。開始新的已授權 review（`--rerun`）才會撤銷該來源指紋先前的 attestation。若 reviewer 未能執行或未通過，完成前必須重新取得成功的全任務 review。
- 所有子任務與後代任務都必須已完成，且沒有尚未解決的失敗。封存未完成工作不算完成；已完成或封存的 parent 不能新增子任務。若放棄某個 subtask，請重建不含該取消分支的 parent task，並重新驗證與審查新的 task tree。
- 證據、來源與設定檢查在 task store 鎖外執行。再次確認來源與設定後，完成操作才短暫鎖住狀態，比對 task 快照（改變時回傳 `TASK_COMPLETION_STATE_CHANGED`）、重查後代任務並原子寫入。慢速檢查不會阻擋 task 讀取或其他修改；完成被拒絕時，併發修改仍會保留。

`test-count.minimum` 只計明確 passed 的測試，排除 skipped、todo、預期失敗與 discovery total。零 passed 即使 minimum 為零也會 FAIL；無法辨識 passed 摘要時為 UNKNOWN。摘要有 failed、error 或 cancelled，即使 process exit code 為零也會 FAIL。exit-code verifier 保留既有行為。任一 criterion 缺少 required verifier 時，task verify 回傳 `VERIFICATION_UNKNOWN`、列出缺少 coverage 的 criterion，且不執行 verifier 命令；只有 optional 結果不能建立正式 task 的驗證 PASS。

新 verification evidence 使用 schema 3。Schema 2 仍可讀取，其 exit-code 證據仍有效；schema 2 test-count 證據不能建立 PASS，必須重新驗證。舊參照會保留。Completed task 只可為原來源、criteria 與 config 追加 fresh verification，保留 completedAt 與 review 參照。追加與清除 failure 前，會原子比對完整狀態快照；併發修改保留並拒絕本次追加。Fresh FAIL 或 UNKNOWN 在修正前阻擋完成；archived task 不可修改。來源或 config 改變時必須建立新 task。

既有 task 檔案仍可直接讀取，不需資料格式遷移。缺少 config baseline、使用任意文字證據，或含有未完成但已封存子任務的舊任務，必須重建並完成驗證與審查。重複執行 complete 也會重新驗證證據；舊的 completed 狀態本身不夠。Runtime 呼叫端必須提供 `TaskServiceOptions.completion`；缺少此 repository context 時，complete 會拒絕執行，但仍可讀取任務。

Commit 前，verify、review、complete 使用預設 worktree scope。Commit 後，三個命令都使用相同的 `--base <git-ref>`，為已提交範圍重新產生證據；runtime 呼叫端使用 `TaskServiceOptions.completion.base`。Base 模式要求 worktree 乾淨。沒有 worktree 變更又未指定 base 時，complete 會回傳 `TASK_COMPLETION_SCOPE_REQUIRED`。agy Stop gate 仍檢查 worktree scope 的證據：請在 commit 前完成並停止，或由使用者檢查已完成的 base-scope 任務後，核准一次性的 Stop permit。

這項機制強制的是 toolkit 的完成命令，無法阻止 host 直接用自然語言宣稱完成，也無法阻止具有相同檔案權限的 process 直接改寫 task／evidence 檔案；它不會鎖住 Git 或其他來源檔案寫入者。

Project init/update 在所有 harness 與 profile 安裝 `.agent-ops/.gitignore`，忽略 `/tasks/` 與 `/reviews/`；若已有使用者自建的 `.agent-ops/.gitignore`，init/update 會回傳 `UNMANAGED_INSTALL_PATH`：先將原檔備份到其他位置，並將自訂規則移到根目錄 `.gitignore`（加上 `/.agent-ops/` 前綴），再重試。這些目錄若包含 index 中的檔案（即使 tracked 且未修改）或 staged 的 runtime 刪除，Git 範圍收集會回傳 `CHANGE_SURFACE_TRACKED_RUNTIME`。請先移出真正的程式來源、安裝 ignore 規則，再執行 `git rm -r --cached --ignore-unmatch -- .agent-ops/tasks/ .agent-ops/reviews/`，保留本機檔案並解除追蹤。若有 staged 刪除，先提交清理 commit，再重新產生 verify/review 證據。啟用的 completion Stop gate 也會以 `COMPLETION_GATE_TRACKED_RUNTIME` 阻擋此狀況並提供修復訊息。請從 Git repository 根目錄執行 verify/review；目前路徑與指紋收集不支援巢狀 project root。Uninstall 會移除 managed ignore 檔，但保留 runtime 輸出。
