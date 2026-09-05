# 實作拆解

[`RPG_SPEC.md`](RPG_SPEC.md) 的施工順序。每個階段是一個獨立 PR，依序進行，
前一個 merge 後才開始下一個。

拆成多個小 PR 而不是一個大 PR，是因為每個 PR 都要跑一輪 Codex Review 循環：
小 diff 的 review 收斂快、出錯可單獨回退，實際成本低於一個發散的大 PR。

---

## 通用規則

- 分支命名 `feature/rpg-<n>-<slug>`，一個 PR 只做一個階段。
- 每階段結束時 `npm test` 必須全綠。本 repository 無 lint / typecheck / build。
- 每階段都必須維持「現有資料不遺失、App 可正常開啟」。
- 不得留 `TODO` / `FIXME` 代替實作。階段未完成就不送 PR。

---

## PR 1 — 資料層統一與遷移

**目標**：schema v2 落地，legacy 資料完整遷入，UI 行為維持不變。

風險最高的一步，因此獨立且優先。這個 PR 不新增任何使用者可見功能。

範圍：
- 新增 `src/migrate.js`：v1 → v2 轉換，含 §7.2 完整對照表與 `skill-backup-v1` 備份。
- `src/store.js` 改用 `skill-rpg-v2`，管理 `profile` / `cores` / `skills` /
  `goals` / `steps` / `xpLog` / `achievements` / `meta`。
- `src/model.js` 擴充 Step 欄位（`kind`、`xp`、`rewards`、`streakHistory` 等）
  與驗證；`nextStep` 收窄為只看 `main`。
- 承接技能 `sk_<coreId>_general` 於載入時自動補齊。
- `index.html` 內嵌 script 改為透過 store 讀寫，不再直接碰 `localStorage`。

驗收：
- 帶有 legacy 資料的 App 開啟後，技能、XP、核心、任務、目標、筆記全部還在，
  數字與遷移前一致。
- `skill-pwa-v1`、`skill-goals-v1` 仍存在且未被修改。
- 遷移跳過的壞資料筆數有回報，不靜默吞掉。
- 測試涵蓋：完整遷移、缺欄位、壞資料、id 碰撞、重複遷移（第二次不應再跑）。

---

## PR 2 — XP 引擎

**目標**：完成任務自動產生 XP，並留下可回溯的紀錄。

範圍：
- 新增 `src/rpg.js`：等級曲線、`LV_NAMES`、XP 發放與歸屬（§4.2–4.3）、
  屬性與稱號推導。等級公式從 `index.html` 搬出，不修改數值。
- 完成 / 補登 step 時依 `rewards` 或 `kind` 預設發放 XP。
- 所有 XP 變動寫入 `xpLog`（`step` / `manual` / `merge` 三種來源）與 400 天上限。
- 未歸屬 XP 進 `profile.unassignedXP`，提供事後指定核心的方法。
- 手動 `+10/+25/+50/+100` 改走同一條發放路徑。

驗收：
- 完成一個 `main` 步驟，對應技能 XP 增加、核心等級同步變動、`xpLog` 多一筆。
- 重複完成同一個 `daily` 任務在同一天只給一次 XP。
- 合併技能前後總 XP 不變。
- 測試涵蓋：四種 kind 的預設值、多筆 rewards、未歸屬路徑、xpLog 上限與彙總。

---

## PR 3 — 任務模型統一

**目標**：任務頁與目標頁合併成一套 UI，quest 與 step 在畫面上也真正變成同一件事。

範圍：
- 任務頁改為讀統一的 `steps`，篩選條件改用 `kind` 與 `state`。
- 目標頁的步驟清單支援指定 `kind`；`inbox` 指派到目標時轉 `main`。
- `daily` 完成流程改為 §5.1（不進 DONE、記 streak、隔天回到待辦）與 7 天補登。
- `calcStreak` 搬進 `model.js` 並補測試。
- `src/reminders.js` 改讀統一 store，移除對 `state.quests` 的依賴。

驗收：
- 主線步驟仍維持「每個目標同時只有一個下一步」。
- 支線與每日任務不會擋住主線的下一步。
- 到期提醒與 App badge 對統一後的 steps 正常運作。
- 測試涵蓋：kind 對 `nextStep` 的影響、daily 完成與補登、reminders 取數。

---

## PR 4 — 屬性與成就

**目標**：把累積的數字變成看得到的角色成長。

範圍：
- 角色卡：總等級、總 XP、稱號、全域連續天數、成就數。
- 九邊形雷達圖，inline SVG，不引入圖表函式庫。
- 新增 `src/achievements.js`：§6.2 的成就常數表與純函式判定。
- store 於資料變動後 diff 出新解鎖並寫入 `unlockedAt`，以 toast 呈現。
- 成就列表頁（已解鎖 / 未解鎖與條件說明）。

驗收：
- 成就一旦解鎖不會因資料變動被收回。
- 稱號同分時結果穩定，不會每次重繪跳動。
- 雷達圖在 9 個核心都是 Lv1 與差距極大時都不變形。
- 測試涵蓋：每一條成就的觸發與不觸發、稱號推導、屬性推導。

---

## PR 5 — 節奏與回顧

**目標**：讓系統主動提示「該回頭看一下了」。

範圍：
- 每日結算（§5.3）：當天首次開啟顯示前一天摘要，看過後寫入 `meta`。
- 每週回顧（§5.4）：本週成果、待重新決定、待歸屬 XP 整合成同一頁。
- 新增 `src/review.js` 承載彙總邏輯，與現有 `reviewItems` 整合。
- 全域連續天數（§5.2）。

驗收：
- 同一天重複開啟只顯示一次每日結算。
- 每週回顧的週界定為週一、本地時間，跨週切換正確。
- 現有 review 三種情況（反覆順延、長期逾期、停滯目標）行為不變。
- 測試涵蓋：週界邊界、結算去重、全域 streak 中斷與延續。

---

## 完成後

五個階段都 merge 後，`index.html` 應只剩 shell 與樣式，所有邏輯在 `src/`
且有測試覆蓋。此時再評估 backlog（技能衰退、數據儀表板、雲端同步）。
