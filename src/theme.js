// 外觀主題（§THEME）。偏好存在 planner.config.theme，只有三個值：auto／light／
// dark。這裡負責兩件事：把偏好併上系統偏好算出實際模式，以及把使用者自選的
// 核心顏色壓到淺色背景上讀得到的亮度。CSS token 的分岔看 index.html 的
// `:root[data-theme="light"]`。
import {THEME, normalizeTheme} from "./model.js";

export {THEME, normalizeTheme};

export const LIGHT_QUERY = "(prefers-color-scheme: light)";

// auto 以外一律照使用者指定的走；auto 才交給系統。第二個參數是「系統偏好淺色」
// 的布林值，讓判定本身可以脫離瀏覽器測。
export function resolveTheme(pref, systemPrefersLight = false){
  const p = normalizeTheme(pref);
  if(p === THEME.LIGHT || p === THEME.DARK) return p;
  return systemPrefersLight ? THEME.LIGHT : THEME.DARK;
}

// matchMedia 在測試環境與舊瀏覽器都可能不存在，缺席時當作不偏好淺色。
export function systemPrefersLight(win){
  if(!win || typeof win.matchMedia !== "function") return false;
  const mql = win.matchMedia(LIGHT_QUERY);
  return !!(mql && mql.matches);
}

// data-theme 一律寫成已解析的 light／dark，不留 auto：CSS 只要分兩種情況，
// 也不必和 prefers-color-scheme 的 fallback 規則爭特異性。
export function applyTheme(root, pref, systemLight = false){
  const mode = resolveTheme(pref, systemLight);
  if(root && typeof root.setAttribute === "function") root.setAttribute("data-theme", mode);
  return mode;
}

// 系統主題在 app 開著時被改掉（例如日落自動切換）也要跟上，但只有 auto 需要。
export function watchSystemTheme(win, onChange){
  if(!win || typeof win.matchMedia !== "function") return () => {};
  const mql = win.matchMedia(LIGHT_QUERY);
  if(!mql || typeof mql.addEventListener !== "function") return () => {};
  const handler = e => onChange(!!e.matches);
  mql.addEventListener("change", handler);
  return () => mql.removeEventListener("change", handler);
}

// ── 資料色的亮度壓制 ────────────────────────────────────────────────────────
// 核心顏色是使用者資料，不能換成 token。深色主題挑的飽和色直接放到淺色背景上
// 會看不見（#22d3ee 對 #f5f2ea 的對比只有 1.6:1），所以淺色模式下等比壓暗。
// 在線性空間等比縮放三個通道：亮度剛好落到目標值，色相與彩度都保留。
const HEX_FULL = /^#[0-9a-fA-F]{6}$/;

// 淺色底色 #f5f2ea 的相對亮度是 0.8886，門檻取 0.158 時對比 4.51:1，剛好過
// WCAG AA 的 4.5:1。底色改了就要一起改，test/theme.test.js 會把這條算式跑出來。
export const LIGHT_BG = "#f5f2ea";
export const LIGHT_MAX_LUMINANCE = 0.158;

function toLinear(v){
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function toChannel(v){
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, c)) * 255);
}
export function relativeLuminance(hex){
  if(!HEX_FULL.test(hex)) return null;
  const [r, g, b] = channels(hex);
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}
function channels(hex){
  return [hex.slice(1, 3), hex.slice(3, 5), hex.slice(5, 7)].map(h => parseInt(h, 16));
}

export function shade(hex, mode){
  // 不是六位色碼就原樣退回：這裡只做亮度調整，型別與格式的把關在
  // model.normalizeColor，重複一次只會多出一條會漂移的規則。
  if(mode !== THEME.LIGHT || typeof hex !== "string" || !HEX_FULL.test(hex)) return hex;
  const lin = channels(hex).map(toLinear);
  const lum = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  if(lum <= LIGHT_MAX_LUMINANCE) return hex;
  const k = LIGHT_MAX_LUMINANCE / lum;
  return "#" + lin.map(v => toChannel(v * k).toString(16).padStart(2, "0")).join("");
}
