# 獨立 QA

獨立 QA 在交付流程中加入一位分開的測試者：一個從未共用開發者對話的 agent，在實作前
規劃測試，針對整合後的候選版本撰寫自己的測試素材，再由 controller 執行。它封存的
PASS 是必要的交付 gate，與 verify 和兩輪全新審查並列，不取代其中任何一個。

## 範圍與啟用

- macOS 專案的 init/update **預設開啟（ON）** QA。明確指定 `--qa off` 會寫入
  `"qa": {"enabled": false}`，後續更新保留此選擇。用 `agent-ops update --qa on`
  （或 `agent-ops init --qa on`）重新開啟。確認前，預覽顯示 `Independent QA: enabled …`，
  config 變更由 init/update 原本的 trust 授權涵蓋。`--qa` 只用於專案範圍；
  `--scope user` 會拒絕。Linux／Windows 與使用者範圍安裝保留原本不啟用 QA 的預設。
- v1 **只支援 macOS**。已開啟 QA 的專案在 Linux 或 Windows 上會拒絕登記新 task，
  並以 `QA_UNSUPPORTED_PLATFORM` 阻擋任何已登記的交付；絕不會默默通過。
- 開啟只套用到**新的交付根 task**：`task create` 會把凍結的 QA 政策綁進 task 契約。
  子 task 保留各自的本地 verify；QA 測的是它們整合後的根 task。既有 task 在你明確
  採用（見下文）前維持原契約。已完成的交付永遠不會被重新判定。
- 之後關閉 QA，不會移除已登記 task 的 gate。
- 從未登記的 task 在 `task status`、`qa show` 與 Office 顯示「未加入（不需要）」
  （not enrolled）。這**不是 QA PASS**。

## 流程

1. **實作前規劃。** criteria advisory 之後，一個唯讀 planner 在獨立工作階段讀取
   repository snapshot，把 advisory 當作資料使用，記錄對應到驗收條件與 surface 的
   案例（依風險涵蓋正常、負面、邊界、重試／並行與復原），每個案例使用的已設定
   runner、必要環境，以及真正未決的問題。
2. **照常實作並 commit**；子 task 執行自己的本地 verify。
3. **測試整合後的候選版本。** 已登記的一般 task 執行 `agent-ops verify --task <id>`
   時會先跑 QA；`agent-ops qa run --task <id> --yes` 可單獨執行。一個全新、可寫入的
   Claude 或 Codex 工作階段，在確切已 commit 候選版本的**隔離 clone** 中工作，只能
   新增測試、fixture 或 helper 檔案；需要修改既有檔案的要求會退回給開發者。
   controller 驗證路徑、擁有權與版本後，匯入並 commit 素材（HEAD 會前進），再透過
   專案已設定且受信任的 acceptance runner 執行每個案例：行為型案例必須在 baseline
   因斷言失敗、在候選版本通過。非機械案例（例如文件內容正確性）屬於有理由的檢查，
   由兩位最終審查者確認，永遠不是執行證明。
4. **封存。** 只有 controller 能封存 PASS，並綁定候選 commit、source fingerprint、
   目標、task 與 tree 契約、範圍、config 與 QA 政策。任何後續變更都會讓它過期；
   候選版本不變時直接重用，不呼叫模型。
5. **交付。** `task complete`、Stop completion gate、`worktree finish`、
   `task advance`、run finalize 與 `run land` 都要求這份封存 PASS；兩位審查者在
   `qa-proof` 準則下檢查 QA 的有效性、涵蓋範圍、來源與 fallback 原因，finish 收據
   保存 QA 計畫、報告、執行紀錄、決定與 attestation 的封存副本。

planner 與 author 優先使用和實作者不同的已設定 host；也允許同一 host 的全新工作
階段，並記錄 fallback 原因。只有 Claude 與 Codex 能撰寫素材；agy 只維持唯讀審查。

## 指令

| 指令 | 作用 |
| --- | --- |
| `agent-ops qa plan --task <id> --yes` | 在獨立唯讀工作階段規劃或重新規劃。對尚未登記、仍在進行中的根 task 會**採用** QA（此後為必要），若實作已開始則標記為**晚**（late）規劃。 |
| `agent-ops qa run --task <id> --yes [--base <ref>]` | 在已 commit 的候選版本上撰寫、匯入、執行並封存；回報真實狀態。 |
| `agent-ops qa show --task <id> [--json]` | 從私有狀態讀取計畫、結果、問題、native 暫停與用量；不啟動任何模型、host 或 runner。 |
| `agent-ops qa respond --task <id> --question <id> --answer <text>` | 記錄一則真人對 QA 所提問題的回答。 |
| `agent-ops qa stop --task <id>` | 隔離並停止此 task 的一般 QA 寫入者；在明確執行 `qa plan` 或 `qa run` 前不會繼續。隔離 clone 會保留供診斷。 |

