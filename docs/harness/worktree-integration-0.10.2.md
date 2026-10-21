# 0.10.2 worktree 整合紀錄

使用者指定以下七個 worktree 全部納入 0.10.2。整合驗收沿用
`task-b39eb5ae-6cbc-4166-85d9-8287edbfea91`，保留既有耗用、歷史與不限時授權；
下表的原 task 不另造成功狀態。

| Worktree | 原 task | 來源與整合方式 |
|---|---|---|
| `run-40719b9f27704318-0c358036` | `task-acd9de0d-0151-4525-9aaf-834f9e0d5cae` | 合併 `8da94e8`：run 不設總時間上限、舊 run 人工 resume 才升級、相同授權有限續期與歷史 assessment 保留。 |
| `run-40719b9f27704318-c8ccd098` | `task-05929dfd-278a-48eb-9b1b-463cb314ea64` | `5aa1dab` 已包含於上述分支：封存 proof／receipt 的清理恢復、原始錯誤與修復指引、不重複失敗清理。 |
| `session-01a143ba` | `task-7c3d8e59-a0f5-4257-be17-824b0b37947f` | 套用 `4ce82e3`、`eaa0254`：大型 surface 與 revision history 以完整 digest-bound manifest 傳遞，保留小型與 legacy 封包。 |
| `session-01a154bd` | `task-b39eb5ae-6cbc-4166-85d9-8287edbfea91` | 整合 native resume 歷史快照修復、單次人工恢復權限、安全邊界與 agy 240 秒沉默中止修復。 |
| `session-10ed1568` | `task-1ffbb106-6d01-479b-b29a-a5a243d3dc59` | 原先 17 個未提交檔逐位元比對備份後保存為 `292dd95`；逐項轉為下列正式行為。 |
| `session-1657a580` | `task-a479ace2-6033-4a6d-9190-4c856625d4db` | 合併 `8cd199f`：共用 generic runner 的完整 check 聯集與精確 redCheckIds 規則。 |
| `session-d072b65f` | `task-bedabeb4-ef17-424d-a989-2773db87130c` | Escape Loop R2 草稿 `e70e5c8` 已經由 `a5124fd` 的 `worktree-escape-r2` 交付；保留 main 後續修復，將原分支歷史併入，不回退成舊草稿。交付證據在 `refs/notes/agent-ops`。 |

## 未提交原型逐項對照

- `commands/review.ts`、`review/{packet,runner}.ts`、兩語 review 規格、
  `packet.test.ts`、`surface-checks.mjs`：由已驗證的大型完整 manifest 修復承接。
- `args.ts`、`commands/run.ts`、`owned-run-step.ts`、`run-deps.ts`、
  `run-setup-entry.ts`、`run/policy.ts`、`run/service.ts`：由 P0-A/B 承接。
  無上限統一以 `limitMs: null` 表示，原型的 `0` 與 30 天假上限不再另立一套；
  legacy 耗用保留，只有人工 resume 升級，仍遵守單次 timeout 與真正拒絕。
- `run/scheduler.ts`、`run/supervisor.ts`、`run-entry.ts`：
  先停止並確認 coordinator 程序死亡，再讓 child 使用唯一 slot；
  child 交付後沿用原 worker／task／native session，以新 generation 恢復 coordinator。
  native start 也以原子檢查防止超額啟動。每次 heartbeat 前重讀 worker 狀態。
- 舊 request 的 generation 檢查仍先於 done-cache lookup，避免重播舊權限。
  genuine denial、no-progress、產品失敗與不匹配的身份不因 resume 被洗掉。

## 保全與驗收

原七個 HEAD、完整 Git 歷史、staged／unstaged／完整 patch 與任務 metadata
已保存於主 checkout 私有的 `.agent-ops/state/worktree-cleanup-20261020/`；
`worktrees.bundle` 通過 `git bundle verify`。原型三份 patch 在提交前與備份逐位元相同。

整合後候選必須通過 `agent-ops verify --task`、兩輪 fresh independent review，
再由主 checkout 執行 `agent-ops worktree finish`。單一原 worktree 的舊 PASS
不代表整合候選已通過，也不代表原 run 其餘尚未實作的 task 已完成。

回歸涵蓋 82 個 startup checks：原生恢復與新限制邊界、真正拒絕、封存清理、
不限時 run、有限授權續期、串行 native worker，以及大型 review 封包。
套件版本與 lockfile 必須同為 `0.10.2`，並通過 build 與 package check。
