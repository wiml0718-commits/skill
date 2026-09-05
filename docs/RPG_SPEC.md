# 人生 RPG 升級系統 — 規格

本文件定義把現有 PWA 收斂成單一「人生 RPG 升級系統」的目標、資料模型與規則。
實作拆解與各階段驗收標準見 [`ROADMAP.md`](ROADMAP.md)。

本文件只描述規格，不含程式碼。所有實作 PR 都以本文件為準；與本文件衝突的實作
視為錯誤，應先修規格再改程式。

---

## 1. 現況

目前 repository 內有兩套並存、彼此不通的資料系統。

| | Legacy RPG 層 | Goal / Step 層 |
|---|---|---|
| 位置 | `index.html` 內嵌 `<script>` | `src/model.js`、`src/store.js`、`src/views.js` |
| storage key | `skill-pwa-v1` | `skill-goals-v1` |
| 資料 | `charName`、`cores`、`subSkills`、`quests` | `goals`、`steps` |
| 測試 | 無 | `test/` 三個檔案 |
| 狀態管理 | 全域可變 `state` + `render()` 重繪 | 純函式模型 + store 複本隔離 |

兩者只透過 `window.Goals`、`window.Reminders` 鬆散相連。`src/reminders.js` 會讀
legacy 的 `state.quests` 做到期提醒，除此之外沒有任何資料流。**完成 Step 不會產生
任何 XP**，升級完全靠在技能詳情頁手動按 `+10 / +25 / +50 / +100`。

這是本次改造要解決的根本問題。

---

## 2. 目標與非目標

### 目標

1. **單一資料模型**：legacy 的 `cores` / `subSkills` / `quests` / `notes` 全部遷入
   `src/` 模組化資料層，單一 storage key、版本化 migration、有測試覆蓋。
2. **XP 由行動產生**：完成任務自動換算 XP 並注入對應技能，手動加減保留為補記
   線下練習用。
3. **兩個「任務」概念收斂成一個**：Step 為唯一實體，legacy quest 的 main / side /
   daily 降為 Step 的 `kind` 屬性。
4. **屬性與成就**：不新增屬性維度，直接以現有 9 大核心的等級作為角色屬性，
   新增角色卡、雷達圖、稱號與成就徽章。
5. **節奏與回顧**：強化連續天數、新增每日結算與每週回顧，並與現有 review
   （反覆順延、長期逾期、停滯目標）整合成同一頁。

### 非目標（本輪不做，列入 backlog）

- 技能衰退、逾期懲罰、任務難度評級（「壓力與難度」系統）。
- 統計儀表板、XP 趨勢圖、時間分配分析（「數據與洞察」系統）。本輪只建立
  `xpLog` 這份資料基礎，不做視覺化。
- 雲端同步、帳號、多裝置、社交。資料仍然只存在 `localStorage`。
- 導入 Vite 或前端框架。維持零建置、純 ES module。

---

## 3. 資料模型（schema v2）

storage key：`skill-rpg-v2`。所有實體都是扁平純值物件，轉換一律回傳新物件，
沿用現有 `model.js` 的慣例。

### 3.1 profile

```
{ charName: string, schemaVersion: 2, createdAt: ISO, unassignedXP: number }
```

`unassignedXP` 承接無法歸屬到任何技能的 XP，見 §4.3。

### 3.2 cores（核心技能 = 角色屬性）

```
{ id, name, title, icon, color, order, builtin: boolean }
```

9 個內建核心（`body` / `emotion` / `time` / `think` / `learn` / `comm` /
`social` / `finance` / `lead`）沿用現有定義與配色。使用者自訂核心 id 前綴
`core_`，`builtin: false`，可刪除；內建核心不可刪除，只能改名與換色。

### 3.3 skills（子技能）

```
{ id, coreId, name, type: "active"|"passive", icon, desc, source,
  xp: number, notes: Note[], mergedFrom: string[]|null, createdAt: ISO }
```

`Note` = `{ id, text, date }`。

`mergedFrom` 記錄合併技能的來源技能 id，取代目前只把合併紀錄塞進 notes 第一則
的做法；合併紀錄仍保留在 notes，但來源關係改為結構化欄位。

**每個核心自動擁有一個承接技能** `sk_<coreId>_general`（顯示名「歷練」），
`builtin: true`、不可刪除。它存在的唯一理由見 §4.3。

### 3.4 goals

```
{ id, title, why, status: "active"|"done"|"archived", coreId: string|null }
```

