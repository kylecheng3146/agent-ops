# 設定

保持 project 設定明確且分層。請刻意選擇 scope、harness 與 profile；不要從 `--yes` 推論 trust 或安全例外。

使用 `--harness all` 選取 Codex、Claude Code 與 opencode，或傳入
`codex,opencode` 這類逗號分隔的子集。`both` 仍是 legacy Codex 加 Claude
selection 的 input alias。

Project Codex 與 opencode installation 共用 managed `AGENTS.md` routing
block 與 `.agent-ops/AGENTS.md` rules artifact。Opencode 另外取得
agent-ops 擁有的 `.opencode/plugins/agent-ops.js`；不會修改 `opencode.json`。
Plugin 使用安裝時的 absolute runtime path 產生，因此請透過
`agent-ops update` 更新，不要手動編輯。

User scope 下，Codex 與 opencode 的 routing file 分別位於 `.codex/` 與
`.opencode/`；global opencode plugin 預設位於 `.config/opencode/plugins/`，
若 `$XDG_CONFIG_HOME` 指向 managed user root 內的目錄，則改用
`$XDG_CONFIG_HOME/opencode/plugins/`。若 OpenCode 設定了
`$OPENCODE_CONFIG_DIR`，則 plugin 會放在其 `plugins/` 目錄。只有 profile
有暗示時才會註冊 advisory 與 guardrail hook。Opencode 的 lifecycle-summary 從 plugin
initialization 開始，因此 `doctor` 會將該檢查回報為 `DEGRADED`，不宣稱
具備 per-session coverage。

若要縮減既有 installation，請將目標清單傳給
`agent-ops update --harness`；shared path 會繼續受管理，被移除 harness
擁有的 artifact、marker 與 hook 則會被安全同步。

新增驗證命令時使用[驗收與證據規則](../../en/spec/acceptance-and-evidence.md)，
設定 Codex、Claude Code 或 opencode 行為時使用[adapter 規則](../../en/spec/harness-adapters.md)。
