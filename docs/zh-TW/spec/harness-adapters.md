# Harness Adapter

English source version: 2026-07-31. Revalidate: when the English specification or either vendor reference changes.

本文件所述 OpenCode plugin 行為已於 2026-07-31 依據[官方 plugin 文件](https://opencode.ai/docs/plugins/)與[Bun shell 文件](https://bun.sh/docs/runtime/shell)檢查。

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

OpenCode shim MUST 從選定的 project directory 呼叫 absolute runtime path；runtime 不可用時，MUST 對 advisory event fail open，並對 command-policy event fail closed。

- Trigger: 產生的 plugin 呼叫 `agent-ops`，或收到無效的 runtime decision。
- Action: 將 normalization 與 native output encoding 留在 runtime adapter；deny
  decision 要 throw policy reason；lifecycle-summary 經由 shared advisory
  implementation 執行。Plugin initialization 仍是 app-scoped 而非 per-session，
  因此 per-session lifecycle fidelity 仍為 degraded。
- Evidence: shim import 測試涵蓋 allow、deny 與 missing-runtime；doctor 對
  OpenCode lifecycle support 回報 `DEGRADED`。
- Positive: `runtime 不可用時不阻擋 SessionStart，但會在 bash tool 執行前阻擋它。`
- Negative: `退回 PATH-resolved 的 agent-ops executable，或宣稱 app initialization 等同於 per-session Stop。`

## HARNESS-ADAPTER-005

每個 descriptor MUST 分離 control 與 runtime adapter。control adapter 負責
installation plan、routing、ownership、probe 與 in-memory capability
registration matrix；runtime adapter 負責 native input decode、normalized
event、native output encode 與 runtime-failure output。

- Trigger: 新增 harness surface 或 generic capability。
- Action: 在所屬 harness 加入 capability-to-native registration，包含 support
  level 與 runtime-failure mode；不得將 native event 加入 universal union。
- Evidence: 每個宣告為 `supported` 的 registration 都經由真實 CLI hook process
  執行，未支援的 Stop/lifecycle registration 不得回報 enforcement success。
- Positive: `Claude command-policy 經由 runHookCommand 抵達 native PreToolUse denial。`
- Negative: `dispatchHookEvent 尚未提供 advisory implementation 卻將 SessionStart 標為 supported。`

目前 registration matrix 刻意不對稱：

| Capability | Codex | Claude Code | OpenCode |
| --- | --- | --- | --- |
| lifecycle-summary | supported | supported | degraded |
| command-policy | unknown | supported | supported |
| optional-stop-verify | unsupported | supported | degraded |

Stop verification 必須明確啟用、具備 trust、為 report-only 且預設 disabled。
每個 Stop 結果都會讓 native harness 繼續，最多攜帶有界 command evidence，永遠
不是 task-completion evidence。
