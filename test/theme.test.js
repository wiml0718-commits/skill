// 外觀主題：偏好解析、資料色的亮度壓制、儲存契約，以及 index.html 的 token
// 與開機腳本沒有跟程式碼漂移。對照 docs/THEME.md。
import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {createStore} from "../src/store.js";
import * as m from "../src/model.js";
import * as theme from "../src/theme.js";

const root = new URL("../", import.meta.url);
const html = readFileSync(fileURLToPath(new URL("index.html", root)), "utf8");

function backend(){
  const map = new Map();
  return {getItem: k => (map.has(k) ? map.get(k) : null),
          setItem: (k, v) => {map.set(k, String(v));}};
}

// ── 偏好解析 ────────────────────────────────────────────────────────────────
test("resolveTheme：明確指定的偏好蓋過系統，auto 才看系統", () => {
  assert.equal(theme.resolveTheme("light", false), "light");
  assert.equal(theme.resolveTheme("light", true), "light");
  assert.equal(theme.resolveTheme("dark", true), "dark");
  assert.equal(theme.resolveTheme("auto", true), "light");
  assert.equal(theme.resolveTheme("auto", false), "dark");
});

test("normalizeTheme：缺席、空值、型別偽裝都退回 auto，不丟例外", () => {
  for(const bad of [undefined, null, "", [], {}, 0, 1, true, "Light", "LIGHT", "auto "]){
    assert.equal(m.normalizeTheme(bad), "auto", `${JSON.stringify(bad)} 應該退回 auto`);
  }
  assert.equal(m.normalizeTheme("light"), "light");
  assert.equal(m.normalizeTheme("dark"), "dark");
});

test("resolveTheme 對壞掉的偏好一樣退回 auto 的行為", () => {
  assert.equal(theme.resolveTheme(["light"], true), "light");   // 走 auto → 系統淺色
  assert.equal(theme.resolveTheme(["light"], false), "dark");
});

test("applyTheme 寫進去的一律是已解析的 light/dark", () => {
  const attrs = {};
  const root = {setAttribute: (k, v) => {attrs[k] = v;}};
  assert.equal(theme.applyTheme(root, "auto", true), "light");
  assert.equal(attrs["data-theme"], "light");
  assert.equal(theme.applyTheme(root, "dark", true), "dark");
  assert.equal(attrs["data-theme"], "dark");
});

test("systemPrefersLight / watchSystemTheme 在沒有 matchMedia 時不炸", () => {
  assert.equal(theme.systemPrefersLight(undefined), false);
  assert.equal(theme.systemPrefersLight({}), false);
  assert.equal(typeof theme.watchSystemTheme({}, () => {}), "function");
  theme.watchSystemTheme({}, () => {})();   // 退回的解除函式要能呼叫
});

// ── 資料色的亮度壓制 ────────────────────────────────────────────────────────
function contrast(a, b){
  const la = theme.relativeLuminance(a), lb = theme.relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

// 預設九大核心 + 新增核心時的色票。淺色主題下這些都會變成小字的顏色。
const DATA_COLORS = ["#ef4444", "#22d3ee", "#a855f7", "#6366f1", "#f59e0b", "#ec4899",
                     "#10b981", "#84cc16", "#f97316", "#3b82f6", "#e879f9", "#facc15"];

// 淺色主題所有會當背景的表面。資料色與語意色都可能落在其中任何一個上面，
// 所以對比要對每一個都成立，不是只對頁面底色。
function lightSurfaces(){
  const block = blockAfter(':root[data-theme="light"]{');
  return ["bg", "bg2", "bg3", "bg-nav", "bg-sheet"]
    .map(k => block.match(new RegExp(`--${k}:(#[0-9a-f]{6});`))[1]);
}

test("shade：深色模式原樣退回，淺色模式在每一種淺色表面上都過 4.5:1", () => {
  const surfaces = lightSurfaces();
  assert.ok(surfaces.includes(theme.LIGHT_SURFACE), "基準表面要真的是淺色 token 之一");
  for(const c of DATA_COLORS){
    assert.equal(theme.shade(c, "dark"), c);
    const light = theme.shade(c, "light");
    assert.match(light, /^#[0-9a-f]{6}$/);
    for(const bg of surfaces){
      assert.ok(contrast(light, bg) >= 4.45,
        `${c} → ${light} 對 ${bg} 只有 ${contrast(light, bg).toFixed(2)}:1`);
    }
  }
});

test("淺色的語意色與文字色在最深的表面上也要過 4.5:1", () => {
  // 這些是寫死的 token，不會經過 shade()，但用途一樣是文字，所以同一條線。
  const block = blockAfter(':root[data-theme="light"]{');
  const keys = ["blue", "amber", "cyan", "purple", "red", "green", "orange", "pink",
                "text", "text2", "text3", "muted", "muted2"];
  const bad = [];
  for(const k of keys){
    const v = block.match(new RegExp(`--${k}:(#[0-9a-f]{6});`))[1];
    for(const bg of lightSurfaces()){
      const r = contrast(v, bg);
      if(r < 4.45) bad.push(`--${k} ${v} on ${bg} = ${r.toFixed(2)}`);
    }
  }
  assert.deepEqual(bad, [], bad.join(" / "));
});

test("shade：本來就夠暗的顏色不再壓，壞格式原樣退回", () => {
  assert.equal(theme.shade("#000000", "light"), "#000000");
  assert.equal(theme.shade("#102030", "light"), "#102030");
  for(const bad of ["#fff", "red", "", null, undefined, 123, ["#ffffff"]]){
    assert.equal(theme.shade(bad, "light"), bad);
  }
});

test("shade 保留色相：壓過的紅還是紅，不會變成灰", () => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(theme.shade("#ef4444", "light").substr(i, 2), 16));
  assert.ok(r > g && r > b, "紅色通道仍應最大");
});

