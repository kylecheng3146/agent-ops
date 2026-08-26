# Harness Adapter

English source version: 2026-08-03. Revalidate: when the English specification or any vendor reference changes.

本文件所述 OpenCode plugin 行為已於 2026-07-31 依據[官方 plugin 文件](https://opencode.ai/docs/plugins/)與[Bun shell 文件](https://bun.sh/docs/runtime/shell)檢查；Codex 與 Claude Code loop-hook 行為已於 2026-08-03 依據 [Codex hook 文件](https://developers.openai.com/codex/config-advanced#hooks) 與 [Claude Code hook 文件](https://code.claude.com/docs/en/hooks) 檢查。

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
Claude Code launcher 後使用同一個 shared runtime。它 MUST NOT 將 policy 複製到
project-specific script，也不得改變一般 permission request。

- Trigger: Project 以 Codex、Claude Code 或兩者選擇 `loop`。
- Action: 只產生選定的 `.codex/hooks/agent-ops-loop.sh` 與／或 Claude 的
  `.claude/hooks/agent-ops-loop.sh`、`.claude/hooks/agent-ops-loop.ps1` launcher，註冊文件化的 loop lifecycle event
  （不含 `Stop`），並保留 foreign hook group。只在 `UserPromptSubmit` 或 Bash
  `PreToolUse` 的 high-confidence literal credential，以及 `PreToolUse` 的危險 Bash command 時，使用
  文件化的 native denial shape 進行 blocking。對 `PermissionRequest`（包括
  escalated permission）不得輸出 decision。
- Evidence: Install-plan、loop-runtime、update、uninstall 與 doctor test 覆蓋
  generated path、Codex/Claude wire output、privacy bound、configuration conflict
  handling、state preservation 與 registration drift。
- Positive: `Claude PreToolUse 的危險 Bash command 取得 native deny，而 PermissionRequest 不產生 allow 或 deny decision。`
- Negative: `將 project loop policy 複製到兩個 shell launcher、auto-approve sandbox escalation，或加入 loop Stop handler。`

目前 registration matrix 刻意不對稱：

| Capability | Codex | Claude Code | OpenCode |
| --- | --- | --- | --- |
| lifecycle-summary | supported | supported | degraded |
| command-policy | unknown | supported | supported |
| optional-stop-verify | unsupported | supported | degraded |

Runtime-failure 處理中，只有 `command-policy` 為 fail-closed。當已安裝的 config
被分類為無效時，Claude Code 可輸出文件化的 `PreToolUse` denial shape；受管理的
OpenCode `tool.execute.before` plugin 可在其支援的 Bash surface 上 throw 文件化的
denial 或 unavailable-runtime error。Codex 維持 `unknown` 且絕不輸出 denial。
Fixture test 只斷言這些 wire 與 plugin shape；它們不證明 host 會實際遵守 denial。
每個 `SessionStart` 與 `Stop` failure path 都維持 fail-open。

Stop verification 必須明確啟用、具備 trust、為 report-only 且預設 disabled。
每個 Stop 結果都會讓 native harness 繼續，最多攜帶有界 command evidence，永遠
不是 task-completion evidence。

`loop` profile 與上方 ordinary capability matrix 分離。它只保存有界的 local
event metadata、回傳有界且 redacted 的 session context，並在 update 或 uninstall
時保留 local goal、state、telemetry 與 Codex TOML file。既有 Codex configuration
中清楚解析出的 `[features]` / `hooks = false` MUST 在任何 write 前拒絕 loop planning。
