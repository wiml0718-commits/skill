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
4. **屬性與成就**：不新增屬性維度，直接以現有核心技能的等級作為角色屬性，
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
`core_`，`builtin: false`。

**`builtin` 只標示「隨 App 內建」，不代表不可刪除。** 現行 `deleteCore`
（`index.html:1183-1199`）對內建核心沒有任何保護，刪除時連同其底下的技能一併移除，
既有使用者的資料因此可能只有 5 個核心。v2 沿用這個行為，不在遷移時把使用者刪掉的
核心補回來——那是推翻使用者已經做過的決定。

因此**核心數量是變動的**，可能少於 9（刪過），也可能多於 9（自訂）。§4.1 的總等級
與 §6.1 的雷達圖都必須依目前實際核心數計算，不得寫死 9。

**刪除核心是一筆交易，必須同時清掉所有指向它的引用**，否則會留下指向不存在實體的
懸空參照。一次刪除要做完這些事：

1. 移除該核心底下的所有技能，含承接技能 `sk_<coreId>_general`。
2. 所有 `coreId` 指向該核心的 goal，其 `coreId` 設為 `null`。
3. 所有 `rewards[].skillId` 指向被移除技能的條目從 `rewards` 陣列中刪除。整個
   `rewards` 因此變空的步驟，之後完成時走 §4.3 的 fallback。

即使如此，§4.3 第 1 步仍必須防禦：**承接技能不存在時視同未歸屬**，走
`profile.unassignedXP` 那條路，不得建立技能或靜默丟棄 XP。交易再嚴謹也擋不住
匯入的舊備份帶進不一致的引用。

### 3.3 skills（子技能）

```
{ id, coreId, name, type: "active"|"passive", icon, desc, source,
  xp: number, notes: Note[], mergedFrom: string[]|null,
  builtin: boolean, createdAt: ISO|null }
```

`Note` = `{ id, text, date }`。

`builtin` 是正式欄位，不是外掛標記。一般技能與所有遷移進來的技能都是 `false`，
只有承接技能是 `true`。若把它留在 schema 外，normalizer 一過就會被抹掉，刪除
流程再也分不出承接技能與一般技能。

`createdAt` 可為 `null`：legacy `subSkills` 沒有這個欄位，遷移時沒有真實來源。
填入遷移當下的時間會是編造的建立時間，寧可留 `null`。

`mergedFrom` 記錄合併技能的來源技能 id，取代目前只把合併紀錄塞進 notes 第一則
的做法；合併紀錄仍保留在 notes，但來源關係改為結構化欄位。

**每個核心自動擁有一個承接技能** `sk_<coreId>_general`（顯示名「歷練」），
`builtin: true`，不可單獨刪除，但會隨其核心一併移除。它存在的唯一理由見 §4.3。

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
  createdAt: ISO|null, completedAt: ISO|null }
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

**`main` / `side` / `daily` 的歸屬是儲存前的必要條件**：必須有 `rewards`，或所屬
goal 已綁定 `coreId`，否則不允許儲存（§4.3）。`inbox` 免除此限制，但完成或指派前
必須補上。

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

**`skillId: null` 的紀錄永遠不進 rollup**，不論多舊，直到歸屬完成為止。彙總會把
同月多筆壓成一筆並清掉 `refId`，未歸屬紀錄一旦被壓，待歸屬清單就再也說不出這筆
XP 來自哪個步驟，同月的多筆也無法分派到不同核心。歸屬完成後該筆才回到一般的
壓縮規則。這批紀錄數量本來就受使用者主動歸屬的行為約束，不會無限成長。

### 3.7 achievements

```
{ id, unlockedAt: ISO }
```

只儲存已解鎖項目。成就定義本身是常數表，判定是純函式（§6.2），不落地。

### 3.8 meta

```
{ lastDailySummaryDate: string|null, lastWeeklyReviewDate: string|null,
  inboxPeak: number, reviewPeak: number, activeDays: string[] }
```

