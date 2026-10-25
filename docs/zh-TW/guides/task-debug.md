# Task DEBUG 調查

DEBUG task 就是一般 task，只是驗收條件要證明原始回歸：一條 behavioral criterion，
其 `redCheckIds` 在 baseline commit 以 assertion 失敗、在 candidate 通過。除此之外沒有任何特殊流程。

```sh
agent-ops task create --debug --title "修購物車無法捲動" \
  --goal '<原始問題，逐字>' \
  --surface-file surface.json \
  --criterion-file regression.json --criterion-file related.json
```

- `--debug` 需要 `--goal`，且至少一條帶 `redCheckIds` 的 behavioral criterion；
  否則建立失敗並回 `TASK_DEBUG_RED_CHECK_REQUIRED`。surface audit 與一般 task 一樣必填。
- baseline 是建立 task 時的 commit；`task revise --baseline <ref>` 可移動它
  （例如開錯分支時），並使先前證據失效。
- 之後修復、commit、`verify`、兩輪 `review`、`worktree finish`，與一般 task 完全相同。
  setup 失敗、skip、timeout 與 UNKNOWN 都不算重現；red check 必須在 baseline 以 assertion 失敗。

## 逃逸來源（建議性質）

若知道 bug 從哪裡來，與一般 task 一樣記錄：
`task revise --escape-of <commit> --escape-label <label>`。它會寫入 `.agent-ops-escapes/<task-id>.json`，並印出
連結狀態、`git blame` 提示與規則證明（如 `ESCAPE_RULE_UNPROVEN`）。這些都不會阻擋
finish；見 `EVIDENCE-ESCAPE-001` 與 `EVIDENCE-ESCAPE-002`。

## 0.11.0 移除項目

`task debug`（假設、策略切換、investigate、checkpoint、resume、extend、origin）、
60 分鐘預算與 5 輪上限、原生控制詞（只診斷、暫停、繼續、繼續修復、取消時間限制）、
prompt hook 自動建立 DEBUG、DEBUG 專用 Stop 阻擋，以及 Codex `Interrupt` hook
都已移除。`task debug` 現在回傳 `TASK_DEBUG_REMOVED`。

舊狀態仍可讀取：task 保留 `debug` 標記，已存的預算與假設狀態會被忽略，
`originRequired` 不再阻擋 finish，config 的 `features.debug` 仍被接受並在下次 `update` 時移除。

完整說明見英文 [Task DEBUG](../../en/guides/task-debug.md)。

## 保留的審查 followup

finish 後以 `agent-ops followup list`、`followup show <followup-id>` 檢視，agent 可加
`--json`。`followup import` / `followup sync` 只回填本機歷史中繼資料，不呼叫模型或修復。
私有狀態在 Git common directory，所有連結 worktree 共用。收集警告不影響原始完成；
修正來源或狀態問題後可重試。

自由文字觀察需先明確釐清：

```sh
agent-ops followup clarify <followup-id> --finding-file finding.json --reason '具體主張與來源證據'
agent-ops followup defer <followup-id> --reason '相依套件升級後再處理'
agent-ops followup accept <followup-id> --reason '接受此版本的取捨'
agent-ops followup reopen <followup-id>
env -u CODEX_SANDBOX_NETWORK_DISABLED agent-ops followup process <followup-id> --host codex
```

`finding.json` 是一般非阻擋 ReviewFinding：severity、blocking=false、title、details、
locations（path、line）、evidence、recommendation、criterionIds。接受與延後必須有理由，
不等於結案；reopen 與再次 process 均保留來源及證據歷史。process 明確授權兩次隔離、
唯讀、針對目前原始碼的新鮮審查，且只在確定 PRESENT 時啟動全新有界的正式原生修復 run。
UNKNOWN、漂移與 reviewer 錯誤維持未解決。仍遵守 macOS、乾淨主 checkout、目標分支、
信任與 run policy；拒絕保留原始碼，不繞過 nested-run 限制。

process 必須透過可信任外層 host；`update --auto-run on` 可提出限定 run profile 權限。
不可自行修改信任或已安裝設定繞過拒絕。無法用可執行檢查判定的主張可加
`--review-only-reason '具體理由'`；ABSENT 仍需兩次新鮮且有理由的審查。
可重現錯誤仍需對應 behavioral 紅轉綠。修復結案驗證原始 finding、`followup-resolution`
契約、交付 receipt、精確 commit 與證據摘要；一般測試 PASS、路徑變動或 run 完成不能結案。
本流程不新增 DEBUG 調查手續或 SessionStart 摘要。
