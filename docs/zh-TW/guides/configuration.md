# 設定

保持 project 設定明確且分層。請刻意選擇 scope、harness 與 profile；不要從 `--yes` 推論 trust 或安全例外。

使用 `--harness all` 選取 agy、Codex、Claude Code 與 opencode，或傳入
`codex,opencode` 這類逗號分隔的子集。`both` 仍是 legacy Codex 加 Claude
selection 的 input alias。

Project agy 使用 managed supplemental `GEMINI.md` routing block 與
`.agent-ops/GEMINI.md` baseline；這符合 agy CLI 官方文件所述，啟動時會讀取
workspace root 的 `GEMINI.md` 或 `AGENTS.md`。Codex 與 opencode 共用
`AGENTS.md` route 與 `.agent-ops/AGENTS.md` artifact。這些 block 只載入
managed baseline，並保留 project-specific instructions 的權威性。
Claude 使用對應的 `CLAUDE.md` route 與 `.agent-ops/CLAUDE.md` artifact。Opencode 另外取得
agent-ops 擁有的 `.opencode/plugins/agent-ops.js`；不會修改 `opencode.json`。
Plugin 使用安裝時的 absolute runtime path 產生，因此請透過
`agent-ops update` 更新，不要手動編輯。

User scope 下，agy 使用 `.agent-ops/GEMINI.md` 與共用 Gemini surface
`.gemini/GEMINI.md`；Codex 與 opencode 的 routing file 分別位於 `.codex/` 與
`.opencode/`。Global opencode plugin 預設位於 `.config/opencode/plugins/`，
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

`targets` 是完整指令 `agent-ops review --task <id> --yes` 的有序選擇。
每一條 task criterion 與原始 description 都會針對 staged／unstaged／untracked
變更（或乾淨的 `--base <ref>...HEAD`）審查；必要驗證的最新 PASS evidence
必須在 reviewer 啟動前存在。裸跑或 partial review 不算完整 task review，也
不能滿足 completion。

`--review-target` 只屬於 `init`，用來設定持久 reviewer selection。`review` 不接受
target、criterion 或 evidence override。每次恰好規劃兩個全新 session：設定三個
target 時必須提供 `AGENT_OPS_HOST=agy|claude|codex`，排除該 host 並優先選 agy；
設定兩個時依設定順序執行；設定一個時同一 CLI 執行兩次。review JSON 的
`plannedTargets` 會列出實際順序。

每次嘗試都從全新 session、一次性 repository clone 與原生唯讀模式啟動。Claude 使用完整 safe-mode
隔離；Codex 與 Agy 為了支援既有 OAuth 登入而保留登入環境，因此 context
隔離較弱。Agy 會取得一次性 clone，即使 sandboxed plan mode 寫入 cwd，也無法
修改來源 repository：

| 目標 | 呼叫方式 | 唯讀 |
| --- | --- | --- |
| `codex` | `codex exec` | `-s read-only --ephemeral --ignore-user-config` |
| `agy` | `agy --print <prompt>` | `--sandbox --mode plan` |
| `claude` | `claude -p` | `--permission-mode plan --safe-mode` |

第一個 session 是必要 reviewer。只有第一個 PASS 才會啟動第二個 adversarial
session，並將第一份完整 redacted report 以不可信資料傳入。第一個 FAIL 或
NOT_RUN 立即停止；第二個 FAIL 是終局 FAIL，第二個無法取得 verdict 則為
NOT_RUN。同 target pair 仍因 session 與 clone 全新而具獨立性；不得 resume 開發
session。

`opencode` **不是** review 目標，即使它是支援的 harness。它的 `--agent plan`
會被判定為 subagent 而遭拒，並靜默退回可寫入的 agent，因此無法滿足唯讀前置
條件。沒有唯讀旗標的目標會被跳過，不會在無沙箱狀態下執行。

Agy 的 prompt 會直接作為 `--print` 的值；裸用 `-p` 會誤吞下一個 flag。
agent-ops 刻意不傳會繞過權限邊界的 `--dangerously-skip-permissions`，也不傳會
使 plan mode 失效的 `--disable-slash-commands`。

