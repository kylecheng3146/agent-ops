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
`--hook-target <harness>=<surface-id>` 明確選擇。Project-local Claude hook 預設
使用 `.claude/settings.json`；只有要使用 `.claude/settings.local.json` 時才需
明確選擇。Advisory 會經由真正的 SessionStart path 執行並 fail-open；
Claude 與 Codex lifecycle support 為 `supported`，OpenCode 從 app initialization
開始，因此誠實標示為 `degraded`。

### 外部 review 目標

`agent-ops review` 可以呼叫另一個 agent CLI 來審查你的工作。預設關閉 ——
缺少 `reviewRoles` 欄位、缺少 `--review-target` 旗標、互動式問題的預設值，
三者都代表關閉。在 `agent-ops init` 時啟用，或手動設定：

```json
{
  "reviewRoles": [
    { "role": "independent-review", "targets": ["claude"] }
  ]
}
```

`targets` 是**有序的後備鏈**。每次 review 都鎖定 staged／unstaged／untracked
變更（或乾淨的 `--base <ref>...HEAD`），並要求必要驗證的最新 PASS evidence；
完整原生 schema report 會顯示給人看，但不會持久化。

每次嘗試都從新的暫存 cwd 與最小環境啟動。目前只有 Claude 具備完整的
context-isolation 合約，能自動執行：

| 目標 | 呼叫方式 | 唯讀 |
| --- | --- | --- |
| `codex` | `codex exec` | 保留設定；`capability-unavailable` |
| `agy`（Antigravity）| `agy -p` | 保留設定；`capability-unavailable` |
| `claude` | `claude -p` | `--permission-mode plan --safe-mode` |

`opencode` **不是** review 目標，即使它是支援的 harness。它的 `--agent plan`
會被判定為 subagent 而遭拒，並靜默退回可寫入的 agent，因此無法滿足唯讀前置
條件。沒有唯讀旗標的目標會被跳過，不會在無沙箱狀態下執行。

只有在「根本沒審到」時才換下一家 —— 執行檔不存在、spawn 失敗、或逾時
（每個目標預設 120 秒，可用 `timeoutMs` 覆寫）。`FAIL` 判定是**終局**：
拿到真實判定後絕不再試下一家，否則就變成自動化的 review shopping。
無法解析的輸出同樣終局，因為那代表 prompt 約定或 CLI 版本不合，該浮出來修。

若 host 是 Claude Code（`CLAUDECODE` 已設定），`claude` 會被移到鏈尾。
當它是唯一設定的目標時仍會執行，並附上 `reviewer == host` 警告。

criterion 描述來自當前 session 綁定的 task，所以 review 需要已附加、且建立時的
policy 設定仍相同的 task；`--criterion` 用來篩選 id。請先執行
`agent-ops verify`：必要 evidence 若失敗、過期或來源不符，review 會在 model 呼叫前停止。
僅 compact PASS evidence 會以 `review:<target>:` 附加；完整人類可讀 report 是暫存的。
已完成的 task 絕不改寫。

每次執行 review 仍需 `--yes`：init 的勾選決定「允許哪些目標」，
`--yes` 決定「現在是否要花錢」。

因為不從 stderr 嗅探認證狀態，未登入的 CLI 會表現為一次 review 失敗。
用以下指令診斷：

```bash
agent-ops doctor              # 只驗執行檔存在：零 token、零網路
agent-ops doctor --check-auth # 每個目標一次真實 print 呼叫
```

`--check-auth` 是專屬旗標；`--yes` 對 doctor 維持惰性。doctor 只回報該做什麼，
不會代為修復：所有目標都經由互動式 OAuth 認證，因此沒有 `--fix`。
請自行執行 `<target> login`。

### Project-local loop profile

`--profile loop` 是明確 opt-in 的 project-scope profile。請選擇 `codex`、
`claude` 或兩者（例如 `--harness codex,claude`）；它需要 POSIX-compatible
`bash`，目前尚未支援 Windows launcher。建議先 dry run：

```bash
agent-ops init --dry-run --scope project --harness codex,claude --profile loop --json
agent-ops init --scope project --harness codex,claude --profile loop --yes
```

