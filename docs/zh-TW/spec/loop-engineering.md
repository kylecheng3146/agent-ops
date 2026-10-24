# 迴圈工程

## LOOP-RUN-001

`run` MUST 保留原始使用者目標，並要求目前有效的 agent-ops 證據。

- Trigger: 啟動、修復或恢復 native goal run。
- Action: writer 綁定目前 lease，並要求最終 verify、雙 review 與 receipt 證據。
- Evidence: run ledger 與封存 receipt 綁定目前 candidate 及原始目標。
- Positive: 恢復未完成清理時，保留 target 與已保存的 final proof。
- Negative: 只因 native goal completion 就把 run 標為 complete。

- macOS supervisor 在啟動 goal 前保存 Claude／Codex native 身份。同 host writers 使用獨立 worktrees 與目前 generation lease；coordinator 計入最多兩個 writer。依賴以固定交付提供，child baseline 在依賴 commits 進入 checkout 後建立。
- 新 run 不設總時間上限（`budget.limitMs: null`），仍以 active intervals 聯集記錄 setup、verify、review、整合的消耗。舊有限 run 僅在下次人工 resume 升級，保留舊上限、intervals、消耗、usage epochs 與 blocker 歷史；讀取或安裝不會升級或喚醒舊 run。單次命令／review timeout、provider quota、無進度與 pause/stop 控制保持獨立有效。明確指定 --time-budget 會被拒絕。缺少計數維持 UNKNOWN，partial usage 不算完整成本。
- 實質疑問暫停並要求明確回答。修復保留目標與失敗紀錄；連續兩次相同失敗且無進展停止該 worker 及其依賴，獨立 task 仍可執行。review findings 在下次 final gate 前必須有回歸 pin 或記錄 review-only fallback。
- native completion 僅是觀察。完成必須有必要驗證、兩輪 fresh review、完成的 task state、綁定 target 的 receipt。整合在移動 target 前封存 candidate，記錄 task、receipt、note、cleanup 進度；恢復驗證封存證據，不重做成功的 target mutation。不一致的 target 維持 blocked。
- Stop 先保存禁止續跑，再確認受管 process group 死亡。crash recovery 不得取代仍存活或身份不明的 writer。dirty checkout、版本漂移、restart storm 保留現場。重開機／login 改變必須明確 resume；不修改全域 host policy。
- Native handshake 前先保存啟動程序身份；尚未開啟的 Codex session 必須證明程序死亡，才可在新 lease 重新初始化。