`activeDays` 是有活動的日期（升序、去重），全域連續天數由它推導，理由見 §5.2。

`inboxPeak` / `reviewPeak` 是收件匣筆數與回顧清單項目數的歷史高水位，由 store 在
每次資料變動後以 `max(舊值, 目前值)` 更新。它們存在的唯一理由是讓 §6.2 的歷史型
成就可判定：「曾經有過幾筆」無法從當下快照回推。

---

## 4. XP 與升級

### 4.1 等級曲線

沿用現有規則，不修改：`LEVEL_XP[i] = 50i² + 50i`，`Lv1–99`，核心 XP 為其底下
所有技能 XP 總和。

**總等級 = 目前所有核心的等級相加**，含使用者自訂核心，不假設剛好 9 個（§3.2）。

沿用現有 `LV_NAMES` 階層名（初學者 → 見習生 → … → 神域）。

### 4.2 XP 來源

完成一個 `main` / `side` / `daily` / `inbox` 步驟時自動發放。發放金額規則：

1. `step.rewards` 有內容 → 依 `rewards` 逐筆發放，可一次加到多個技能。
2. `rewards` 為空 → 發放 `step.xp` 一筆。`step.xp` 在建立時以 `kind` 預設值
   帶入，建立與編輯時都可自行修改。

**不引入難度評級**。任務給多少分由建立者當下決定，系統只提供預設值。

### 4.3 XP 歸屬

**歸屬在建立時就必須確定，不留待事後。** 一個步驟只要會發放 XP，就必須能回答
「加到哪個技能」，否則不允許儲存。

歸屬來源依序判定：

1. `step.rewards` 有內容 → 依 `rewards` 發放。
2. `rewards` 為空，但所屬 goal 有 `coreId` → 加到該核心的承接技能
   `sk_<coreId>_general`。

`main` / `side` / `daily` 三種 kind **建立與編輯時都必須滿足其中一條**：要嘛指定
`rewards`，要嘛所屬 goal 已綁定 `coreId`。兩者皆無時 UI 阻擋儲存並提示選擇，不寫入
一筆之後才要補救的資料。

**收件匣是唯一的例外，而且例外只到完成前為止。** `inbox` 的用途就是快速捕捉，
建立時要求指定歸屬會毀掉這個功能。因此 `inbox` 步驟建立時不要求歸屬，但
**完成或指派到目標時必須指定**：完成時彈出歸屬選擇（預設帶入上次選過的核心），
指派到目標時沿用該目標的 `coreId`。沒選就不完成，這個摩擦只發生在真的要記分的
那一刻。

### 4.3.1 未歸屬 XP：只處理歷史，不產生新的

前門關上之後，`profile.unassignedXP` 與 `skillId: null` 的 `xpLog` **不會再由正常
操作產生**。它們仍然保留，因為三種既有情況擋不掉：

1. **遷移進來的 legacy quest**：`rewardSkillId` 為 null 的舊任務，沒有歸屬可補。
2. **刪除核心後 `rewards` 被清空的步驟**（§3.2），且其 goal 的 `coreId` 也已清成
   `null`。
3. **匯入的舊備份**帶進不一致或缺漏的引用。

這三種情況完成時：計入 `profile.unassignedXP`，**不計入任何核心等級**，寫入一筆
`skillId: null` 的 `xpLog`，並列進回顧頁的待歸屬清單。事後指定核心時更新該筆紀錄
的 `skillId`，同額減少 `unassignedXP`、增加該技能 XP，不新增紀錄。

不猜測歸屬的理由不變：把 XP 隨便塞進某個核心會讓等級數字失去意義，明確標示
「還沒歸屬」比默默算進去誠實。差別在於現在這是**收尾用的容器**，而不是日常會走到
的路徑；待歸屬清單清完就永遠是空的。

