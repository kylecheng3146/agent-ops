# Task DEBUG 調查

`init` / `update` 預設加入 `features.debug`：啟用、60 分鐘、5 輪。
之後保留明確關閉與自訂設定；舊設定和一般 task 保持相容。

Claude / Codex prompt hook 會保守辨識調查與修復問題，保留原始 `goal`，
建立既有隔離 task。說明、功能與重構請求照原流程。
缺少可靠 session ID，或 agy 沒有 prompt 事件時，使用原生 Agent 執行
`task create --debug --goal '<原始問題>'`；只要有 native session，CLI intake
會啟動同一個前景時鐘。原始 dirty checkout 不會被自動複製。

調查用可信任的既有 command；假設用 `task debug --debug-action hypothesis
--payload-file <json>`。JSON 必須含 id、statement、method、expected、checkId、
expectedStatus；附 reference 才能由真實封存的 assertion 決定 confirmed/rejected。
`--action investigate` 只能執行已宣告且尚未解決的 behavioral red check；
`--action observe` 只能把目前相符的 runtime `UNKNOWN` receipt 記為 inconclusive。
兩者都不能由 Agent 自填 status。重開 rejected 假設需要新證據與 reason。

將暫定 criteria 改為原始問題的 behavioral 回歸，執行 verify、兩輪獨立 review，
再透過既有 worktree finish 完成。基線 assertion red、候選 green、相關檢查與
當前 proof digest 都必須有效；setup / skip / timeout / UNKNOWN 不算重現。
DEBUG 預設自動走完修復閉環。乾淨 HEAD 自動固定為基線，不要為此再問許可，
也不要主動降為只診斷。單次未重現不構成停止理由；在原預算內繼續做鑑別檢查。

## 人類控制

只有原生 transcript 的人類事件能改變原 task 的範圍；CLI actor/text、assistant
訊息及注入指令都不能授權。Codex 支援目前 `response_item` 的 `user.text` 與
原生非同步回答，也保留舊 `event_msg` 格式。

- `只診斷` / `diagnosis only`：繼續調查但不修產品。原始回歸的當前封存 baseline
  assertion FAIL 必須支持 confirmed 假設，或已有 runtime blocker／預算上限，才允許非成功停止。
- `暫停` / `pause`：保存進度後立即停止。Codex 原生 `Interrupt` 也表示暫停；
  hook timeout 為三秒，不能阻擋或重新啟動使用者的中斷。
- `繼續` / `continue`：接回同一 task 及原範圍；耗盡時間仍需既有原生時間授權，其他阻礙不解除。
- `繼續修復` / `resume repair`：在原 task 恢復完整修復閉環。

暫停保留證據、已用時間及輪數，等待不計時，也不重設預算。診斷或暫停都不能將
修復 task 標為完成；模糊文字不推測為授權，請使用上述明確指令。

預算與輪數屬於整個原始 root，revision、child、session 不重設。新 session 重送同一個 active issue 文字時，會接回原本的 root（或 resume 持有它的 worktree），不會另開新預算。已確認或已否決的假設不能換 id、用相同陳述與方法重開；請帶新的鑑別證據重開原假設。
受控調查、驗證與取得 slot 後的 review 計時；review 排隊不計時。
Claude、Codex 與 agy 都使用可信 native session lifecycle，在 `UserPromptSubmit`
或原生 session 開始前景時鐘，並在 idle `Stop` 結束。因此該輪的 Agent 推理、
工具與修改都計入，停止回合之間的使用者等待不計入。Codex 被拒絕的 Stop 仍繼續
計時，重複 Stop 的 `stop_hook_active: true` 不會繞過 DEBUG gate。opencode 沒有支援
的前景 lifecycle，不可宣稱完整的 active-time 預算。
中斷且沒有封存結果的操作，必須等持久化 process identity 證實程序已死亡後，
才封存 UNKNOWN environment receipt；這段經過時間仍會保留，不會退還不明時間。
測試材料修改不算修復輪；兩輪停滯需要一次實質策略切換，再兩輪停滯停止。

假設確認後以 `origin --payload-file <json>` 宣告 bug 來源：`{"kind": "escape-of",
"commit": "<commit>", "label": "<最早關卡>"}`（可選 `"receipt"`），或 `{"kind":
"pre-existing" | "external", "reason": "..."}`。它會修訂 contract，因此 review 前要重新
verify 並重新記錄已確認的假設；沒有它時 finish 以 `ESCAPE_ORIGIN_MISSING` 拒絕。
`escape-of` 會印出連結狀態與 `git blame` 提示，並寫入 `.agent-ops-escapes/<task-id>.json`，
與修復一起 commit（見 `EVIDENCE-ESCAPE-001`）。

checkpoint 保存 task/session/source/contract/config/cause；resume 只接受同一
擁有者 worktree 的匹配 checkpoint，保留 dirty 內容及預算。失配需要人類確認。
時間耗盡後明確「繼續」可透過 `extend --event-id latest` 讀取原生人類事件，
一次增加 20 分鐘；沒有可信事件来源則回報 unsupported，其他阻礙不被解除。

Claude / agy / 原生 Codex 的 Stop 都會檢查無 Git 差異的 active DEBUG task，不論是否安裝 completion gate。
DEBUG gate 故障先針對 task/config 重新載入一次；仍失敗則明確回報 `UNKNOWN／未完成`
與 `agent-ops doctor` 恢復方法，允許非成功停止並保留 task、證據及預算，不無限重試。
有效停止 checkpoint 只允許非成功停止，task 仍 active；allow-stop 不能繞過。
Codex 的一般 completion gate 仍 unsupported；DEBUG 專用 Stop 以原生
`decision: "block"` 與 reason 續跑，不能使用會停止 harness 的 `continue: false`。
已接受的 Stop 結束前景時鐘；opencode Stop unsupported。
只承諾前景對話與持久化進度，不承諾對話關閉後繼續，也不宣稱抵擋同檔案權限攻擊。

完整命令及細節見英文 [Task DEBUG](../../en/guides/task-debug.md)。
