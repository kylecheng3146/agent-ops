# 本機 advisory 學習

`agent-ops learn` 是主動啟動的一輪實驗，目標是改善驗收條件的情境缺漏辨識。
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
且 probe 不退步，才採用。沒有改善、結果不一致、無效／不足輸出、執行失敗、
候選重複或條件改變，都保留 baseline。這驗證維度分類，不能機械證明每句建議
的語義品質；少量案例的採用屬暫定證據，不能推論寫碼成功率或統計顯著性。

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

本版沒有背景模型工作、新相依套件、跨機器分享、訓練、候選修改評分規則，
或自動修補產品程式碼。