// ── 儲存契約 ────────────────────────────────────────────────────────────────
test("planner.config.theme 預設 auto，可以存取且不需要 force", () => {
  const store = createStore(backend());
  store.load();
  assert.equal(store.plannerState().config.theme, "auto");

  const out = store.setPlannerConfig({theme: "light"});
  assert.equal(out.ok, true);
  assert.equal(out.config.theme, "light");
  assert.equal(store.plannerState().config.theme, "light");
});

test("壞掉的 theme 不會拖垮同一份 config 的 anchor", () => {
  const store = createStore(backend());
  store.load();
  store.setPlannerConfig({anchorDate: "2026-01-05", anchorPhase: 0});
  const out = store.setPlannerConfig({theme: ["light"]});
  assert.equal(out.ok, true);
  assert.equal(out.config.theme, "auto");
  assert.equal(store.plannerState().config.anchorDate, "2026-01-05");
  assert.equal(store.plannerState().config.anchorPhase, 0);
});

test("改主題不算動到 anchor：已經有每日紀錄也不必帶 force", () => {
  const store = createStore(backend());
  store.load();
  store.setPlannerConfig({anchorDate: "2026-01-05", anchorPhase: 0});
  store.setDayPlan("2026-01-06", {energy: m.ENERGY.MID});
  const out = store.setPlannerConfig({theme: "dark"});
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(store.plannerState().config.theme, "dark");
});

// ── index.html 的 token 與開機腳本 ──────────────────────────────────────────
function tokensIn(block){
  return new Set([...block.matchAll(/--([a-z0-9-]+)\s*:/g)].map(x => x[1]));
}
function blockAfter(selector){
  const i = html.indexOf(selector);
  assert.notEqual(i, -1, `找不到 ${selector}`);
  const start = html.indexOf("{", i), end = html.indexOf("}", start);
  return html.slice(start + 1, end);
}

test("深淺兩套 token 的名字完全一致，不會有一邊漏定義", () => {
  const dark = tokensIn(blockAfter("\n:root{\n  color-scheme:dark;"));
  const light = tokensIn(blockAfter(':root[data-theme="light"]{'));
  dark.delete("safe-top"); dark.delete("safe-bot");   // 與主題無關
  assert.deepEqual([...light].sort(), [...dark].sort());
});

test("畫面用到的 var(--x) 都有定義", () => {
  const sources = [html,
    ...["views.js", "today-view.js"].map(f =>
      readFileSync(fileURLToPath(new URL(`src/${f}`, root)), "utf8"))];
  const defined = new Set([...html.matchAll(/--([a-z0-9-]+)\s*:/g)].map(x => x[1]));
  // 這幾個是渲染時就地設在 inline style 上的，不在 :root。
  ["card-color", "card-color-faint"].forEach(k => defined.add(k));
  const used = new Set();
  for(const src of sources){
    for(const mt of src.matchAll(/var\(--([a-z0-9-]+)\)/g)) used.add(mt[1]);
  }
  const missing = [...used].filter(k => !defined.has(k));
  assert.deepEqual(missing, [], `未定義的 token：${missing.join(", ")}`);
});