`task status`（及其 `--json` 的 `qa` 欄位）顯示 QA 階段、結果（PASS、STALE、PENDING
或 NOT_REQUIRED）、未解決的阻擋問題、待回答問題與阻擋原因，並與 verify 覆蓋率分開。
Office 在房間詳細資料與 QA 狀態看板上以「獨立 QA」顯示同樣內容，和「驗證」分開。
閒置、停止或已結束的 QA 檢視會在一般的兩小時視窗後從 Office 退場；私有紀錄保留。

## 修復、問題與控制

- **`QA_REPAIR_REQUIRED`**：QA 找到可重現的範圍內失敗。QA 不寫產品程式碼。請修正
  產品，用 `agent-ops task pin-finding <task-id> qa:<digest>:<index> --expected-contract
  <hash> --criterion-file <json>` 釘住每個列出的 finding，commit 後再執行
  `verify --task`（或 `qa run`）。釘選保留確切的重現步驟；結案需要同一案例先紅後綠。
  非阻擋或無關的既有問題，會帶著 QA 來源進入 `agent-ops followup`。
- **`QA_AWAITING_INPUT`**：QA 需要產品決定。agent 只轉述問題；只有真人能用
  `qa respond` 回答。agent 絕不能自行編寫答案，回答也永遠不能豁免失敗或缺少的
  機械證據。
- **受阻**：缺少必要環境（`environment:<name>`）、native 拒絕或 provider 限制，或
  同一語意失敗連續兩輪沒有進展。請修正原因；QA 不會安裝工具，也不會更改 trust 或設定。
- **絕不**為了讓 QA 通過而修改、弱化或刪除 QA 素材、斷言或需求。

## Native run

在 `agent-ops run` 中由 supervisor 擁有 QA：根 task 在 advisory 之後取得計畫，
finalize 或 land 會在整合後的候選版本執行 QA。`qa plan`、`qa run` 與 `qa stop`
會以 `QA_NATIVE_OWNED` 拒絕並指出該 run；`agent-ops run stop <run-id>` 也會停止它的
QA 寫入者。run agent 以 `action=question` 轉述 QA 問題；真人用 `qa respond` 回答，
再用 `run respond` 讓 run 繼續。部分 `run land` 只證明實際落地的 task 與其相依，
永遠不代表整個目標完成。

## 費用與用量

QA 沒有總時間或總輪數上限（no total cap）；只要有進展就會繼續，既有的停止控制、
provider 限制與指令期限仍然有效。規劃與撰寫是真實的 Claude/Codex 工作階段，會消耗
provider 額度與費用。用量只記錄 host 回報的數字；未回報的一律是 `UNKNOWN`，不估算。
`qa show` 與 `task status` 不花費任何額度。

## 相容性

既有原始 config 沒有此欄位時，仍關閉直到 managed init/update 設定支援的平台預設。
明確 OFF 保持新 task 不登記；既有與已完成 task 的契約、證明及 hash 不會回溯改動。QA 資料是附加的：
config 的 `qa` 欄位、task 的 `qa` 綁定、QA finding 釘選，以及收據中的 QA 證明。
舊版 CLI（1.3.x 及更早）可能拒絕這些資料；有已登記 task 的專案請勿降版。私有 QA
狀態存放在 Git common directory（`agent-ops/qa/`），經過遮蔽，且不進入 source
fingerprint。

## 測試收集與續跑

Runner 必須能收集新撰寫的素材。本 source repo 提供 `node tests/qa/acceptance.mjs`，
讀取 `tests/qa/independent/**/*.check.mjs` 匯出的 `checks` 物件（穩定 ID 對應斷言函式）。
在此開啟 QA 前，以正常 config／trust 預覽設定 generic acceptance runner。缺少 check、
重複 ID、import 失敗與符號連結都不會通過。

重新規劃會取得有上限的歷史 controller 結果與真人回答，附原版本與參照，僅作不可信資料。
歷史回答不會回答新計畫，也不是目前證明。被拒的 planner 輸出經遮罩後保留在私有
`planning-diagnostics/`；舊計畫與失敗紀錄不會被清除。