相對現況新增 `coreId`：目標可綁定一個核心，作為其底下步驟的 XP 預設歸屬。

### 3.5 steps（唯一的任務實體）

```
{ id, goalId: string|null, kind: "main"|"side"|"daily"|"inbox",
  title, desc, due: "YYYY-MM-DD"|null, dueTime: "HH:MM"|null,
  order: number, state: StepState, deferCount: number,
  xp: number, rewards: Reward[],
  streakHistory: string[], completedCount: number, lastCompletedDate: string|null,
  archived: boolean, archivedAt: ISO|null,
  createdAt: ISO, completedAt: ISO|null }
```

`Reward` = `{ skillId, xp }`。`StepState` 沿用現有 BuJo 符號
（`•` 待辦、`×` 完成、`>` 順延、`<` 已排程、`–` 筆記、`~` 放棄）。

**`archived` 與 `state` 正交**，不是狀態機的一個值。封存只決定「要不要顯示在
清單裡」，不改變這件事最後是完成還是放棄。legacy 的批次封存會同時留下
`done: true` 與 `archived: true`，把兩者壓進同一個 `state` 欄位必然弄丟其中一種
語意（詳見 §7.2）。`archived: true` 的步驟不出現在待辦與下一步推導，但仍計入
完成數與成就。

`kind` 決定三件事，是本次收斂的核心：

| kind | goalId | 參與「下一步」推導 | 完成後 | 預設 XP |
|---|---|---|---|---|
| `main` | 可為 `null` | 有 `goalId` 時參與 | 進 `×` DONE | 50 |
| `side` | 可選 | 否 | 進 `×` DONE | 20 |
| `daily` | 可選 | 否 | 見 §5.1 | 10 |
| `inbox` | 必為 `null` | 否 | 進 `×` DONE | 5 |

「每個目標同時只有一個下一步」這條核心規則因此收窄為：**只由帶 `goalId` 的
`main` 步驟推導**。支線與每日任務不會擋住主線，也不會被主線遮住。

**`main` 的 `goalId` 允許為 `null`。** legacy quest 沒有目標概念，遷移後既有的
主線任務就是這個形狀（§7.2）。無目標的 `main` 步驟在任務頁以主線呈現、可正常
完成與發放 XP，只是不參與任何目標的下一步推導。改用「遷移時建立一個承接目標」
的做法會把原本平行的主線任務塞進「一次只露一個下一步」的規則裡藏起來，那是行為
退化而不是遷移。回顧頁會列出這些尚未接上目標的主線任務，提示使用者指派。

`inbox` 步驟被指派到某個目標時，自動轉為 `main` 並排到該目標最後（沿用現有
`assignStep` 行為）。

### 3.6 xpLog

```
{ id, date: "YYYY-MM-DD", skillId: string|null, xp: number,
  source: "step"|"manual"|"merge"|"rollup", refId: string|null }
```

XP 變動的唯一事實來源，支撐每日結算、每週回顧與成就判定。

**`skillId` 可為 `null`**，代表這筆 XP 尚未歸屬到任何技能（§4.3）。未歸屬的完成
一樣要留下紀錄，否則每日結算、每週 XP 與全域連續天數都看不到這次完成。事後指定
核心時，是把該筆 `xpLog` 的 `skillId` 補上並同額減少 `profile.unassignedXP`，
不新增紀錄，避免同一次完成被算兩次。

`source: "rollup"` 是壓縮後的月彙總紀錄，`date` 記為該月第一天
（`YYYY-MM-01`），`refId` 為 `null`。它必須是 `source` 正式的一員，否則載入時的
schema 驗證會把自己寫出的彙總資料當成髒資料丟掉。

**體積控制**：單筆約 100 bytes。保留最近 400 天的逐筆紀錄；更舊的資料在載入時
壓縮成每月每技能一筆 rollup。此上限必須在 store 層強制執行，不能只靠 UI。

### 3.7 achievements

```
{ id, unlockedAt: ISO }
```

只儲存已解鎖項目。成就定義本身是常數表，判定是純函式（§6.2），不落地。

### 3.8 meta

```
{ lastDailySummaryDate: string|null, lastWeeklyReviewDate: string|null,
  inboxPeak: number, reviewPeak: number }
```

`inboxPeak` / `reviewPeak` 是收件匣筆數與回顧清單項目數的歷史高水位，由 store 在
每次資料變動後以 `max(舊值, 目前值)` 更新。它們存在的唯一理由是讓 §6.2 的歷史型
成就可判定：「曾經有過幾筆」無法從當下快照回推。

