# 外觀主題

深色是預設；淺色是同一組 token 的另一套值。目標是「換一套配色」，不是「做兩
套畫面」：任何規則都不該知道現在是哪一種主題。

## 1. 偏好與模式

偏好存在 `planner.config.theme`，三個值：

| 值 | 意思 |
| --- | --- |
| `auto` | 跟隨 `prefers-color-scheme`（預設） |
| `light` | 一律淺色 |
| `dark` | 一律深色 |

`src/theme.js` 的 `resolveTheme(pref, systemPrefersLight)` 把偏好併上系統偏好，
算出**實際模式**（只會是 `light` 或 `dark`），寫進 `<html data-theme>`。
`data-theme` 不會留 `auto`：CSS 只要分兩種情況，也不必和 `prefers-color-scheme`
的 fallback 規則爭特異性。

偏好是純外觀，壞掉的值不該讓整份 `config` 退回預設值——那會連 `anchorDate`
一起失去。`model.normalizeTheme()` 因此不丟例外，把三種壞法各自擋掉（缺席、
空值、型別偽裝），一律退回 `auto`。改主題也不算動到 anchor，不需要 `force`。

## 2. Token

`index.html` 的 `:root` 定義深色，`:root[data-theme="light"]` 覆寫同一組名字。
兩邊的名字必須完全一致，`test/theme.test.js` 會比對。

- 結構色：`--bg` `--bg2` `--bg3` `--bg-nav` `--bg-sheet`、`--border`
  `--border2` `--border3`、`--text` `--text2` `--text3` `--muted` `--muted2`、
  `--scrim` `--on-accent` `--danger-bg` `--warn-bg` `--focus-wash`
- 語意色：`--blue` `--amber` `--cyan` `--purple` `--red` `--green` `--orange`
  `--pink`
- 透明度階層：`--blue-22` 等於舊的 `#4a9eff22`，由基色用 `color-mix()` 推導，
  只定義一次，基色換了色階自動跟著換

`color-mix()` 需要 Chrome 111／Safari 16.2／Firefox 113 以上。

**alpha 不能接在自訂屬性的引用後面**——那不是合法的 CSS，整條宣告會被瀏覽器
丟掉（背景與邊框整片消失）。要疊透明度就引用對應的色階 token。渲染時才決定
色階的地方，存的是 token 名而不是色值，由呼叫端自己組出引用。
`test/theme.test.js` 會掃這兩種寫法。

## 3. 使用者資料的顏色

核心顏色與新增核心的色票是**資料**，不能換成 token。深色主題挑的飽和色直接
放到淺色背景上會看不見（`#22d3ee` 對 `#f5f2ea` 只有 1.6:1），所以淺色模式下由
`theme.shade()` 在線性空間等比壓暗到亮度 0.158——對比 4.51:1，過 WCAG AA，
色相與彩度都保留。

渲染端的單一入口是 `index.html` 的 `cssColor()`（`Goals.themeColor()`）。
資料本身不動：`model.normalizeColor()` 仍然只做安全判定，換主題不會改寫存檔。

## 4. 開機不閃

模組載入是非同步的，等 `views.js` 才設 `data-theme` 的話，偏好淺色的人會先看到
一閃的深色畫面。`<head>` 裡有一段同步腳本先把主題套上。

那段腳本重複了 store 的 key 與 `planner.config.theme` 的路徑——是刻意的，
`test/theme.test.js` 會比對兩邊沒有漂移。

## 5. 驗證紀錄

`test/theme.test.js`（15 項）與 `test/offline.test.js`（6 項）跑靜態與邏輯層。
畫面與離線行為另外用無頭 Chromium 驗過，結果如下。

**A22 淺色主題 — PASS**

| 情境 | 結果 |
| --- | --- |
| 偏好 dark | `data-theme=dark`，`theme-color` `#050b12` |
| 偏好 light | `data-theme=light`，`theme-color` `#f5f2ea` |
| 偏好 auto ＋ 系統淺色 | `data-theme=light` |
| 偏好 auto ＋ 系統深色 | `data-theme=dark` |

技能樹／統計／任務／檔案四頁在兩種主題下都截圖確認過可讀，含雷達圖與核心
顏色。

**A23 離線重開 — PASS**

service worker 接管後（`navigator.serviceWorker.controller` 為 true、
`skill-tree-v14` 內 15 個項目），切成離線再重新載入：

```
{"online":false,"theme":"light","goals":1,"steps":3,"tabs":5,
 "chars":697,"stillLoading":false}
```

離線狀態下仍可切換主題並寫入存檔。

**已知取捨**：Google Fonts（Cinzel／Share Tech Mono）不在快取清單裡，離線重開
會掉回系統等寬字。字型檔是跨網域資源，`addAll` 收不進來，自架又會讓 repo 變
大，本輪不做。`test/offline.test.js` 把這個取捨寫成斷言，改動時會被擋下來。

**未驗**：手機實機。桌面瀏覽器只模擬到 390×844。