Host 缺少 network 或 loopback 權限時，會在啟動任何 reviewer 前回傳
`REVIEW_NOT_RUN`。Managed 規則要求可信任的外部 host runner 在第一次呼叫時
就用兩項權限啟動同一個完整指令；不要先在原 sandbox 執行再重試，因為那不算
升權，也不能產生 PASS。文字與 JSON 輸出都會保留每次 attempt、preflight 與
diagnostic。

Capability check 與模型啟動進度都寫到 stderr，包括 `--json` 模式；stdout
仍只有最終 JSON envelope，且不會串流 reviewer 原始輸出。SIGINT 或 SIGTERM
會終止目前 reviewer 的完整 process tree、不進入 fallback，也不寫入
attestation。整條 chain 逾時時回報 `timeout`，不會誤報 `missing-cli`。

task ID 必須明確指定，且永遠使用該 task 的原始 criteria；不能用 session fallback
或 criterion filter 取代需求。review 會在 adversarial session 前、以及寫入證據前
重新確認 source fingerprint。完整 PASS 後，兩份完整 redacted report 會私密保存於
`.agent-ops/reviews/`；attestation 只保存 metadata 與 report digest。任何 evidence
寫入失敗都維持 `REVIEW_NOT_RUN`。Compact PASS evidence 仍以
`review:<target>:` 附加，已完成的 task 絕不改寫。

每次執行 review 仍需 `--yes`：init 的勾選決定「允許哪些目標」，
`--yes` 決定「現在是否要花錢」。

Reviewer 失敗會依輸出採保守分類：可辨識的認證訊息為 `login-required`，
quota 訊息為 `quota-exhausted`，其他非零退出則為 `capability-unavailable`。
只有偵測到認證失敗時，review 才會建議執行 `doctor --check-auth`。
可用以下指令確認目標的認證狀態：

```bash
agent-ops doctor              # 只驗執行檔存在：零 token、零網路
agent-ops doctor --check-auth # 每個目標一次真實 print 呼叫
```

`--check-auth` 是專屬旗標；`--yes` 對 doctor 維持惰性。doctor 只回報該做什麼，
不會代為修復：所有目標都經由互動式 OAuth 認證，因此沒有 `--fix`。
請自行執行 `<target> login`。

### 在 worktree 中並行 session

Verification、review 與 completion gate 都對整個 Git change surface 計算
fingerprint，因此兩個對話修改同一個 checkout 會互相作廢對方的 evidence。
請讓每個修改中的對話使用自己的 worktree：

```json
{
  "worktree": {
    "mode": "auto",
    "setup": [{ "command": "pnpm", "args": ["install", "--frozen-lockfile"] }]
  }
}
```

- `mode: "auto"` 讓每個修改中的對話都先在主 checkout 執行
  `agent-ops worktree add <name> --session <id>`。Claude Code 直接以 Edit 或
  Write 修改主 checkout 中 `.worktrees/` 以外的檔案會被拒絕（需先執行一次
  `agent-ops update`，讓 PreToolUse hook 比對檔案工具）。未設定或 `"off"` 則維持
  目前的單一 checkout。
- 在主 checkout、已知 session 的情況下執行 `agent-ops task create`，會先建立（或重用）
  該 session 的 worktree，並把 task 記錄在那裡，讓工作一開始就在 worktree 內。輸出會列出
  要進入的路徑與 verify 用的 `--base`。
- 作為 Claude Code 上的後備，第一次被拒絕的編輯會自動建立該 worktree：
  `.worktrees/session-<session id 前八個字元>`，包含 setup，並綁定該 session。
  拒絕訊息會列出要以 EnterWorktree 進入的路徑；同一 session 之後被拒絕時會重用它。
  建立失敗時，拒絕訊息會說明原因並退回手動 `worktree add`。需先執行一次
  `agent-ops update`，讓 PreToolUse hook 取得 setup 所需的 600 秒逾時。
- `add` 從主 checkout 的 HEAD 建立 `.worktrees/<name>` 與 branch
  `agent-ops/<name>`，並透過 `.git/info/exclude`（而非 `.gitignore`）排除
  `/.worktrees/`。它會複製 agent-ops 安裝的 ignored 檔案，以及根目錄
  `.worktreeinclude`（gitignore 語法，例如 `.env` 或 `local.properties`）比對到
  的檔案；Git 已 checkout 的檔案一律不覆寫。只有主 checkout 已 trusted 且
  worktree 的 effective config 完全相同時才繼承 trust。