test("動態組出來的 token 也要有定義", () => {
  // `var(--${tk}-22)` 這種靜態掃不到，token 名是執行時才拼出來的。把實際會出現
  // 的組合列出來，漏定義一個色階就會在這裡被擋下來。
  const defined = new Set([...html.matchAll(/--([a-z0-9-]+)\s*:/g)].map(x => x[1]));
  const combos = [];
  for(const base of ["amber", "cyan"]) for(const a of ["", "-18", "-22", "-44", "-66"]) combos.push(base + a);
  for(const base of ["amber", "cyan", "blue"]) combos.push(base, base + "-22");
  const missing = [...new Set(combos)].filter(k => !defined.has(k));
  assert.deepEqual(missing, [], `動態 token 未定義：${missing.join(", ")}`);
});

test("開機腳本沒有跟 store 的 key 與 config 形狀漂移", () => {
  const boot = html.slice(html.indexOf("var pref=\"auto\";"), html.indexOf("})();"));
  const store = readFileSync(fileURLToPath(new URL("src/store.js", root)), "utf8");
  const key = store.match(/export const STORAGE_KEY = "([^"]+)"/)[1];
  assert.ok(boot.includes(`localStorage.getItem("${key}")`), "開機腳本讀的 key 不是 STORAGE_KEY");
  assert.ok(boot.includes("planner.config"), "開機腳本讀的 config 路徑變了");
  for(const v of ["light", "dark", "auto"]) assert.ok(boot.includes(`"${v}"`));
});

