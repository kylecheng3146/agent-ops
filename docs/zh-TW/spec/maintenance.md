# 維護

English source version: 2026-07-23. Revalidate: when the English specification changes.

## MAINTAIN-BACKUP-001

編輯不含文字秘密的 rule、prompt、model table、memory 或 hook 前，操作者 MUST 建立並驗證可復原備份。

- Trigger: 即將變更受維護的政策或 lifecycle 檔案。
- Action: 編輯前把來源複製到日期化備份路徑並比較。
- Evidence: 記錄備份路徑與比較命令。
- Positive: `編輯前 cmp source backup 成功。`
- Negative: `沒有可復原副本就直接修改 hook。`

## MAINTAIN-FACT-001

易變的 harness fact MUST 放在 adapter 或 research 文件，且 MUST 包含重驗條件。

- Trigger: 記錄版本化或 vendor-specific 行為。
- Action: 說明來源日期與何時重新檢查。
- Evidence: 文件含來源與 `Revalidate:` 條件。
- Positive: `Revalidate：vendor hook reference 變更時。`
- Negative: `把暫時性的 CLI flag 當永久核心規則。`