- `setup` 指令在新 worktree 中執行（預設 timeout 十分鐘），處理 Git 不會帶過去
  的東西，例如已安裝的相依套件。它屬於 trusted config 的一部分，不需另外核准；
  任一步驟失敗會移除該 worktree。
- Session 的 completion gate 會跟著它：Claude Code 以 EnterWorktree 進入
  worktree；無法移動 session 的 host（agy）則透過主 checkout 記錄的 redirect，
  由 worktree 的 gate 判定。
- `agent-ops worktree finish <name>` 只以 fast-forward 合併，一次只執行一個
  finish。Target 若已前進會先 rebase；沒有衝突且自身 patch 不變的 rebase 會先
  重新驗證再合併；衝突則連同先合併那份工作在 `refs/notes/agent-ops` 的意圖一起
  回報。
- `worktree list`、`resume <name> --session <id>` 與 `remove <name>` 管理剩下的
  worktree；`remove --force` 會丟棄工作，執行前會先詢問使用者。`doctor` 會回報
  閒置超過七天的 worktree。

### Project-local loop profile

`--profile loop` 是明確 opt-in 的 project-scope profile。請選擇 `codex`、
`claude` 或兩者（例如 `--harness codex,claude`）。Claude Code 已支援原生
Windows，會使用產生的 PowerShell launcher；Codex 的 loop launcher 仍需要
POSIX-compatible `bash`。建議先 dry run：

```bash
agent-ops init --dry-run --scope project --harness codex,claude --profile loop --json
agent-ops init --scope project --harness codex,claude --profile loop --yes
```

在原生 Windows 上，除非 Codex 是在 POSIX environment 執行，請選擇
`--harness claude`；Codex loop 仍會呼叫 `bash`。

對每個選定且支援的 harness，agent-ops 擁有最小的 native launcher：Codex 是
`.codex/hooks/agent-ops-loop.sh`；Claude Code 是
`.claude/hooks/agent-ops-loop.sh` 與 `.claude/hooks/agent-ops-loop.ps1`。兩個
Claude launcher 都委派給同一個已安裝的 Node runtime，因此不會複製
project-specific loop script。Windows 產生的 settings 會選用 PowerShell
launcher。Codex 只會在 `.codex/config.toml` 不存在時建立它。首次安裝會在不
覆寫既有內容的前提下，於選定 harness directory 建立 `loop-goal.md`、
`loop-state.md` 與 `loop-telemetry.jsonl`；並以 hash-commented `.gitignore`
block 忽略這些 local file。

agy 會安裝原生 `PreInvocation` 與 `PreToolUse(run_command)` 子集，doctor
會將 loop 標示為 degraded。Project hook 位於 `.agents/hooks.json`，user hook
位於 `.gemini/config/hooks.json`；user scope 會修改共享 Gemini rule surface
`.gemini/GEMINI.md`。機器可讀的 `/hooks` 診斷要求 agy 1.1.12 以上。

`agy` 或 `claude` 搭配 `loop` 時，互動式 installer 會建議啟用
`features.completionGate.enabled`；非互動安裝必須明確傳入
`--completion-gate`。這兩者是 Stop hook 能真正拒絕收工的 host：codex 在
`codex exec` 下不會觸發 Stop hook，且拒絕 `permissionDecision: ask`，其 permit
無法交由使用者核准；OpenCode plugin 只能拒絕單一 tool call。閘門使用官方定義的 `conversationId`、
`terminationReason` 與 `fullyIdle` Stop 欄位，只有在本次 conversation 產生
Git-visible net change 且缺少當前 task、驗證或 review 證據時，才回傳官方定義的
`decision: "continue"`。純問答、分析、唯讀診斷、錯誤、max-step 與 non-idle Stop
都正常結束。Claude Code 以自身的 Stop contract 執行同一道閘門，拒絕時回傳
`decision: "block"`；本版不改變 Codex 或 OpenCode 的 Stop 行為。Headless
請使用 `agent-ops agy-run -- <agy arguments>`；使用者可核准一次
`agent-ops allow-stop --session <conversationId>`，該命令在 agy 由官方定義的
`force_ask` 強制詢問，在 Claude Code 則由 `permissionDecision: ask` 強制詢問。