承接技能存在的理由：核心 XP 定義為「底下所有技能 XP 總和」。若允許 XP 直接掛在
核心上，就會出現兩條計算路徑，之後每個統計都要處理兩次。統一由技能承接，公式
維持單一。

### 4.4 手動調整

技能詳情頁的 `+10 / +25 / +50 / +100` 保留，但每次調整都寫入 `xpLog`，
`source: "manual"`。這讓「自動累積」與「手動補記」在回顧時可以分開檢視。

**向下修正必須保留。** legacy 的技能編輯頁有一個可直接輸入 XP 的數字欄位
（`index.html:1087`、`1169`：`d.xp = Math.max(0, parseInt(...))`），使用者本來就能把
技能 XP 調低。v2 若只剩加分按鈕就是功能退化，誤加的 XP 也沒有任何合法途徑修正。

因此：

- `xpLog.xp` **可以是負數**，`source` 仍為 `manual`。
- 直接輸入目標 XP 值時，寫入的是**差額**（新值減舊值）為一筆 manual 紀錄，不是
  新值本身。這樣 `xpLog` 的加總永遠等於目前 XP。
- **技能 XP 不得低於 0**。若扣減量超過目前 XP，實際扣到 0 為止，並以**實際發生的
  變動量**記錄，不記使用者輸入的數字。沿用 legacy 的 `Math.max(0, ...)` 行為。
- 每日與每週成果照實反映負向紀錄，不隱藏。修正就是修正，藏起來只會讓數字對不上。

### 4.5 合併技能

合併時來源技能的 XP 相加轉入新技能，總 XP 不變。這確保「合併不會平白產生或
蒸發等級」。

合併會寫入一筆 `source: "merge"` 的 `xpLog` 作為軌跡，但**該筆的 `xp` 必須為
`0`**，且 §5.2 的全域連續天數與 §5.3 / §5.4 的 XP 加總**一律排除
`source: "merge"`**。合併只是搬移既有 XP，若把新技能收到的總額寫進這筆紀錄，
直接加總 `xpLog` 的每日與每週成果就會把整批舊 XP 當成當天新得，數字瞬間膨脹。
兩道防線都要有：金額為零讓誤加總也無害，統計排除讓實作寫錯金額時仍然正確。

---

## 5. 節奏與回顧

### 5.0 日界與週界

**日界為凌晨 `04:00`，週首為週一，一律使用裝置本地時間。**

凌晨兩三點完成的事屬於前一天。日界設在 `00:00` 會讓晚睡的人在跨過午夜的那一刻
莫名其妙斷掉 streak，明明還沒睡就被判定成新的一天什麼都沒做。

實作上定義一個**邏輯日**函式：取本地時間，先減 4 小時，再取其 `YYYY-MM-DD`。

- 這個函式是**唯一**的「今天」來源。`xpLog.date`、`streakHistory`、
  `meta.activeDays`、每日結算、每週回顧全部走它，不得各自呼叫 `new Date()` 取日期。
- 現有 `src/reminders.js` 的 `todayISO()` 直接取本地日期，沒有 4 小時偏移，
  必須一併改掉，否則到期提醒與 streak 會在凌晨 0-4 點對不上。
- **到期日 `due` 的比較同樣走邏輯日**：凌晨三點看到的「今天到期」應該還是昨天那批。

週界則是邏輯日再取週一為起點，不另外偏移。

### 5.1 每日任務與連續天數

`daily` 步驟完成時不進 `×` DONE，而是：

- 將今天（邏輯日，§5.0）加入 `streakHistory`（同一天重複完成不重複加入，也不
  重複給 XP）
- `completedCount += 1`、`lastCompletedDate = 今天`
- `state` 維持 `•` TODO，隔天自然又是待辦

連續天數由 `streakHistory` 當場推導，不落地儲存。沿用現有 `calcStreak` 的邏輯
（從今天往回走，今天尚未完成不算中斷），但搬進 `model.js` 並補上測試。

