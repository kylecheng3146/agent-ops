# Harness Adapter

English source version: 2026-10-07. Revalidate: when the English specification or any vendor reference changes.

本文件所述 OpenCode plugin 行為已於 2026-07-31 依據[官方 plugin 文件](https://opencode.ai/docs/plugins/)與[Bun shell 文件](https://bun.sh/docs/runtime/shell)檢查；Codex 與 Claude Code loop-hook 行為已於 2026-08-03 依據 [Codex hook 文件](https://developers.openai.com/codex/config-advanced#hooks) 與 [Claude Code hook 文件](https://code.claude.com/docs/en/hooks) 檢查；agy hook 行為已於 2026-08-28 依據[官方 Antigravity hook 文件](https://antigravity.google/docs/hooks) 檢查。任何 vendor 參考變更時都必須重新驗證。

## HARNESS-ADAPTER-001

Adapter MUST 保留原生 harness 語意，並為每項 capability 宣告
supported、degraded、unsupported 或 unknown。

- Trigger: 將可攜 lifecycle 或 review 行為映射到原生 harness。
- Action: 保持 ownership 狹窄、保留使用者設定並記錄限制。
- Evidence: adapter 測試涵蓋既有設定、support 宣告與原生 failure 行為。
- Positive: `Codex blocking outcome 未確認原生 denial 時保持 UNKNOWN。`
- Negative: `假設 Claude exit semantics 適用 Codex。`

## HARNESS-ADAPTER-002

Adapter MUST 具備冪等性，且 MUST NOT 刪除使用者擁有的 handler。

- Trigger: 安裝、更新或移除 managed harness 設定。
- Action: 只變更穩定 managed marker 或 owned handler。
- Evidence: 既有設定 fixture 在 apply 與 uninstall 後保持完整。
- Positive: `更新 managed handler，無關 handler 仍逐位元存在。`
- Negative: `以 toolkit defaults 取代整份 settings。`

## HARNESS-ADAPTER-003

檔案型 adapter MUST 只註冊 active capabilities 所暗示的 hook，且 MUST 將產生的 source 當成一個 whole-file artifact 管理。

- Trigger: 安裝或探測 extension point 是 plugin 檔案的 harness。
- Action: 對 opencode 在 project 管理 `.opencode/plugins/agent-ops.js`、在 user scope 預設管理 `.config/opencode/plugins/agent-ops.js`（若 `$XDG_CONFIG_HOME` 指向 managed user root 內的目錄，則使用其下的 `opencode/plugins/agent-ops.js`；若設定原生 `$OPENCODE_CONFIG_DIR`，則使用其下的 `plugins/agent-ops.js`），不修改 `opencode.json`；project `AGENTS.md` 的 contribution 依 path 去重。
- Evidence: manifest 含 plugin hash，產生的 source 只含選定的 hook，shared project marker 只出現一次。
- Positive: `codex,opencode` 產生一個 project AGENTS route 與一個有 hash 的 opencode plugin。
- Negative: `新增 opencode.json instructions entry，或在只有 core profile 時註冊 plugin。`

## HARNESS-ADAPTER-004

OpenCode shim MUST 從選定的 project directory 呼叫 absolute runtime path；runtime 不可用時，MUST 對 advisory event fail open，並 MUST throw 文件化的 command-policy error。

- Trigger: 產生的 plugin 呼叫 `agent-ops`，或收到無效的 runtime decision。
- Action: 將 normalization 與 native output encoding 留在 runtime adapter；deny
  decision 要 throw 文件化的 policy reason；lifecycle-summary 經由 shared
  advisory implementation 執行。Plugin initialization 仍是 app-scoped 而非
  per-session，因此 per-session lifecycle fidelity 仍為 degraded。
- Evidence: shim import 測試涵蓋 allow、deny 與 missing-runtime；denial fixture
  只斷言 output shape；doctor 對 OpenCode lifecycle support 回報 `DEGRADED`。
- Positive: `runtime 不可用時，SessionStart 維持 fail-open，而生成的 plugin 會在 Bash pre-tool hook 中 throw 文件化的 command-policy error。`
- Negative: `退回 PATH-resolved 的 agent-ops executable、宣稱 OpenCode host 一定會遵守 thrown denial，或宣稱 app initialization 等同於 per-session Stop。`

## HARNESS-ADAPTER-005

每個 descriptor MUST 分離 control 與 runtime adapter。control adapter 負責
installation plan、routing、ownership、probe 與 in-memory capability
registration matrix；runtime adapter 負責 native input decode、normalized
event、native output encode 與 runtime-failure output。

- Trigger: 新增 harness surface 或 generic capability。
- Action: 在所屬 harness 加入 capability-to-native registration，包含 support
  level 與 runtime-failure mode；不得將 native event 加入 universal union。
- Evidence: 每個宣告為 `supported` 的 registration 都經由真實 CLI hook process
  執行；denial-shape fixture 只斷言文件化的 wire shape，不證明 host runtime
  enforcement；未支援的 Stop/lifecycle registration 不得回報 enforcement success。
- Positive: `fail-closed 的 Claude command-policy runtime failure 會透過 runHookCommand 產生文件化的 PreToolUse denial shape。`
- Negative: `dispatchHookEvent 尚未提供 advisory implementation 卻將 SessionStart 標為 supported。`

## HARNESS-ADAPTER-006

Project-local `loop` profile MUST 是 opt-in、project scoped，並在最小的 Codex 與
Claude Code launcher 後使用同一個 shared runtime；agy 使用原生支援的 lifecycle
子集，並明確回報為 degraded。它 MUST NOT 將 policy 複製到 project-specific
script，也不得改變一般 permission request。

- Trigger: Project 以 agy、Codex、Claude Code 或任意組合選擇 `loop`。
- Action: 只產生選定的 `.codex/hooks/agent-ops-loop.sh` 與／或 Claude 的
  `.claude/hooks/agent-ops-loop.sh`、`.claude/hooks/agent-ops-loop.ps1` launcher，註冊文件化的 loop lifecycle event
  （不含 `Stop`），並保留 foreign hook group。agy 只註冊原生
  `PreInvocation`／`PreToolUse(run_command)` hook，不產生 shell launcher。只在 `UserPromptSubmit` 或 Bash
  `PreToolUse` 的 high-confidence literal credential，以及 `PreToolUse` 的危險 Bash command 時，使用
  文件化的 native denial shape 進行 blocking。對 `PermissionRequest`（包括
  escalated permission）不得輸出 decision。
- Evidence: Install-plan、loop-runtime、update、uninstall 與 doctor test 覆蓋
  generated path、Codex/Claude wire output、privacy bound、configuration conflict
  handling、state preservation 與 registration drift。
- Positive: `Claude PreToolUse 的危險 Bash command 取得 native deny，而 PermissionRequest 不產生 allow 或 deny decision。`
- Negative: `將 project loop policy 複製到兩個 shell launcher、auto-approve sandbox escalation，或加入 loop Stop handler。`

目前 registration matrix 刻意不對稱：

| Capability | agy | Codex | Claude Code | OpenCode |
| --- | --- | --- | --- | --- |
| office-presence (Preview) | degraded | degraded | supported | degraded |
| lifecycle-summary | degraded | supported | supported | degraded |
| command-policy | supported | unknown | supported | supported |
| completion-gate | supported | unsupported | unsupported | unsupported |
| optional-stop-verify | degraded | unsupported | supported | degraded |

Runtime-failure 處理中，只有 `command-policy` 為 fail-closed。當已安裝的 config
被分類為無效時，Claude Code 可輸出文件化的 `PreToolUse` denial shape；受管理的
OpenCode `tool.execute.before` plugin 可在其支援的 Bash surface 上 throw 文件化的
denial 或 unavailable-runtime error。Codex 維持 `unknown` 且絕不輸出 denial。
Fixture test 只斷言這些 wire 與 plugin shape；它們不證明 host 會實際遵守 denial。
每個 `SessionStart` 與 `Stop` failure path 都維持 fail-open。

agy adapter 在 project scope 使用原生 `GEMINI.md` routing 到
`.agent-ops/GEMINI.md`；user
scope 管理 `.agent-ops/GEMINI.md` 與 shared `.gemini/GEMINI.md` rule surface。
其 native hook 使用 camelCase input，command-policy block 回傳
`decision: "deny"`。只有明確啟用 completion gate 時，未具完備證據的 final
changed conversation 才回傳 `decision: "continue"`；唯讀 conversation 正常
結束。在 Windows 透過 `cmd /c` 呼叫產生的 command。

Stop verification 必須明確啟用、具備 trust、為 report-only 且預設 disabled。
每個 Stop 結果都會讓 native harness 繼續，最多攜帶有界 command evidence，永遠
不是 task-completion evidence。

`loop` profile 與上方 ordinary capability matrix 分離。它只保存有界的 local
event metadata、回傳有界且 redacted 的 session context，並在 update 或 uninstall
時保留 local goal、state、telemetry 與 Codex TOML file。既有 Codex configuration
中清楚解析出的 `[features]` / `hooks = false` MUST 在任何 write 前拒絕 loop planning。

## HARNESS-ADAPTER-007

`run` profile MUST 是 opt-in，會一併選取 `core` 與 `loop`，且只新增 `auto-run`
capability。啟用後，Claude Code 與 Codex 的 managed rules 會將需要超過五項
acceptance criteria 的變更交給 `agent-ops run`；五項以內仍留在 session 中處理。
agy rules，以及所有未含 `auto-run` 的 rule file，MUST 與未啟用此 profile 時
byte-identical。

- Trigger: Project 選擇 `run`，且 Claude Code 或 Codex session 遇到需要超過五項
  acceptance criteria 的變更。
- Action: Agent 在 main checkout、且在任何 `task create` 之前，將使用者 prompt
  原文與其提議的 acceptance criteria（標示為提議）寫入已 gitignore 的
  `.agent-ops/state/run-goal.md`，再以 background shell command 啟動
  `agent-ops run --goal-file .agent-ops/state/run-goal.md --host <claude|codex> --wait`。
  Codex 的啟動方式與 review 相同：outer request 使用
  `sandbox_permissions: "require_escalated"` 與
  `env -u CODEX_SANDBOX_NETWORK_DISABLED`。Awaiting-input 結果會轉達給使用者，並以
  `agent-ops run respond` 回覆。啟動遭 `RUN_TARGET_REQUIRED`、
  `RUN_BACKGROUND_UNSUPPORTED`、`RUN_TARGET_DIRTY` 或 `WORKTREE_NESTED` 拒絕時，以
  一行說明該 code，並退回 subtask flow；`RUN_REPO_UNTRUSTED` 則停止並詢問使用者。
  未完成即結束的 run（blocked、budget exhausted、stopped、review 失敗）須回報其
  `run status` state 與 code、最後的 `run logs` event，以及確切的
  `agent-ops run resume <id>` 與 `agent-ops run stop <id>` command，且永不自動
  resume 或由 session 接手。在 worktree auto mode 下，Claude `PreToolUse`
  worktree guard 允許在 main checkout 寫入恰為 `.agent-ops/state/run-goal.md`
  的路徑，且不建立 worktree。確認後的 init/update 會預先授權 `agent-ops run`：
  Claude Code 為 `Bash(agent-ops run *)`，Codex 為
  `env -u CODEX_SANDBOX_NETWORK_DISABLED agent-ops run` 的 escalated prefix rule。
- Evidence: Profile、managed-rule digest、pre-authorization 與 worktree-guard
  test 涵蓋解析後的 profile、未變更的 rules、新增的 entry，以及唯一豁免的路徑。
- Positive: `啟用 run profile 的 Claude Code session 在 main checkout 寫入 .agent-ops/state/run-goal.md，並在 background 啟動 agent-ops run --host claude --wait。`
- Negative: `run profile 啟用時仍將八項 criteria 的變更拆成 subtask、在 GEMINI.md 加入 auto-run 文字，或未經使用者即 resume blocked run。`

## HARNESS-ADAPTER-008

`agent-ops office`（Preview）MUST 只依據 agent-ops state 以 read-only 方式呈現進度。
Supervisor 在確定性的轉換點記錄每個 run 與 worker 的 optional phase
（`planning`、`implementing`、`verifying`、`reviewing`、`integrating`），以及每個
task 最近一次 verify 與 review 結果與通過/總數 criteria。Phase 出現前寫入的 run
state MUST 仍能通過驗證，並顯示為 `unknown`。變更檔案來自各 worktree 自身相對
base 的 `git diff`；旁白只使用路徑（`docs/**` 為「writing docs」、`tests/**` 為
「writing tests」，其他為「editing <file>」）。Office MUST NOT 讀取 Claude 或 Codex
的 native transcript 或檔案內容。

- Office Preview 透過 `features.office.enabled` 明確啟用。Init MUST 提供預設關閉
  的選項；互動式 update MUST 以既有選擇為預設。非互動式 update MUST 保留選擇，
  除非傳入 `--office on|off`。即使只選 core，啟用 Office 也 MUST 安裝 presence
  hook，但 MUST NOT 同時啟用 command policy、Stop verification 或 lifecycle
  summary。Office-only OpenCode 的 runtime 失敗 MUST fail-open；與 command
  policy 同時啟用時 MUST 保留原有拒絕與 runtime unavailable 行為。Agy 啟動事件
  以 invocation 為單位，OpenCode 以 app 為單位，部分 Codex 模式沒有 Stop；過期
  presence 依有界限的 hook 活動逾時處理。舊設定可省略此欄位，省略代表關閉；features 維持
  原有的整個物件 layer 優先順序。關閉時 hook MUST NOT 記錄 Office presence、
  啟動 server 或開啟瀏覽器，明確的 office 指令 MUST 說明啟用方法。運行中的
  server MUST 在下一次 15 秒生命週期檢查觀察到關閉選擇後結束。
- Trigger: 啟用後，Managed 一般 session 啟動或回報活動，或使用者執行
  `agent-ops office`、`agent-ops run start` 或 `agent-ops run status`。
- Action: Command 重用記錄於 `~/.agent-ops/state/office/office.json`（設定
  `AGENT_OPS_HOME` 時位於其下）的使用者唯一 live server，否則啟動一個，並印出
  URL。一般 session hook 也會自動啟動或重用 Office，包含尚未建立 task 或
  worktree 的 session。只有成功取得新 server 所有權的 process 開啟瀏覽器，所有
  repository 的 session 共用同一個 Office。啟用 Office 的 repository 會把 main
  root 與 Git common directory 登記在同目錄的 `repos.json`。每次收集都重新確認
  目錄存在且仍啟用，並忘記安靜超過兩小時且沒有內容可顯示的 repository。房間
  帶有 repository 名稱，key 以其區隔，頁面可依 repository 篩選。仍留有 0.7
  per-repository 紀錄的 repository 第一次回報時，會 bootout 其 launchd job 並
  刪除該紀錄，絕不對其 pid 發送訊號。`worktree finish` 成功後會記錄 session
  完成，使房間關閉；只有新的啟動或 active task 會重新開啟。啟用 Office 時，Claude Code
  另有受管理的 `SessionEnd` hook：對話關閉時房間也隨之關閉，即使沒有 task。它不輸出
  任何內容，也絕不讓 host 失敗。其他 host 沒有結束事件，依活動逾時處理。沒有 task 的
  房間白板顯示「無任務」，而非待驗證與待審查。Session metadata
  只記錄有界限的識別資訊、已知工作狀態與活動時間，不包含 native transcript、
  prompt、tool 或檔案內容。啟動與活動觀察失敗均為 advisory。
  Server 綁定 127.0.0.1 的隨機 port，要求 URL 中不可猜測的 token，拒絕該位址與
  port 以外的 Host，所有非 GET 回應 405，並在 run 與一般 session 都沒有活動
  10 分鐘後結束。唯一的 inline page 使用奶油白、淺木與鼠尾草綠的程式內 16 色
  場景 sprite，沒有圖片 asset。32×48 人物各自使用固定的膚色、髮色與服裝色盤，
  支援四方向走路，並顯示本地化的職責文字。使用者標籤在中文顯示「你」、英文顯示「You」，總覽大小與
  最大房間的成員一致。總覽填滿頂部工具列下方的單一
  viewport，同時呈現全部有家具的工作房間，必要時自動縮小且不捲動頁面。
  房間以共用走廊連接；使用者可以用方向鍵或 WASD 操控本機 Supervisor 角色，
  走進每間房並返回總覽，不會呼叫模型或透過網路修改狀態。每個 run 團隊共用一間房，
  每個一般 session 各有一間，執行中的 review 也保持可見。點房間進入放大的
  詳細畫面，並可返回總覽。每間房包含規劃、開發、驗證、審查與整合區。角色依
  已知 phase 移動與播放輕量動作，並有簡短名牌與狀態；不從對話推測未知狀態。
  白板顯示 criteria 進度、verify/review 結果與待回覆問題，`!` 標示未回答的問題。
  點白板或進度板開啟房間工作清單，點工位或階段區查看該階段的已知工作。
  點待回覆標記查看完整問題與現有可複製指令；同一套分頁視窗也可用
  `L`（工作清單）、`1–5`（階段）與 `Q`（問題）開啟。
  點角色開啟有界限且分頁的 status 詳情，包含可複製的 command。完成房間移到
  最近完成，最多保留兩小時。支援中英文切換並記住選擇、鍵盤操作與 reduced
  motion。一般 session 的存活狀態依 hook 活動判定，30 分鐘沒有事件就會移除
  過期的 presence，不會讀取 native host process。Office 啟動失敗絕不使
  hook、`run start` 或 `run status` 失敗。
- Evidence: Phase、snapshot、server、scene 與 CLI test 涵蓋 legacy state、彙整與
  旁白、一般 session 登記與只開啟一次、完成後兩小時的邊界、token/Host/method
  防護、重用與 injected clock 的 idle 結束、viewport 與房間切換、中英文，以及
  印出的 URL。Browser read-back 檢查實際渲染的單頁布局。
- Positive: `一般 session 自動開啟共用 Office，尚未建立 worktree 就能看到自己的房間；進入團隊房時看到 coordinator 在驗證桌旁，白板顯示 6 項 criteria 已通過 2 項。`
- Negative: `在 0.0.0.0 提供 office、接受 POST、讀取 worker transcript 來產生旁白，或打包 PNG sprite sheet。`