---

## 4. XP 與升級

### 4.1 等級曲線

沿用現有規則，不修改：`LEVEL_XP[i] = 50i² + 50i`，`Lv1–99`，核心 XP 為其底下
所有技能 XP 總和，總等級為 9 個核心等級相加。

沿用現有 `LV_NAMES` 階層名（初學者 → 見習生 → … → 神域）。

### 4.2 XP 來源

完成一個 `main` / `side` / `daily` / `inbox` 步驟時自動發放。發放金額規則：

1. `step.rewards` 有內容 → 依 `rewards` 逐筆發放，可一次加到多個技能。
2. `rewards` 為空 → 發放 `step.xp` 一筆。`step.xp` 在建立時以 `kind` 預設值
   帶入，建立與編輯時都可自行修改。

**不引入難度評級**。任務給多少分由建立者當下決定，系統只提供預設值。

### 4.3 XP 歸屬

`rewards` 為空時，依序決定 XP 加到哪個技能：

1. 步驟所屬 goal 有 `coreId` → 加到該核心的承接技能 `sk_<coreId>_general`。
2. 沒有 goal 或 goal 沒有 `coreId` → 計入 `profile.unassignedXP`，**不計入任何
   核心等級**，並在回顧頁列出待歸屬清單，讓使用者事後指定核心。

第 2 種情況刻意不猜測歸屬。把 XP 隨便塞進某個核心，會讓等級數字失去意義；
明確標示「這些 XP 還沒歸屬」比默默算進去誠實。

未歸屬時**仍要寫入一筆 `skillId: null` 的 `xpLog`**（§3.6）。這筆紀錄承載
「哪一天完成了什麼」，每日結算、每週 XP 與全域連續天數都靠它；只記總額到
`profile.unassignedXP` 會讓那次完成在時間軸上憑空消失。事後指定核心時更新該筆
紀錄的 `skillId`，並同額減少 `unassignedXP`、增加該技能 XP。

承接技能存在的理由：核心 XP 定義為「底下所有技能 XP 總和」。若允許 XP 直接掛在
核心上，就會出現兩條計算路徑，之後每個統計都要處理兩次。統一由技能承接，公式
維持單一。

### 4.4 手動調整

技能詳情頁的 `+10 / +25 / +50 / +100` 保留，但每次調整都寫入 `xpLog`，
`source: "manual"`。這讓「自動累積」與「手動補記」在回顧時可以分開檢視。

XP 不得為負；扣分請以修正紀錄的方式處理，不在本輪範圍內。

### 4.5 合併技能

合併時來源技能的 XP 相加轉入新技能，並寫入一筆 `source: "merge"` 的 `xpLog`，
總 XP 不變。這確保「合併不會平白產生或蒸發等級」。

---

## 5. 節奏與回顧

### 5.1 每日任務與連續天數

`daily` 步驟完成時不進 `×` DONE，而是：

- 將今天日期加入 `streakHistory`（同一天重複完成不重複加入，也不重複給 XP）
- `completedCount += 1`、`lastCompletedDate = 今天`
- `state` 維持 `•` TODO，隔天自然又是待辦

連續天數由 `streakHistory` 當場推導，不落地儲存。沿用現有 `calcStreak` 的邏輯
（從今天往回走，今天尚未完成不算中斷），但搬進 `model.js` 並補上測試。

**補登**：允許把過去 7 天內的日期補進 `streakHistory`，避免忘記打卡直接毀掉
一整條連續紀錄。補登同樣發放 XP，`xpLog.date` 記為被補登的那一天。

### 5.2 全域連續天數

`xpLog` 中有任何紀錄的連續天數，代表「連續多少天有推進任何事」。與單一每日任務
的 streak 分開顯示。

### 5.3 每日結算

當天首次開啟 App 時，若 `meta.lastDailySummaryDate` 不是今天，顯示前一天摘要：
完成項目數、獲得 XP、各 streak 變化、是否有升級。看過後寫入
`lastDailySummaryDate`。

### 5.4 每週回顧

週首為**週一**，以裝置本地時間計算，日界為 `00:00`。回顧頁整合三塊：

1. **本週成果**：總 XP、各核心 XP 增長、完成步驟數、最長 streak。
2. **待重新決定**：沿用現有 `reviewItems`（反覆順延 ≥3 次、逾期 ≥7 天、
   進行中卻沒有下一步的目標）。
3. **待歸屬 XP**：§4.3 第 2 種情況產生的清單。