**補登**：允許把過去 **3 天**內的日期補進 `streakHistory`，避免忘記打卡直接毀掉
一整條連續紀錄。補登同樣發放 XP，`xpLog.date` 記為被補登的那一天。

期限刻意壓短：補登窗口愈長，streak 就愈接近「事後補出來的數字」而不是「當天真的
做了」。3 天足以救回忘記按的那一次，不足以讓一週的空白被追認。

### 5.2 全域連續天數

「連續多少天有推進任何事」。與單一每日任務的 streak 分開顯示。

**由 `meta.activeDays` 推導，不由 `xpLog` 推導。** store 在寫入任何 `source` 不是
`merge` 的 `xpLog` 時，同步把該筆的 `date` 併入 `activeDays`（升序、去重）。補登
併入的是被補登的那一天，與 §5.1 一致。

不能從 `xpLog` 算，是因為 §3.6 的月彙總會把 400 天前的逐日紀錄壓成月初一筆，月內
其他日期就此消失，仍在持續中的長 streak 會在 400 天附近被截斷或算錯。`activeDays`
每天只佔一個日期字串，十年不到 40 KB，因此不做壓縮。

### 5.3 每日結算

當天（邏輯日，§5.0）首次開啟 App 時，若 `meta.lastDailySummaryDate` 不是今天，
顯示前一天摘要：
完成項目數、獲得 XP、各 streak 變化、是否有升級。看過後寫入
`lastDailySummaryDate`。

### 5.4 每週回顧

週首為**週一**，日界為凌晨 `04:00`，皆依 §5.0 的邏輯日計算。回顧頁整合三塊：

1. **本週成果**：總 XP、各核心 XP 增長、完成步驟數、最長 streak。
2. **待重新決定**：沿用現有 `reviewItems`（反覆順延 ≥3 次、逾期 ≥7 天、
   進行中卻沒有下一步的目標）。
3. **待歸屬 XP**：§4.3.1 的清單。正常操作不再產生新項目，清完就是空的。

---

## 6. 屬性與成就

### 6.1 角色卡

- **屬性 = 核心等級**，不新增維度。
- 雷達圖為 N 邊形，N 等於目前的核心數（§3.2：可能少於或多於 9）。以 inline SVG
  繪製，維持零建置，不引入圖表函式庫。N < 3 無法構成多邊形，改用長條列表呈現。
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
| `all_cores_lv5` | 目前所有核心（含自訂）皆達 Lv5，且核心數 ≥ 5 |
| `first_merge` | 存在任一技能 `mergedFrom !== null` |
| `inbox_zero` | 收件匣待處理數為 0，且 `meta.inboxPeak >= 5` |
| `review_clear` | 目前回顧清單為 0 項，且 `meta.reviewPeak >= 3` |

**收件匣待處理數的定義**：`kind === "inbox"`、`archived !== true`，且
`isActionable(state)` 為真（即 `•` TODO、`<` SCHEDULED、`>` DEFERRED 三種）。
`meta.inboxPeak` 與 `inbox_zero` 必須用同一個 predicate，實作時共用同一個函式。

用 `isActionable` 而不是「排除完成與放棄」，是為了跟現有模型一致：`model.js` 把
`–` NOTE 與完成、放棄同樣視為不可行動的終點，`goalProgress` 也把筆記排除在
remaining 之外。若只排除完成與放棄，使用者把五筆收件匣項目整理成筆記之後，畫面上
待辦已清空，`inbox_zero` 卻還是解不開。

現有 `inboxSteps`（`src/model.js`）是「所有 `goalId` 為 null 的 step，含已完成」，
不能直接拿來計數：inbox 完成後 `goalId` 仍是 `null`，用那個集合算，完成五筆之後
數量還是五，`inbox_zero` 只能靠刪除或重新指派才解得開，與成就的本意相反。

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

**id 前綴解決的是命名空間，不是碰撞。** legacy quest id 與 subSkill id 都是
`Date.now()` 產生的數字，與 Goal/Step 層的 `s_*` id 空間混在一起，因此需要
`q_` / `sk_` 前綴來隔離，同時滿足 `model.js` 的 `ID_PATTERN`。

