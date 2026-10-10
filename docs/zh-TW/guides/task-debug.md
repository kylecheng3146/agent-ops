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

預算與輪數屬於整個原始 root，revision、child、session 不重設。新 session 重送同一個 active issue 文字時，會接回原本的 root（或 resume 持有它的 worktree），不會另開新預算。已確認或已否決的假設不能換 id、用相同陳述與方法重開；請帶新的鑑別證據重開原假設。
受控調查、驗證與取得 slot 後的 review 計時；review 排隊不計時。
Claude、Codex 與 agy 都使用可信 native session lifecycle，在 `UserPromptSubmit`
或原生 session 開始前景時鐘，並在 idle `Stop` 結束。因此該輪的 Agent 推理、
工具與修改都計入，停止回合之間的使用者等待不計入。Codex Stop 對 completion
gate 仍是 advisory，但已接受的 idle Stop 會作為可信時鐘邊界。opencode 沒有支援
的前景 lifecycle，不可宣稱完整的 active-time 預算。
中斷且沒有封存結果的操作，必須等持久化 process identity 證實程序已死亡後，
才封存 UNKNOWN environment receipt；這段經過時間仍會保留，不會退還不明時間。
測試材料修改不算修復輪；兩輪停滯需要一次實質策略切換，再兩輪停滯停止。

checkpoint 保存 task/session/source/contract/config/cause；resume 只接受同一
擁有者 worktree 的匹配 checkpoint，保留 dirty 內容及預算。失配需要人類確認。
時間耗盡後明確「繼續」可透過 `extend --event-id latest` 讀取原生人類事件，
一次增加 20 分鐘；沒有可信事件来源則回報 unsupported，其他阻礙不被解除。

Claude / agy 的 Stop 都會檢查無 Git 差異的 active DEBUG task，不論是否安裝 completion gate；未啟用 gate 時只執行這項檢查，而檢查本身失敗時維持 advisory。
有效停止 checkpoint 只允許非成功停止，task 仍 active；allow-stop 不能繞過。
Codex Stop 對 completion 是 advisory，但仍會結束前景時鐘；opencode Stop
unsupported，不會自動啟用不支援的 gate。
只承諾前景對話與持久化進度，不承諾對話關閉後繼續，也不宣稱抵擋同檔案權限攻擊。

完整命令及細節見英文 [Task DEBUG](../../en/guides/task-debug.md)。
