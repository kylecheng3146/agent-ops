# 相容性

自 1.0.0 起，agent-ops 遵循語意化版本：在 1.x 範圍內，任何版本都不會破壞下列保證
的介面。1.0.0 之前，minor 版本仍可能變更它們，changelog 會標出每一項破壞性變更。

## 保證的介面

- `agent-ops` CLI 的指令、旗標與其文件記載的行為。
- 以 `--json` 列印或由 `--output` 寫出的 JSON envelope：`code`、`status`、`data`、
  `errors`，以及 `data` 中文件記載的欄位。
- README、指南或規範中列出的錯誤碼。
- 結束碼：成功為 `0`；review 或 batch 未執行（`REVIEW_NOT_RUN`、`BATCH_NOT_RUN`）
  為 `2`；其他錯誤為 `1`。
- `.agent-ops/config.json`、`--surface-file` 稽核格式，以及 `schemas/` 隨附的
  JSON schema。
- 提交進 repository 的資料：`.agent-ops-escapes/` 的 escape ledger，以及
  `refs/notes/agent-ops` 的 finish notes。
- 升級時的本機狀態：較新的 1.x 版本能讀取或遷移較舊 1.x 版本寫入的 config 與狀態。

## 不保證

- Preview 功能，目前是 Office（`agent-ops office`）。
- 給人閱讀的文字輸出；請改為解析 `--json`。
- `.agent-ops/tasks/`、`.agent-ops/state/` 與 Git common directory 中本機狀態的
  內部格式（run state、receipt、checkpoint）。
- 受管規則檔的內文，例如 `.agent-ops/CLAUDE.md` 與 `.agent-ops/AGENTS.md`；
  `agent-ops update` 會重寫它們。
- Reviewer 與 advisory 的 prompt。
- 由各 host 定義的 hook 傳輸格式。

## Gate 變更

Gate（surface 稽核、verify、review 與 completion gate）會隨著發現的漏洞而變嚴。
gate 變嚴或變寬都以 minor 版本發布，並在 changelog 加上 `Gate:` 條目。修補「不需
證明就能通過 gate」的修正可以用 patch 版本發布。移除或改名文件列出的錯誤碼屬於
破壞性變更，要等到 major 版本。

## 淘汰

被淘汰的指令或旗標至少再保留一個 minor 版本，每次使用都會在 stderr 印出警告，
changelog 會將它列為已淘汰，並且只在下一個 major 版本移除。

## 升級與遷移

`agent-ops update` 會把已安裝的檔案更新到目前版本。較新的 1.x 版本會讀取或遷移
較舊 1.x 版本的 config 與狀態。不支援降版：較舊的版本可能拒絕較新版本寫入的狀態。

## 支援的版本

只有最新的 1.x minor 版本會收到修正，包括安全性修正；請升級以取得修正。套件需要
`engines` 列出的 Node.js 版本；停止支援已終止維護（end of life）的 Node.js 版本
屬於 minor 版本。

## 平台與 host

| 範圍 | 支援 |
| --- | --- |
| macOS | 全部功能，包含背景 native run（`agent-ops run`）。 |
| Linux 與 Windows | 除了背景 native run 以外的全部功能；背景 run 會以 `RUN_BACKGROUND_UNSUPPORTED` 停止。 |
| Host | 各 host 的能力依照 [harness adapter 矩陣](../spec/harness-adapters.md)；completion gate 在 agy 與 Claude Code 上執行。 |

平台或 host 支援等級的變動都會列在 changelog。