---

## 6. 屬性與成就

### 6.1 角色卡

- **屬性 = 9 大核心等級**，不新增維度。
- 九邊形雷達圖，以 inline SVG 繪製（維持零建置，不引入圖表函式庫）。
- **角色稱號** = 等級最高核心的階層名 + 核心名，例如「學習能力・宗師」。
  同分時取 `cores` 的 `order` 較前者，讓結果穩定不跳動。
- 總等級、總 XP、全域連續天數、已解鎖成就數。

### 6.2 成就

判定為純函式 `evaluateAchievements(state, today) -> Set<achievementId>`，完全從
`goals` / `steps` / `skills` / `xpLog` / `meta` 推導。store 負責 diff 出新解鎖項目
並寫入 `unlockedAt`。成就一旦解鎖不會因資料變動而收回。

**歷史型條件一律靠 `meta` 的高水位判定，不靠當下快照。** 「收件匣曾有 ≥5 筆」
這種條件無法從清空後的狀態回推：逐筆清到最後只看得到 0，重新載入 App 更沒有
記憶體可依靠。因此 `inboxPeak` / `reviewPeak`（§3.8）由 store 持續更新，成就判定
只讀它們。沒有這兩個欄位，下表最後兩條成就永遠不會解鎖。

初版成就清單（實作時以此為準，不自行增減）：

| id | 條件 |
|---|---|
| `first_step` | 完成第一個步驟 |
| `steps_10` / `steps_50` / `steps_100` | 累計完成 10 / 50 / 100 個步驟 |
| `streak_7` / `streak_30` | 任一每日任務連續 7 / 30 天 |
| `core_lv10` / `core_lv25` / `core_lv50` | 任一核心達 Lv10 / 25 / 50 |
| `total_lv50` / `total_lv100` | 總等級達 50 / 100 |
| `all_cores_lv5` | 9 個內建核心全部達 Lv5 |
| `first_merge` | 首次合併技能 |
| `inbox_zero` | 目前收件匣為 0 筆，且 `meta.inboxPeak >= 5` |
| `review_clear` | 目前回顧清單為 0 項，且 `meta.reviewPeak >= 3` |

解鎖時以現有 toast 呈現。是否額外發系統通知列為待確認（§9）。

---

## 7. 遷移

### 7.1 原則

遷移只跑一次，且**不刪除任何舊資料**。

1. 載入時若 `skill-rpg-v2` 存在 → 直接使用，不再讀舊 key。
2. 不存在 → 讀 `skill-pwa-v1` 與 `skill-goals-v1`，合併轉換後寫入 v2。
3. 轉換前先把兩份原始 JSON 原樣寫入 `skill-backup-v1`（若已存在則不覆寫）。
4. **舊的兩個 key 保留不動**，作為最後的回退路徑。

沿用現有 `sanitize` 的容錯原則：壞掉的單筆資料跳過，不讓一筆髒資料毀掉整包。
但遷移必須另外回報跳過筆數，不能靜默吞掉——遷移時的靜默丟失是無法察覺的資料
損失。

### 7.2 對照表

| 來源 | 目標 | 備註 |
|---|---|---|
| `state.charName` | `profile.charName` | |
| `state.cores` 或內建 `CORES` | `cores` | 未存過 cores 者用內建預設 |
| `state.subSkills[]` | `skills[]` | id 數字 → `sk_<n>`；`notes` 原樣保留 |
| `state.quests[]` | `steps[]` | 見下 |
| `skill-goals-v1.goals[]` | `goals[]` | `coreId` 補 `null` |
| `skill-goals-v1.steps[]` | `steps[]` | `goalId` 為 null → `kind: "inbox"`，否則 `main` |

quest → step 的欄位對照：

| quest | step |
|---|---|
| `id`（數字） | `id` = `q_<n>` |
| `type` | `kind`（`main`/`side`/`daily` 直接對應） |
| `title` / `desc` | 同名 |
| `dueDate` / `dueTime` | `due` / `dueTime` |
| `done: true` | `state: "×"` |
| `rewards[]` | `rewards[]`，`skillId` 依技能 id 對照表改寫 |
| `rewardSkillId` / `rewardXP` | 僅在 `rewards` 為空時轉為單筆 reward，`skillId` 同樣改寫 |
| `streakHistory` / `completedCount` / `lastCompletedDate` | 同名 |
| `archived` / `archivedAt` | 同名，**不寫入 `state`** |
| — | `goalId: null`（quest 原本不屬於任何目標，含 `main`） |
| — | `order`：依 `createdAt` 排序後給序 |

