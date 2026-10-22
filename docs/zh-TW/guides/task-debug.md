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