test("開機腳本的淺色底色等於 token 定義的 --bg", () => {
  const lightBg = blockAfter(':root[data-theme="light"]{').match(/--bg:(#[0-9a-f]{6});/)[1];
  const darkBg = blockAfter("\n:root{\n  color-scheme:dark;").match(/--bg:(#[0-9a-f]{6});/)[1];
  assert.ok(html.includes(`mode==="light"?"${lightBg}":"${darkBg}"`),
    "開機腳本寫死的 theme-color 跟 --bg 對不上");
});

test("shade() 的基準是最深的淺色表面，不是頁面底色", () => {
  const block = blockAfter(':root[data-theme="light"]{');
  const bg3 = block.match(/--bg3:(#[0-9a-f]{6});/)[1];
  assert.equal(theme.LIGHT_SURFACE, bg3, "基準要跟著 --bg3 走");
  const darkest = lightSurfaces()
    .reduce((a, b) => (theme.relativeLuminance(a) <= theme.relativeLuminance(b) ? a : b));
  assert.equal(theme.LIGHT_SURFACE, darkest, "--bg3 不再是最深的表面時要重挑基準");
});

test("var(--x) 後面不接 alpha：接了整條宣告會被瀏覽器丟掉", () => {
  // 兩種寫法都要擋：色值直接寫在樣板裡（`var(--amber)"}22`），以及先存進變數
  // 再接（`const tc="var(--cyan)"` → `${tc}66`）。前者掃字串，後者先找出所有
  // 持有 var() 字串的識別字，再回頭找它的用法。
  const sources = {
    "index.html": html,
    ...Object.fromEntries(["views.js", "today-view.js"].map(f =>
      [f, readFileSync(fileURLToPath(new URL(`src/${f}`, root)), "utf8")])),
  };
  const bad = [];
  for(const [name, src] of Object.entries(sources)){
    for(const mt of src.matchAll(/var\(--[a-z0-9-]+\)["'`}\s]{0,3}[0-9a-fA-F]{2}(?=[;"'`\s)])/g)){
      bad.push(`${name}: ${mt[0]}`);
    }
    const holders = new Set();
    for(const mt of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*var\(--/g)){
      holders.add(mt[1]);
    }
    for(const id of holders){
      const use = new RegExp(`\\$\\{${id}\\}[0-9a-fA-F]{2}|\\b${id}\\s*\\+\\s*["'\`][0-9a-fA-F]{2}["'\`]`, "g");
      for(const mt of src.matchAll(use)) bad.push(`${name}: ${id} → ${mt[0]}`);
    }
  }
  assert.deepEqual(bad, [], `var() 後面接了 alpha：${bad.join(" / ")}`);
});

test("每個開啟對話框的路徑都記下自己的重畫方式，主題變動才追得到", () => {
  // 對話框掛在 document.body 上，不在 #content 裡；只重畫 #content 的話它會留著
  // 開啟當下算出來的色碼。這條擋的是「新增了一個對話框卻忘了設 _modalRepaint」。
  // 以頂層 function 邊界切開，取完整的函式本體——用單一 regex 抓整個函式會被
  // 巢狀的大括號騙過去，長一點的函式就整個漏掉。
  const marks = [...html.matchAll(/\nfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)];
  const bodies = marks.map((mt, i) => [mt[1],
    html.slice(mt.index, i + 1 < marks.length ? marks[i + 1].index : html.length)]);
  const openers = bodies.filter(([, body]) =>
    /overlay\.className\s*=\s*"modal-overlay"|class="modal-overlay"/.test(body)
    && /appendChild\(overlay\)/.test(body));
  assert.ok(openers.length >= 4, `找不到足夠的對話框開啟路徑（${openers.length}）`);
  const missing = openers.filter(([, body]) => !/_modalRepaint\s*=/.test(body)).map(([n]) => n);
  assert.deepEqual(missing, [], `沒有設定 _modalRepaint 的開啟路徑：${missing.join(", ")}`);
  assert.match(html, /window\.rerender\s*=\s*\(\)\s*=>\s*\{\s*render\(\);\s*repaintModal\(\);\s*\}/,
    "主題變動的重畫沒有帶上 repaintModal()");

  // 重畫是「再跑一次開啟路徑」，所以每條路徑都必須先把舊的那份移除。少一個就會
  // 疊出第二個 id 相同的對話框，之後靠 id 找元素的動作全部打到錯的那一份。
  const stacking = openers.filter(([, body]) => {
    const own = body.match(/overlay\.id\s*=\s*["']([^"']+)["']/);
    if(!own) return false;
    return !new RegExp(`getElementById\\(["']${own[1]}["']\\)`).test(body);
  }).map(([n]) => n);
  assert.deepEqual(stacking, [], `沒有先移除舊對話框的開啟路徑：${stacking.join(", ")}`);
});

test("重畫對話框不會把模組層的編輯狀態重設掉", () => {
  // 輸入框靠 repaintModal() 的快照接住，但存在模組層的編輯狀態（獎勵清單、
  // 合併的類型與歸屬）不在快照裡，只能由開啟路徑自己在重畫時不要重設。
  assert.match(html, /function showQuestModal\(s, keepState\)/);
  assert.match(html, /if\(!keepState\)_modalRewards\s*=/,
    "_modalRewards 在重畫時會被重設回存檔的舊值");
  assert.match(html, /_modalRepaint\s*=\s*\(\)\s*=>\s*showQuestModal\(s,\s*true\)/);
  assert.match(html, /function openMergeSub\(coreId, keepState\)/);
  assert.match(html, /setMergeType\(keepState&&window\._mergeType/);
  assert.match(html, /setMergeCore\(keepState&&window\._mergeCoreId/);
  // 合併清單的勾選要有 id，否則不在快照的範圍內
  assert.match(html, /<input type="checkbox" id="merge-pick-\$\{esc\(s\.id\)\}"/);
});

test("匯入備份後會重新套用主題，不會停在舊的那一套", async () => {
  // views.js 在模組層就建好 store 與 api，所以要在 import 之前把 window 立好。
  // 只需要 refreshTheme 會碰到的那幾個東西。
  const store = new Map();
  const attrs = {};
  const meta = {content: "", setAttribute(k, v){ this.content = v; }};
  globalThis.window = {
    document: {
      documentElement: {setAttribute: (k, v) => {attrs[k] = v;}},
      getElementById: () => null,
      querySelector: sel => (sel.includes("theme-color") ? meta : null),
    },
    getComputedStyle: () => ({getPropertyValue: () => "#f5f2ea"}),
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => {store.set(k, String(v));},
    },
    matchMedia: () => ({matches: false, addEventListener(){}, removeEventListener(){}}),
  };
  globalThis.localStorage = window.localStorage;
  globalThis.document = window.document;

  const views = await import("../src/views.js");
  const api = views.install();
  assert.equal(attrs["data-theme"], "dark", "預設偏好 auto ＋ 系統深色");

  api.setTheme("light");
  assert.equal(attrs["data-theme"], "light");

  // 一份明確指定深色的 v2 備份
  api.importPayload({
    version: 3, cores: [], skills: [], goals: [], steps: [],
    planner: {version: 1, config: {theme: "dark", goalBindings: {}}, days: {}, stepDetails: {}, entries: []},
  });
  assert.equal(api.themePref(), "dark", "匯入的偏好要進 store");
  assert.equal(attrs["data-theme"], "dark", "套用的主題要跟著匯入的偏好走");
  assert.equal(api.themeMode(), "dark", "快取的 themeMode 也要更新");
  assert.equal(api.themeColor("#f59e0b"), "#f59e0b", "深色模式不壓資料色");

  delete globalThis.window; delete globalThis.localStorage; delete globalThis.document;
});
