# 本機 advisory 學習

本機學習會自動收錄合格交付，並在條件成立時實驗驗收條件的情境缺漏辨識；
既有手動 `agent-ops learn` 一輪實驗仍可使用。
模型權重不變，使用既有 CLI 訂閱額度；每輪最多兩個候選、一個組合版本、
十二次額外 CLI 呼叫。CLI 次數不等於 provider 模型呼叫數。只記錄實際回報的
token／成本；美元估算不當成訂閱帳單，未知用量不補零。

從已信任、乾淨的 checkout 執行。先提交獨立標註的 suite JSON，至少包含
兩個 probe、兩個不同的 holdout 任務。格式見 `tests/learning/scenarios.json`；
這份合成案例本身不代表真實任務已改善。每個 snapshot 必須有 originalGoal、
2–5 個 criteria 與 included surface；expected 使用既有五個 scenario 維度。
來源任務的目標、diff 或其他證據不可包含保留案例或答案；提案／組合 prompt
若出現 holdout ID 或目標，會被拒絕。

```sh
agent-ops learn run --receipt <本機-finish-receipt.json> --suite tests/learning/scenarios.json --model <明確版本的模型-ID>
agent-ops learn list
agent-ops learn show <trial-digest>
agent-ops learn replay <trial-digest>
agent-ops learn retire --reason '目前建議已不適用'
agent-ops learn rollback <曾採用的-version-digest> --reason '回復先前經驗'
```

`--target` 只能選已設定的 independent-review target；多任務 receipt 用
`--task` 指定。`--no-execute` 不呼叫模型，保存 NOT_RUN。來源必須是完成交付、
由 Git note 綁定且 contract-bound 的 sealed receipt；一般成功任務無須宣告
escape-of。收集保留任務、diff、verify 與兩輪 review 來源，字串先去除秘密。

baseline、候選與組合版本各在新空工作區執行兩次。模型、effort、唯讀權限、
環境 digest 與任務輸入固定；每個任務只收到符合 surface 的策略。提案看到來源
證據與 baseline 的 probe 行為；組合看到各候選的 probe 執行差異，不收到
holdout 結果或 expected。組合後必須再驗證。候選無法編輯評估器、suite、
測試、trust、sandbox 或完成規則。

固定評分計算漏報與誤報，每個辨識結果必須對應一項具體 advisory 建議，其他
未分類建議也算誤報。兩次重跑都必須讓 holdout 漏報嚴格減少、不增加誤報，
且 probe 不退步，才採用。每個 probe／holdout 案例也必須保留原本已辨識的
正確維度，不新增誤報維度，也不增加未分類建議的數量；其他案例的改善不能
抵銷退步。組合若只有策略／路徑排序變動，視為與 baseline 相同，直接保留
baseline，不再花額度評估。沒有改善、結果不一致、無效／不足輸出、執行失敗、
候選重複或條件改變，都保留 baseline。這驗證維度分類，不能機械證明每句建議
的語義品質；少量案例的採用屬暫定證據，不能推論寫碼成功率或統計顯著性。

策略也必須實際適用於評估案例：新增不相干範圍的策略不算介入。案例收到
相同 baseline／組合輸入，分數卻改變時，屬於無法支持的執行差異，保留 baseline。

重複候選與重疊的策略範圍會被拒絕，範圍限確切路徑或 `directory/**`。
既有採用項目維持不變並累積，最多 16 項；自動改寫／刪除舊項目，留待能保留
其原始回歸案例時擴充。組合可修訂本輪新提案。失效時明確 retire 或 rollback
並留下原因；不按日期自動刪除。過時的 baseline 不能覆蓋並行採用的新版本。

紀錄位於 Git common directory 的 `agent-ops/learning/`，同 repository
跨 session／worktree 共用。trials、versions、uses 以內容 digest 保存；
active pointer 與歷史由鎖及 generation 比對保護。trial 包含 prompt、schema、
輸出、分數、模型／權限／環境綁定、耗時與已回報用量。`replay` 重新評分已存
輸出並檢查序列與條件，不呼叫 provider，也不保證新隨機執行逐字相同。

下一個相關任務的 advisory attempt 會載入採用版本。實際引用時，建議的 reason
標示 `[experience:<id>@<revision>]` 並說明用途。uses 區分已載入內容與
**模型自報用途**；引用不能單獨證明因果改善。既有 attempt 保留當時快照，
與 escape lesson 的處理一致，不因 library 更新自動再花額度；明確 rerun
才使用目前版本。