- Setup 與 native agent 發起的 local proof MUST 先登記 dormant process group 再執行；Stop 也要取消子程序。中斷的 setup 必須明確 resume，保留 checkout 與失敗 artifact。
- Coordinator 只能在綁定原始 repository trust、可執行 runtime、一小時有限授權期限的 run-scoped policy 下，評估新增固定且非危險的能力。不得繞過 native 或組織的明確拒絕。Policy 變更先停止所有 writer，保留固定交付，以 journal 記錄 contract 同步，再啟動新 generation；不授予永久 repository trust。Native decision 保存遮罩後的命令範圍與理由，provider 未提供的證據維持 UNKNOWN。
- 執行中的 run 僅在原始 repository trust、config、可執行 runtime 與操作範圍完全相同時，自動續期過期的有限授權。續期以 digest 綁定前一版本並保留既有評估，拒絕無效／倒退時鐘；並行 stop、denial 或 scope 變更使續期失敗。權限已變更或撤銷時須沿既有 trust/resume 流程取得真正授權；續期不授予永久 trust，也不消除 denial。明確 resume 先核對不可變 renewal lineage，再同步 policy。回答問題也沿用相同恢復檢查；兩者皆不得復活已被明確拒絕的工作。
- `run resume <id> --retry-approval <auth-event-id>` MAY 明確重試以額度不足 wrapper 失敗的 Codex 自動審批。每筆指定失敗 MUST 保有原始 private artifact、digest、worker identity 與 policy lineage；真正或未指定的拒絕仍阻擋。多筆失敗可重複旗標。成功確認會留存並在後續 resume 重新驗證；此操作不授予命令權限，原生審批必須重跑，既有 writer 死亡、checkout、trust 與預算檢查仍適用。
- `run resume <id> --retry-delivery <task-id>` MAY 在修復 harness 原因後，明確重新排程一個被 `RUN_FINAL_PROOF_INTERRUPTED` 阻擋的 child。MUST 核對同一筆中斷 handoff、所有 writer 與 proof 已確認停止、所屬 checkout 乾淨及目前 trust/policy；保留 run、task、goal、baselines、commits、耗用與失敗歷史，記錄已確認的 attempt，並要求新 native generation 及正常交付驗證。MUST NOT 直接標記交付、解除其他阻擋或確認命令拒絕；approval retry 是獨立操作。一般 resume 保留 no-progress 阻擋。受控 proof 中斷 MUST 記錄有界且已遮蔽的 exit/signal、失敗階段與子程序診斷；無效輸出或非零退出的成功 envelope 不得視為證據。
- 當次人工 resume 的初始恢復 MAY 忽略啟用前收到、且 native 更新秒數嚴格早於該次 resume 的本執行緒 Codex 額度快照。自動重啟、未知／同秒／未來時間、時鐘倒退，以及啟用開始後收到的所有額度事件仍有效。Native 啟用 MUST 確認 goal 為 active，才能啟動或轉向 turn。人工 resume 可解除衍生的 `RUN_POLICY_DISABLED` task 阻擋，但保留 ID、耗用、歷史及其他產品失敗。
- 收斂判斷比較實際 per-check 狀態及未解除的 finding pins；source fingerprint、時間或診斷文字本身不能算進展。

不論 `jobs` 為何，coordinator MUST 只在規劃完 child 後送出明確的 `action=wait`
request 才讓出；supervisor 不會停止仍在規劃的 coordinator。wait 會確認 coordinator
程序死亡、釋出其 slot 並捨棄其 native thread，使 coordinator 在 child 工作期間
不再輪詢 `run status`。恢復流程讓等待中的 coordinator 保持停止；所有 child 皆為
delivered、complete 或 blocked 後，才以新 generation 在全新 native session 中接續，
instructions 會列出每個 child 的狀態與交付 commit。`jobs=1` 時，child MUST 等該
程序確認死亡後才執行。native 註冊、恢復與啟動 MUST 都限制最多 `jobs` 個 active
agent；僅扣除 task slot 不足以符合。

明確回答 pending run 問題後，MAY 在 child 全部完成前解除已確認停止的 coordinator
wait。回答只消耗此 run 當前 generation 的等待，記錄 `RUN_COORDINATOR_RESPONSE_WAKE`，
本身不啟動程序。正常 resume 仍須核對程序死亡、trust 與 policy，再於 job 限制內
發出新 generation。一般 resume 或重播舊回答不得解除新的 wait。child 交付、失敗
歷史與 policy binding 保持原樣；回答本身不授予額外 command capability。

已知限制：內層 verification command 逾時可能終止共用的 proof 程序群組，使 evidence
CLI 來不及輸出 JSON。本次 response 恢復沒有修復此程序隔離缺陷；可由既有
coordinator policy 流程評估有界、僅限該 run 的 command timeout，並保留失敗紀錄。

English source version: 2026-07-23. Revalidate: when the English specification changes.

## LOOP-START-001

操作者 MUST 先盤點變更影響的 surface，再於編輯前列出驗收條件，並在每項條件都有證據時停止。

- Trigger: 開始多步驟實作或除錯迴圈。
- Action: 記錄 surface audit（[EVIDENCE-SURFACE-001](acceptance-and-evidence.md#evidence-surface-001)），再記錄 2–5 個可觀察條件，只檢查已盤點範圍內、目前步驟所需的檔案。
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
