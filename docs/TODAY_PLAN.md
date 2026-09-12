# 今日主線與四日班表 — 規格（schema v3）

本輪交付「今日主線、四日輪班與逐日出勤覆寫、實際／預計連續出勤、可調時間、
進度與成果保存」。既有任務、XP、核心、成就、回顧與 PWA 行為不變。

相關文件：[`RPG_SPEC.md`](RPG_SPEC.md)（v2 資料模型與 XP）、
[`ROADMAP.md`](ROADMAP.md)。

---

## 1. 日期

- 沿用 `rpg.logicalToday()`：裝置本地凌晨 04:00 換日。ISO 時間戳記只用來記錄
  提交時間。
- 日期鍵是有效的 `YYYY-MM-DD`；日期加減一律走 `model.shiftDate()` /
  `model.daysBetween()`，不用時間戳加 24 小時。
- 出勤記錄歸到使用者所選的班次日期。跨午夜的同一班不拆成兩個出勤日；本輪不從
  時間推算班次或工時。
- 未來只可編輯預定安排、時間與主線草稿，不能開始、提交成果、確認實際出勤或
  發 XP。

## 2. 四日循環與覆寫

`phase = ((daysBetween(anchorDate, day) + anchorPhase) % 4 + 4) % 4`

| phase | 原定班別 | 預設出勤安排 | 預設目標綁定 |
| --- | --- | --- | --- |
| 0 | 工作日 1 | work | 目前 AI 產品 |
| 1 | 工作日 2 | work | 當前影片 |
| 2 | 休假日 1 | rest | 目前 AI 產品 |
| 3 | 休假日 2 | rest | 當前影片 |

- 目標綁定儲存 `goalId`，不從標題猜類別。可以只綁一個。
- 預定安排 = 當日覆寫值（若有）或原定班表；實際出勤 = 使用者另外確認的值。
- `work`、`overtime` 都計一個出勤日；`rest` 中斷連續。加班仍只計一天。
- 改「明天加班」只改明天的覆寫，不移動 anchor。
- 不依「日期已過」自動把安排轉成已出勤。不確定的歷史留空。
- 已有每日紀錄時改 anchor 會被擋下並回報影響，要改必須明確帶 `force`。

## 3. 連續出勤

- **實際**：從今天已確認的實際出勤往回走，`work` / `overtime` 加一；遇 `rest`
  代表邊界已知；遇缺資料停止並標成「至少 N」。今天尚未確認時只報到昨天為止，
  不拿安排補一個假的實際值。
- **未來預計**：已知連續段接上「今日尚未確認的安排 + 未來安排」，遇 `rest`
  中斷。預估至少涵蓋未來 7 日，畫面標出查詢邊界；到邊界還沒休息就標成持續中。
- 當天安排與實際不一致時，當天決策用實際值，未來用安排。

## 4. 時間、精力與收工

| 依此順序判斷 | 建議一段主線時間 |
| --- | --- |
| 可用時間為 0，或使用者選收工 | 0 分鐘 |
| 加班、這段出勤已到第 5 天以上、或精力低 | 5 分鐘 |
| 實際休息／休息安排，且精力高 | 120 分鐘 |
| 其他情況 | 25 分鐘 |

這是第一輪的產品預設，尚未經個人 Alpha 校準，不是醫療判斷或工作負荷測量。

- 精力是使用者自選的 low / mid / high。未填以 mid 計算，但畫面標示「未填」。
- `availableMinutes` 是上限，選項 0、5、15、25、60、120，也可自訂 0–120。
- 預設 `plannedMinutes = min(availableMinutes, suggestedMinutes)`。使用者可手動
  選 0–availableMinutes；5 分鐘是建議，不強制禁止加班日自選 15／25。
- 調低可用時間會把已選時間縮到上限並顯示變更；改精力或班表不動已選時間。
- 收工只保存當日模式：保留主線與進度，不完成 step、不發 XP、不寫 activity。
  重新選正數時間並開始就回到 `active`。
- 沒做的時間不累積到隔天，也不建立逾期欠債。

## 5. 唯一主線與成果

選擇順序：

1. 今日已有有效、已接受的 focus → 恢復，不因重開或改精力換題。
2. 否則接續最近未完成的已接受主線。
3. 否則用當日 phase 綁定的目標。
4. 都沒有 → 顯示對應空態並連到既有的新增／編輯介面，不生成假任務。

- 步驟一律取該目標的 `model.nextStep()`，不改主線排序。
- 上次接受的 step 已在別頁完成時，顯示已完成並提供同目標的新下一步，等待接受。
- 換主線保留舊 step 的已保存進度。一次只接受一個 focus。

保存與 XP：

- **記錄進度**：需要非空白的進度文字與下一動作；不改 `step.state`、不給 XP。
- **完整完成**：需勾選完成條件已達成並填寫非空白成果文字。成果連結選填，只收
  絕對的 http／https URL。成果標示「使用者自述」。