各階段只寫私有狀態：收集先讀完成交付；實驗後先存 immutable trial／version，
才切換 active；回復只改 pointer／歷史；advisory 保存自己的快照與引用紀錄。
不修改來源指紋、task criteria、verify 證據或正式 review attestation。
原有 task → commit → verify → 兩輪獨立 review → finish 仍須完成。

本版沒有永久 daemon、cron、新相依套件、跨 repository／雲端分享、訓練、候選修改評分規則，
或自動修補產品程式碼。

## 自動歷史收錄與條件式實驗

每次合格的 final sealed、contract-bound 完成交付（包含一般成功與修復）以完整
父子任務樹為一筆歷史案例，共用 review 僅保留引用，不逐子任務複製。
收錄為 advisory、fail-open、冪等且不呼叫模型；一般 CLI 使用會補收漏失 receipt。
receipt 無效或遺失時，不會因 finish 成功而取得資格。案例保存去秘密後的最終
目標、criteria、verify／review 結論、受限路徑及確切來源；來源 task、receipt
與正式證據保持不變。未採用的原始建議不會轉成可重用規則。

新的路徑相關 criteria advisory 最多載入三筆案例，context 預算 12,000 bytes。
這是**歷史參考，轉用尚未驗證**，不是 verify 證據或已實驗採用的經驗。
無符合案例就不加入歷史。記錄確切引用與模型自報用途，歷史更新不重跑舊快照。
同一次既有 data-only 呼叫可選擇提出來源連結候選，空清單合法；不增加提案 CLI
次數，但既有呼叫增加受限的輸入／輸出 token。候選作者與組合階段不接收 holdout
答案或結果；讀取來源的正式 reviewer 不負責產生這些提案。

自動實驗必須明確完成[設定指南](configuration.md#自動學習註冊)的 repository
註冊；預設不安裝 live suite／model。設定遺失、無效、未確認、洩漏或不適用時，
候選保持 waiting 並顯示原因，不呼叫實驗模型。一般 CLI 檢查持久待辦，同一
repository 最多一個背景實驗，不等待模型工作；單純匯入歷史不花實驗額度。
明確的 `learn` 命令只補收歷史，不啟動其他背景實驗；因此 list、show、replay、
`run --no-execute` 與控制命令不會因待辦而額外花費。候選綁定完整作者快照，
包括未引用的已載入歷史與當前任務；作者紀錄缺失、變更或未綁定時保持 waiting。

每次嘗試固定不可變的候選、suite、baseline、模型／settings 與 evaluator，
在隔離 data-only 工作區執行。啟動與採用前重驗 trust、policy、原生授權、
來源及 library generation；保留明確拒絕，不在模型呼叫期間持有 task／proof 鎖。
既有候選跳過提案生成；baseline 已無嚴格 holdout 改善空間時，提前停止候選／
組合呼叫。重複配對、holdout、逐案例、誤報、組合及過時 baseline 閘門維持不變。
僅通過且授權仍有效才自動採用，其他結果保留 baseline；不自動改寫／刪除舊經驗。

日界為 **00:00 UTC**，每 repository 每 UTC 日最多**兩次自動嘗試**，每輪最多
**十二次額外 CLI 呼叫**，啟動／呼叫失敗也計入。並行 CLI 以原子預留避免重複
啟動／花費。CLI 次數不等於 provider request 數、固定 token 或金額；既有 advisory
內產生候選不算額外呼叫。候選內容／scope 加上不可變評估條件、模型、evaluator
及 baseline library 版本去重；成功、失敗、無改善或跨日均不自動重跑相同條件。
基礎設施失敗留下持久診斷後停止，不自動重試或重複取樣直到 PASS。條件有實質
改變或明確手動 retry 才能再次符合資格，仍保留歷史與當日計數。

`agent-ops learn list --json` 顯示 waiting／running／adopted／retained／failed、
原因碼、quota 與實際預留次數。`agent-ops learn retry <job-id>` 將終止的自動工作
排入下一次一般 CLI 檢查，不繞過授權、適用性或日額度。既有
run／list／show／replay／retire／rollback 與舊資料仍可讀。
確定性 fake／model-spy 測試僅證明控制流程、隔離及花費上限；實際付費生產品質
改善尚未測量，也不承諾改善。task → commit → verify → 兩輪獨立 review → finish
正式證據閘門仍為必要。
