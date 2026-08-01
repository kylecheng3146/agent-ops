# 設定

保持 project 設定明確且分層。請刻意選擇 scope、harness 與 profile；不要從 `--yes` 推論 trust 或安全例外。

使用 `--harness all` 選取 Codex、Claude Code 與 opencode，或傳入
`codex,opencode` 這類逗號分隔的子集。`both` 仍是 legacy Codex 加 Claude
selection 的 input alias。

Project Codex 與 opencode installation 共用 managed supplemental
`AGENTS.md` routing block 與 `.agent-ops/AGENTS.md` rules artifact。該 block
只載入 managed baseline，並保留 project-specific instructions 的權威性。
Claude 使用對應的 `CLAUDE.md` route 與 `.agent-ops/CLAUDE.md` artifact。Opencode 另外取得
agent-ops 擁有的 `.opencode/plugins/agent-ops.js`；不會修改 `opencode.json`。
Plugin 使用安裝時的 absolute runtime path 產生，因此請透過
`agent-ops update` 更新，不要手動編輯。

User scope 下，Codex 與 opencode 的 routing file 分別位於 `.codex/` 與
`.opencode/`；global opencode plugin 預設位於 `.config/opencode/plugins/`，
若 `$XDG_CONFIG_HOME` 指向 managed user root 內的目錄，則改用
`$XDG_CONFIG_HOME/opencode/plugins/`。若 OpenCode 設定了
`$OPENCODE_CONFIG_DIR`，則 plugin 會放在其 `plugins/` 目錄。只有 profile
有暗示時才會註冊 advisory 與 guardrail hook。Installer 會 discovery 可寫入的
harness surface 並套用選定的 target policy；若不是 managed default，請使用
`--hook-target <harness>=<surface-id>` 明確選擇。Project-local Claude settings
必須明確指定 target。Advisory 會經由真正的 SessionStart path 執行並 fail-open；
Claude 與 Codex lifecycle support 為 `supported`，OpenCode 從 app initialization
開始，因此誠實標示為 `degraded`。

`guardrails` 只安裝 command policy，不會啟用 Stop verification。Stop 是獨立的
config v2 feature，必須明確啟用且至少提供一個已確認的 command：

```json
{
  "features": { "stopVerification": { "enabled": true } },
  "verification": {
    "commands": [
      {
        "id": "unit",
        "command": "npm",
        "args": ["test"],
        "cwd": ".",
        "required": true,
        "evidence": { "kind": "test-count", "minimum": 1 }
      }
    ]
  }
}
```

變更此 feature 會改變 native registration，請依序執行：

```bash
agent-ops update
agent-ops trust grant
```

未執行 `update` 時，doctor 會回報 `UPDATE_REQUIRED`；未重新 grant trust
時，trust-gated hook 仍會是 stale。Stop 是 report-only：`PASS`、`FAIL` 與
`UNKNOWN` 都會讓 harness 繼續，只輸出有界的 command ID、exit code、test-count、
config-hash 與 timestamp evidence，且永遠不會完成 task。Config v1 會決定性遷移
為 Stop disabled 的 v2；舊 binary 無法讀取遷移後的 config，routing migration
一旦套用即為單向，降版前請先閱讀 release notes。

若要縮減既有 installation，請將目標清單傳給
`agent-ops update --harness`；shared path 會繼續受管理，被移除 harness
擁有的 artifact、marker 與 hook 則會被安全同步。

使用舊版 canonical routing wording 的 installation 會由
`agent-ops update` 遷移；若 managed block 曾被修改，指令會 fail closed，
直到該變更被檢查。

Dry-run 的 human 與 JSON plan 不會輸出原始 harness settings 內容，只提供
expected hash、content hash 與安全摘要；internal apply plan 仍保留完整合併後的設定。
Manifest 維持 schema v2。

新增驗證命令時使用[驗收與證據規則](../../en/spec/acceptance-and-evidence.md)，
設定 Codex、Claude Code 或 opencode 行為時使用[adapter 規則](../../en/spec/harness-adapters.md)。