以下三點是遷移最容易出錯的地方，實作時必須逐一驗證。

**技能 id 對照表必須同時套用到 rewards。** `subSkills[].id` 是數字並改寫為
`sk_<n>`，而 `rewards[].skillId` 與 `rewardSkillId` 正是指向這些數字 id
（`index.html:1682-1684`、`1723-1728`）。若把 rewards 原樣搬過去，既有任務的獎勵
會全部指向不存在的技能，完成時發不出 XP，而且不會報錯，只是靜默無效。遷移必須
先建好舊→新技能 id 對照表，再用同一份表改寫兩種 reward 格式。查不到對應技能的
reward 直接丟棄該筆 reward（不是丟掉整個 step），並計入遷移回報。

**`done` 與 `archived` 會同時為真。** `archiveAllDone`（`index.html:1809-1816`）
會把所有已完成任務標成 `archived: true` 而保留 `done: true`。因此不能把兩者映射
到互斥的 `state` 值：選 `~` 會把完成誤記成放棄、破壞完成數與成就，選 `×` 則遺失
封存語意。v2 用獨立的 `archived` 欄位承接（§3.5），`state` 只由 `done` 決定。

**legacy `main` quest 沒有 `goalId`。** `saveQuest`（`index.html:1726-1730`）建立
的 quest 不含任何目標欄位，所以遷移後的 `main` 步驟 `goalId` 為 `null`。這正是
§3.5 允許 `main` 的 `goalId` 為 `null` 的原因；若沿用「`main` 必須有 goalId」的
寫法，這些既有主線任務會在載入驗證時被當成壞資料整批跳過。

**id 前綴是必要的**：legacy quest id 與 subSkill id 都是 `Date.now()` 產生的
數字，同一毫秒建立就會碰撞，且與 Goal/Step 層的 `s_*` id 空間混在一起。
前綴 `q_` / `sk_` 同時解決碰撞與 `model.js` 的 `ID_PATTERN` 相容性。

遷移不追溯產生 `xpLog`：既有 XP 直接落在 `skills[].xp` 上作為起始值，
`xpLog` 從遷移日起算。歷史逐筆紀錄已經不存在，硬造出來就是假資料。

### 7.3 匯出 / 匯入

匯出格式升級為 v2 單一檔案（含 `profile` / `cores` / `skills` / `goals` /
`steps` / `xpLog` / `achievements` / `meta`）。匯入時同時接受 v1 格式，走與
§7.1 相同的轉換路徑。

---

## 8. 影響範圍

| 檔案 | 變動 |
|---|---|
| `src/model.js` | 擴充：`kind`、`xp`、`rewards`、`streakHistory`、`nextStep` 收窄為只看 `main` |
| `src/store.js` | schema v2、承接技能、`xpLog` 寫入與上限、成就 diff |
| `src/migrate.js` | 新增：v1 → v2 轉換與備份 |
| `src/rpg.js` | 新增：等級曲線、XP 發放與歸屬、稱號、屬性推導 |
| `src/achievements.js` | 新增：成就常數表與判定純函式 |
| `src/review.js` | 新增：每日結算、每週回顧彙總 |
| `src/reminders.js` | 改為讀統一 store，不再讀 `state.quests` |
| `src/views.js` | 擴充為主要 UI 層 |
| `index.html` | 內嵌 script 逐步搬出，最終只留 shell 與樣式 |
| `test/` | 對應新增，每個新模組都要有測試 |

---

## 9. 待確認問題

以下項目已在規格中寫入預設決定，實作前若不同意請提出：

1. **每日任務補登期限**：暫定 7 天內可補登。太長會讓 streak 失去意義，太短則
   一次忘記就毀掉紀錄。
2. **未歸屬 XP**：暫定不計入等級並在回顧頁提示，而非自動塞入某個核心（§4.3）。
3. **週首與日界**：暫定週一為週首、`00:00` 為日界、使用裝置本地時間。
4. **`xpLog` 保留策略**：暫定 400 天逐筆，更舊者壓成每月彙總（§3.6）。
5. **成就通知**：暫定只用 toast，不發系統通知，避免與到期提醒互相干擾。

---

## 10. 相關文件

- [`ROADMAP.md`](ROADMAP.md)：分階段 PR 拆解與各階段驗收標準
- [`../CLAUDE.md`](../CLAUDE.md)：本 repository 的開發與 Review 規則
