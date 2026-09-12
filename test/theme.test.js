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

test("shade：深色模式原樣退回，淺色模式壓到對得起 4.5:1", () => {
  for(const c of DATA_COLORS){
    assert.equal(theme.shade(c, "dark"), c);
    const light = theme.shade(c, "light");
    assert.match(light, /^#[0-9a-f]{6}$/);
    assert.ok(contrast(light, theme.LIGHT_BG) >= 4.45,
      `${c} → ${light} 對 ${theme.LIGHT_BG} 只有 ${contrast(light, theme.LIGHT_BG).toFixed(2)}:1`);
  }
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
  assert.equal(lightBg, theme.LIGHT_BG, "shade() 的對比基準要用同一個底色");
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