但前綴無法處理**同類之間**的碰撞：兩筆 quest 若帶著相同的數字 id（同毫秒建立，
或匯入的備份檔本身就重複），加了前綴仍然都是 `q_<n>`，去重時會靜默丟掉其中一筆，
reward 對照也會指向錯的技能。因此遷移必須：

1. 依序處理每一筆，遇到已用過的目標 id 就改為 `q_<n>_2`、`q_<n>_3`，直到唯一。
2. 把「舊 id + 型別 + 出現序」到新 id 的對應寫進遷移期間的對照表，reward 與
   `goalId` 等所有引用一律查表改寫，不得各自重算。
3. 產生過後綴的筆數計入遷移回報。

**引用改寫採 first-match。** 對照表的鍵含出現序，但 `rewards[].skillId` 與
`rewardSkillId` 只帶舊數字 id，沒有出現序可用。因此遷移要另外維護一份
「舊 id → 該型別第一筆的新 id」的引用查詢表，所有 reward 都查這一份。這與 legacy
執行路徑一致：`index.html:1443`、`1544`、`1645` 都用 `find()` 取第一筆，所以舊
資料在碰撞情況下的實際語意本來就是「指向第一筆」。沿用同一規則不會改變任何既有
行為；若改指向後綴筆，反而會把 XP 發到使用者從沒看過的那個技能上。

去重只能用在真正的重複資料上，不能拿來掩蓋 id 生成不唯一。

遷移不追溯產生 `xpLog`：既有 XP 直接落在 `skills[].xp` 上作為起始值，
`xpLog` 從遷移日起算。歷史逐筆紀錄已經不存在，硬造出來就是假資料。

### 7.3 新欄位的預設值

上面的對照表只講「舊欄位搬到哪」。但 v2 有一批欄位在 legacy 資料裡根本不存在
（`index.html:361-385` 的 cores 沒有 `order` 與 `builtin`，subSkills 沒有
`createdAt` 與 `mergedFrom`，Goal/Step 層也沒有本規格新增的多數 Step 欄位）。
PR 1 要依 v2 模型驗證，所以每一個新欄位都必須有明定的預設值，否則一般備份就會
產生非法紀錄，嚴格 sanitize 時整批消失。

| 實體 | 欄位 | 遷移時的值 |
|---|---|---|
| profile | `schemaVersion` | `2` |
| profile | `createdAt` | 遷移執行時間 |
| profile | `unassignedXP` | `0` |
| cores | `order` | 依來源陣列的索引，從 `0` 起 |
| cores | `builtin` | id 屬於 9 個內建核心則 `true`，否則 `false` |
| skills | `builtin` | `false`（承接技能由 store 另行建立，`true`） |
| skills | `mergedFrom` | notes 中有合併紀錄則 `[]`，否則 `null`（見下） |
| skills | `createdAt` | `null`（無真實來源，不編造） |
| skills | `desc` / `icon` / `source` | 缺漏時為空字串 |
| skills | `notes` | 缺漏時為 `[]` |
| goals | `coreId` | `null` |
| steps | `xp` | 依 `kind` 的預設值（§3.5） |
| steps | `rewards` | quest 帶入，Goal/Step 來源為 `[]` |
| steps | `deferCount` | 沿用既有值，缺漏為 `0` |
| steps | `streakHistory` | `daily` 沿用既有值，其餘為 `[]` |
| steps | `completedCount` | 沿用既有值，缺漏為 `0` |
| steps | `lastCompletedDate` | 沿用既有值，缺漏為 `null` |
| steps | `archived` / `archivedAt` | quest 沿用既有值，**缺漏補 `false` / `null`**；Goal/Step 來源為 `false` / `null` |
| steps | `desc` / `dueTime` | 缺漏時為空字串 / `null` |
| steps | `createdAt` | quest 沿用既有值；Goal/Step 來源為 `null` |
| steps | `completedAt` | 沿用既有值，缺漏為 `null`（**不以遷移時間頂替**） |
| xpLog | 全部 | `[]`（§7.2 末段：不追溯造紀錄） |
| achievements | 全部 | `[]`，遷移後第一次判定即可解鎖既有成績 |
| meta | `lastDailySummaryDate` / `lastWeeklyReviewDate` | `null` |
| meta | `inboxPeak` / `reviewPeak` | 遷移完成後的當下值 |
| meta | `activeDays` | 所有 legacy `daily` quest `streakHistory` 的聯集（見下） |

