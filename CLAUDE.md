# CLAUDE.md

本文件定義 Claude Code 在本 repository 的開發規則。
其他 AI Agent（含擔任 reviewer 的 Codex）在本 repo 工作時應一併遵守；
Codex Review 也以本文件作為審查依據。

## 分支規則

- **不得直接修改 `main`**。所有變更都必須透過 Pull Request 進行。
- 每個任務建立獨立 branch，命名需反映任務內容（`feature/xxx`、`fix/xxx`、
  `docs/xxx`）。
- 不得在同一個 branch 上混雜多個不相關的任務。

## 開始工作前

- 修改前必須先理解 repository 的現有結構、慣例與相關程式碼，不得憑空假設。
- 若任務描述不清楚或與現有架構衝突，應先釐清而非自行猜測。

## 開發規則

- 優先產出小型、可審查的 commits。
- commit 訊息 1-2 行，清楚說明變更內容。
- 不得新增超出任務需求的功能、抽象或重構。

## 測試與檢查

- 完成修改後，必須執行 repository 中可用的檢查。本 repository 的指令：
  - lint：`無`
  - typecheck：`無`
  - test：`npm test`
  - build：`無`
- **不得假裝測試成功**。無法執行、失敗或環境不支援時，必須在 PR 誠實說明。
- 不得以「之後再處理」為由略過已知會失敗的測試。

## 禁止事項

- 不得留下 `TODO` / `FIXME` 代替實作。
- 不得提交 secrets、API keys、憑證或其他機敏資訊。
- 不得為了讓檢查通過而略過或停用安全檢查、測試或 CI 步驟。

## 完成工作後

- 完成任務後必須建立 Pull Request，不得自行 merge 到 `main`。
- PR 說明必須包含：修改內容、測試結果、已知限制。

## Codex Review 循環

### 觸發與等待

- 不依賴 Codex Automatic Review。建立 PR 後必須立即留言 `@codex review`
  主動觸發，並記錄當下的 head commit SHA 與留言時間，作為**本輪的兩個座標**
  （本輪待審 commit、本輪觸發點）。
- 觸發後必須等待結果，不得在結果出來前逕自進行下一步或視為已完成。
- **等待期間不得高頻輪詢**：以 PR 活動訂閱（事件喚醒）為主；保險用的定時
  檢查間隔不得短於 6 小時。此下限只約束等待中（PENDING）的備援輪詢，不含
  下方終止觀察期。狀態沒有變化時不要產生輸出，也不要在 PR 留言回報「仍在
  等待」。
- 查詢時只取本輪觸發點之後的新項目，使用最小輸出與分頁，不重抓 PR 說明
  全文與完整 diff。

### 讀取結果：三種來源缺一不可

必須同時檢查，只查其中一種不得視為已完整取得結果：

1. PR reviews（整體審查結論）
2. inline review comments / review threads（特定檔案與行的意見，有
   resolved／unresolved 狀態）
3. PR conversation comments（一般留言串）

### 本輪範圍

一項意見要算「本輪」，必須同時符合：

1. **commit 相符**：其 commit metadata 等於本輪待審 commit。conversation
   comment 沒有 commit metadata，改以內文自行標註的 `Reviewed commit:`
   SHA 比對。
2. **時間相符**：建立時間嚴格晚於本輪觸發點。時間戳記只精確到秒，相等時
   保守視為不相符，繼續等待。

不符合者一律視為過期，不得當作對最新變更的回應。

### 完成訊號

- **該輪回報有問題時**：完成訊號**只能是**正式 PR review 物件。
- **該輪回報 clean 時**：可以是正式 PR review，**或**內文標註了本輪待審
  commit 的 conversation comment（Codex 回報沒問題時經常只送這種）。

### Codex 的送達順序（實測）

Codex 回報有問題時，會**先送一則含 finding 摘要的 conversation comment，
約 1–2 分鐘後才送出正式 PR review**，且正式 review 可能包含預告留言完全
沒提到的其他 inline 意見。因此：

- 收到帶 finding 的 conversation comment 時，**不得**因為單次查詢
  `get_reviews` 為空就判定「本輪不會有正式 review」。
- **push 之前必須重新查詢一次三種來源**。一旦 head 前進，之後才送達的正式
  review 會因 commit 不符被判為過期，其中只出現在 inline 的問題會被靜默
  丟棄。
- 正式 review 明顯超出正常延遲仍未出現時，**不得自行把預告留言升格為完整
  結果**：在 PR 誠實說明卡在等待，並以 `AskUserQuestion` 交回人工。

### Fix

- 逐項判斷每則意見：同意才修正；不同意必須在 PR 說明理由，不得逕自忽略或
  盲目照做。回覆過的 inline thread 應標記 resolved。
- 本輪所有意見都處理完之後才觸發下一輪，不得每處理完一項就個別重新觸發。

### Retest 與重新觸發

- **有實際檔案變更（含文件、設定）才需要 Retest 與 push**。
- **Retest 範圍依本輪變更的檔案決定**：
  - 程式碼、測試或建置／設定檔有變更 → 執行完整的 lint、typecheck、test、
    build。
  - 只變更文件（`*.md`）→ 不執行上述檢查（它們不涵蓋 Markdown），改為確認
    文件交叉引用正確，並在 PR 的 Testing 區塊誠實註明。
- 本輪完全沒有檔案變更（全部不同意）時，**仍必須在說明理由後重新留言
  `@codex review`**，否則舊意見會因 head commit 未變而讓循環卡死。不得為此
  建立空 commit。

### 終止條件

取得對應本輪、明確回報沒有 actionable／major issues 的 Codex 回應後：

- 完成訊號是**正式 PR review** → 直接標記 ready for human approval。
- 完成訊號是 **conversation comment** → 先經過觀察期：自訊號送達起至少
  30 分鐘、期間額外查詢至少 2 次、兩次間隔不短於 10 分鐘，且**至少一次查詢
  必須落在 30 分鐘界線之後**。全部保持 clean 才可標記，達到下限即結束，
  不得無限延長。觀察期的查詢不受 6 小時下限限制。

### 停損與收工

- **循環停損**：同一個 PR 已完成 5 輪 Review（結果已送達並判讀）仍未收斂
  時，停止自動循環，在 PR 說明目前狀態，並以 `AskUserQuestion` 交回人工。
  尚未收到結果的那一輪不計入。
- **PR merged 或 closed 後立即收工**：停止等待、取消訂閱與已排定的定時檢查。
- 無論 Review 結果如何，**Claude 都不得自行 merge**；最終 merge 必須經過
  人工核准。

## Output Discipline

- No narration before or after tool calls.
- Do not echo file contents, terminal output, GitHub API responses, JSON, or
  review comments unless required to diagnose a failure.
- For successful commands, report only the final status.
- Summarize external code reviews into BLOCKING / P1 / P2 / BACKLOG.
- Commit messages: 1-2 lines only.
- After completing a task, report only: Changed / Tests: PASS or FAIL /
  Blocking issues / PR status.
- Skip explanations unless explicitly asked.