對每個選定且支援的 harness，agent-ops 只擁有一個小型 launcher：
`.codex/hooks/agent-ops-loop.sh` 或 `.claude/hooks/agent-ops-loop.sh`。兩個
launcher 都委派給同一個已安裝的 Node runtime，因此不會複製 project-specific
loop script。Codex 只會在 `.codex/config.toml` 不存在時建立它。首次安裝會在不
覆寫既有內容的前提下，於選定 harness directory 建立 `loop-goal.md`、
`loop-state.md` 與 `loop-telemetry.jsonl`；並以 hash-commented `.gitignore`
block 忽略這些 local file。

Loop 會執行 `SessionStart`、`UserPromptSubmit`、`PreToolUse`、
`PermissionRequest`、`PostToolUse`、`PreCompact`、`PostCompact`、
`SubagentStart` 與 `SubagentStop`，但永遠不加入 `Stop`。它只攔截
high-confidence 的 literal secret prompt 或 Bash command，以及危險 Bash command
（包括 broad recursive deletion 與 `git reset --hard`）。Codex 使用原生 exit-code blocking
mechanism；Claude Code 則取得文件化的 native JSON decision shape。
`PermissionRequest`（包括 `sandbox_permissions: "require_escalated"`）只記錄
outcome，不會輸出 allow 或 deny decision，因此 host 原本的 approval flow 保持
權威。

Session context、telemetry 與 compaction state 都受到明確上限。Telemetry 只含
timestamp、event、outcome 與 rule identifier，不會存 raw prompt、command 或
credential，並依 byte size rotation。PreCompact 的 Git-status snapshot 會先
redact，再寫入 `loop-state.md` 的專用 block，周圍的 user content 保持不變。
installer update 與 uninstall 只管理 launcher、native handler registration 與
精確的 `.gitignore` block；goal、state、telemetry 與 `config.toml` 都保留為 local
user file。若既有 `.codex/config.toml` 明確寫有 `[features]` 後的
`hooks = false`，planning 會在任何 write 之前以
`CODEX_LOOP_HOOKS_DISABLED` 停止。

Codex 與 Claude Code 對這些 generated handler 仍須走各自正常的 project-hook
trust/review flow。Loop 是聚焦的 guardrail，不是完整 sandbox、permission bypass
或 Stop-verification feature。啟用前請閱讀 [Codex hook
文件](https://developers.openai.com/codex/config-advanced#hooks)與 [Claude Code
hook 文件](https://code.claude.com/docs/en/hooks)。

### Runtime-failure 保護措施

對一般 `guardrails` profile 而言，只有 `command-policy` 具有 fail-closed failure mode。當已安裝的 config 被分類
為無效時，Claude Code 可在原生 `PreToolUse` 輸出文件化的 denial shape。受管理的
OpenCode `tool.execute.before` plugin 可在其支援的 Bash surface
上 throw 文件化的 command-policy denial 或 unavailable-runtime error。Codex 明確
不執行強制措施（`unknown`）。這些是 agent-ops 的 output 與 plugin contract，不
證明 host 會實際遵守 denial。所有 adapter 的 `SessionStart` 與 `Stop` failure path
都維持 fail-open。

Claude 的無效 config fallback 有四項防護：(1) 缺少 project configuration 時保持
fail-open，因此只有無效的 `.agent-ops/config.json` 能進入 fallback；(2) manifest
必須安全地證明目前 harness 已安裝；(3) 使用者可在啟動 host 前於 shell export
`AGENT_OPS_DISABLE=1`，暫時恢復 fail-open；(4) Claude Code denial 會列出 config
path，並告知使用者修正它或暫時設定該 shell variable。此 variable 只從
hook-process environment 讀取，不能由 agent-ops configuration、manifest 或
managed file 設定。

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

未執行 `update` 時，doctor 可因 registration drift 回報 `UPDATE_REQUIRED`。另
外，toolkit upgrade 或 effective profile 或 capability change 使完整的
path-independent managed rules artifact 改變時，`artifact-staleness` 會回報帶有
`UPDATE_REQUIRED` 的 `DEGRADED`。`agent-ops update` 會重新產生 artifact 並清除
這個結果；artifact 缺失或 hash 不符時，`artifacts` check 仍為 `FAIL`。未重新
grant trust 時，trust-gated hook 仍會是 stale。Stop 是 report-only：`PASS`、`FAIL`
與 `UNKNOWN` 都會讓 harness 繼續，只輸出有界的 command ID、exit code、test-count、
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