官方依據：[agy CLI workspace rule file](https://www.antigravity.google/docs/cli/best-practices/)
與 [Antigravity hook contract](https://www.antigravity.google/docs/hooks/)。

完整 Codex/Claude loop 會執行 `SessionStart`、`UserPromptSubmit`、`PreToolUse`、
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
證明 host 會實際遵守 denial。所有 `SessionStart` 與一般 Stop verification failure
path 都維持 fail-open；只有明確啟用的 completion gate 會在 final Stop
fail-closed，適用於 agy 與 Claude Code。

Claude 的無效 config fallback 有四項防護：(1) 缺少 project configuration 時保持
fail-open，因此只有無效的 `.agent-ops/config.json` 能進入 fallback；(2) manifest
必須安全地證明目前 harness 已安裝；(3) 使用者可在啟動 host 前於 shell export
`AGENT_OPS_DISABLE=1`，暫時恢復 fail-open；(4) Claude Code denial 會列出 config
path，並告知使用者修正它或暫時設定該 shell variable。此 variable 只從
hook-process environment 讀取，不能由 agent-ops configuration、manifest 或
managed file 設定。

`guardrails` 只安裝 command policy，不會啟用 Stop verification。Stop 是獨立的
config v3 feature，必須明確啟用且至少提供一個已確認的 command：

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
```

未執行 `update` 時，doctor 可因 registration drift 回報 `UPDATE_REQUIRED`。另
外，toolkit upgrade 或 effective profile 或 capability change 使完整的
path-independent managed rules artifact 改變時，`artifact-staleness` 會回報帶有
`UPDATE_REQUIRED` 的 `DEGRADED`。`agent-ops update` 會重新產生 artifact 並清除
這個結果；artifact 缺失或 hash 不符時，`artifacts` check 仍為 `FAIL`。未重新
project update 經確認後，若有 verifier 會自動更新 stale trust binding。

doctor 從不寫入檔案，部分結果本來就無法修復：安裝根目錄以外的 surface，
或 harness 依 descriptor 宣告只部分支援的 capability（例如 opencode 的
`lifecycle-summary`），會永久回報 `UNKNOWN` 或 `DEGRADED` 且 exit 0。若 CI
需要自動修復，請直接呼叫 `agent-ops update`；也可手動呼叫 `agent-ops trust grant`，
不要解析 doctor 的輸出。

Stop 是 report-only：`PASS`、`FAIL`
與 `UNKNOWN` 都會讓 harness 繼續，只輸出有界的 command ID、exit code、test-count、
config-hash 與 timestamp evidence，且永遠不會完成 task。Config v1 會決定性遷移
為 Stop disabled 的 v2；舊 binary 無法讀取遷移後的 config，routing migration
一旦套用即為單向，降版前請先閱讀 release notes。

若要縮減既有 installation，請將目標清單傳給
`agent-ops update --harness`；shared path 會繼續受管理，被移除 harness
擁有的 artifact、marker 與 hook 則會被安全同步。

若只要移除單一已整合 harness，可使用
`agent-ops uninstall --harness agy`（或其他已安裝 id）。剩餘 manifest 與
shared path 會保留；省略 `--harness` 才會移除整套 managed installation。

使用舊版 canonical routing wording 的 installation 會由
`agent-ops update` 遷移；若 managed block 曾被修改，指令會 fail closed，
直到該變更被檢查。

Dry-run 的 human 與 JSON plan 不會輸出原始 harness settings 內容，只提供
expected hash、content hash 與安全摘要；internal apply plan 仍保留完整合併後的設定。
Manifest 維持 schema v2。

新增驗證命令時使用[驗收與證據規則](../../en/spec/acceptance-and-evidence.md)，
設定 Codex、Claude Code 或 opencode 行為時使用[adapter 規則](../../en/spec/harness-adapters.md)。