- 成果、step 狀態、XP 與成就在同一次寫入中一起落地；沿用既有的 rewards 與
  `main/side/daily/inbox` 預設 50／20／10／5，不硬編碼固定值。
- 已完成狀態的重複提交不重發獎勵；換一個 `requestId` 也一樣。

## 6. 資料契約

根 `version` 與 `profile.schemaVersion` 同為 3，儲存 key 仍是 `skill-rpg-v2`
（key 名稱不是 schema 判斷依據）。新增根 `planner`，內部版本 1。

```json
{
  "version": 3,
  "planner": {
    "version": 1,
    "config": {
      "anchorDate": null,
      "anchorPhase": null,
      "goalBindings": {"ai": null, "video": null},
      "theme": "auto"
    },
    "days": {},
    "stepDetails": {},
    "entries": []
  }
}
```

| 欄位 | 契約 |
| --- | --- |
| `days[date].attendancePlan` | null／work／overtime／rest；null 代表無覆寫 |
| `days[date].attendanceActual` | null／work／overtime／rest；未來只允許 null |
| `days[date].energy` | null／low／mid／high |
| `days[date].availableMinutes` | null 或 0–120 整數 |
| `days[date].plannedMinutes` | null 或 0–availableMinutes 整數；0 與 null 不同 |
| `days[date].mode` | active／recovery；預設 active，收工為 recovery |
| `days[date].focus` | null 或 `{goalId, stepId, acceptedAt}` |
| `days[date].changeReason` | 選填文字，最多 300 字元 |
| `days[date].updatedAt` | ISO instant |
| `config.theme` | auto／light／dark；壞值退回 auto，不丟例外（見 [`THEME.md`](THEME.md)） |
| `stepDetails[stepId]` | `{firstAction, minimumAction, completionCriteria}`，各最多 1,000 字元 |
| `entries[]` | `{id, requestId, day, goalId, stepId, outcome, note, nextAction, url, createdAt}` |

`outcome` 為 progress／complete；`note` 最多 4,000 字元、`nextAction` 最多
1,000、`url` 最多 2,048。progress 要求 note 與 nextAction；complete 要求 note
與當次確認。缺 day 記錄代表未知，不產生假資料；原定班別與連續數字都由函式推導。

## 7. 遷移與儲存

- v2 → v3 只補空 planner 與版本標記，保留既有 ID、XP、自訂核心（含空核心
  列表）、任務順序、完成狀態、成就與回顧資料。v1 先走既有遷移，再升 v3。
- 先把升級前的原樣寫進 `skill-backup-v2`，留不成就不寫升級結果。已是 v3 時
  不重複遷移。
- v3 的存檔缺 `planner`，或 `planner` 在的但 `config`／`days`／`stepDetails`／
  `entries` 任一段缺席或型別不對，一律計入損失並走損壞保護；v2 沒有 planner
  是正常的，不計入。
- 版本高於支援版本或 planner 內部版本未知：保留原始資料、回報不支援、禁止
  覆蓋，也不 reset 成空白。同一套版本判定用在載入、匯入試算與匯入本身——
  只擋載入會讓同一份備份從匯入這條路被降級並抹掉不認得的欄位。
- 匯出含完整 planner；可匯入 v2／v3。舊版 App 不保證讀得懂新 planner。
- `persist()` 回傳寫入結果，失敗不得出現「已保存／已完成」成功態。
- **所有**會改到資料的操作都走候選狀態：先在複本上套用，在同一份序列化狀態中
  包含變更、成果、XP 與成就，寫入成功才採用。失敗時記憶體整個回復，並以
  `WriteError` 告知沒有保存——回傳正常值卻沒寫進去，等於讓畫面顯示一個重開就
  消失的成功。今日計畫的操作改回傳 `{ok, reason}` 讓表單就地顯示並保留草稿。
- 寫入前比對儲存內容與本 session 最後一次讀／寫的內容，不一致時回報 conflict
  並轉為唯讀，不以舊快照覆蓋其他分頁的資料。比對套用在每一條寫入路徑上，不是
  只有今日計畫：目標、步驟、XP 與 legacy 快照同樣是整份覆寫。本輪不宣稱支援
  多裝置或跨分頁同步。

## 8. 模組

| 模組 | 責任 |
| --- | --- |
| `src/today-plan.js` | 純函式：班別、實際與預計出勤、時間建議、focus 推導 |
| `src/today-view.js` | 今日頁、班表編輯、主線選擇、成果表單與錯誤狀態 |
| `src/model.js` | planner 實體的建構與驗證 |
| `src/store.js` | 遷移、候選狀態寫入、防重、成果與 XP 的單次落地 |
| `index.html`、`sw.js` | 任務頁的「今日／全部任務」切換、快取新模組 |