兩個原則貫穿整張表：**缺欄位補中性值，缺時間點補 `null`**。把遷移時間填進
`createdAt` 或 `completedAt` 會產生看起來合理、實際上是編造的歷史，之後所有
以時間為軸的統計都會被這批假時間污染，而且再也分不出哪些是真的。

「缺漏補值」對 `archived` / `archivedAt` 特別重要：`saveQuest`
（`index.html:1726-1731`）建立的一般任務根本不會寫入這兩個欄位，只有封存過的才有。
若照字面「沿用既有值」，絕大多數從未封存的 legacy quest 會拿到 `undefined`，在
嚴格驗證下整批被跳過。

**`activeDays` 要回填而不是清空**：`xpLog` 確實沒有歷史可追溯，但 legacy 的
`daily` quest 把每次打卡日期存在 `streakHistory` 裡，那是真實發生過的活動日期，
不是推測出來的。遷移時取所有 daily quest `streakHistory` 的聯集（去重、升序）填入
`activeDays`。若清成空陣列，一個連續打卡 30 天的使用者遷移後全域連續天數會立刻
歸零，而證據明明還在資料裡。

這與「不編造 `createdAt`」不衝突：那裡是沒有來源所以留空，這裡是有明確來源所以
保留。差別在於資料存不存在，不在於填不填。

**舊合併紀錄的辨識**：`confirmMerge`（`index.html:985-992`）只在合併後技能的 notes
第一則留下文字紀錄，開頭固定為 `⚗ 合併自：`，沒有任何結構化欄位。遷移時掃描每個
技能的 notes，只要有一則以這個字串開頭，就把 `mergedFrom` 設為 `[]`——空陣列代表
「曾經合併過，但來源技能已不可考」，與從未合併的 `null` 區分。`first_merge` 因此
改以 `mergedFrom !== null` 判定，既有使用者的合併紀錄才不會在 v2 消失。這是文字
比對的啟發式判斷，會誤判自行輸入相同開頭的筆記，但代價只是一個成就早解鎖，
且這是舊資料裡唯一存在的訊號。

### 7.4 匯出 / 匯入

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

前三項原本是預設值，**已經人工確認並改成以下決定**，規格內文已同步：

1. **每日任務補登期限**：**3 天**（原暫定 7 天）。見 §5.1。
2. **XP 歸屬**：**建立任務時就強制指定**，不留未歸屬（原暫定進待歸屬清單）。
   收件匣為唯一例外，且延後到完成或指派時才要求。`unassignedXP` 降級為只處理
   遷移與邊界情況的容器。見 §4.3、§4.3.1。
3. **日界**：**凌晨 `04:00`**（原暫定 `00:00`），週首維持週一。見 §5.0。

以下兩項仍為預設值，實作前若不同意請提出：

4. **`xpLog` 保留策略**：暫定 400 天逐筆，更舊者壓成每月彙總（§3.6）。
5. **成就通知**：暫定只用 toast，不發系統通知，避免與到期提醒互相干擾。

---

## 10. 相關文件

- [`ROADMAP.md`](ROADMAP.md)：分階段 PR 拆解與各階段驗收標準
- [`../CLAUDE.md`](../CLAUDE.md)：本 repository 的開發與 Review 規則
