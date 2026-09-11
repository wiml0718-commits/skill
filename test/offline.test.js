// 離線可用性的靜態一致性檢查（A23）。
//
// 這不是真的離線測試：它不裝 service worker、不斷網、不重開 app。它擋的是
// 「離線壞掉」最常見也最安靜的那個原因——sw.js 的快取清單跟實際會被載入的
// 檔案對不上。真正的離線重開仍要在瀏覽器上驗，結果記在 docs/THEME.md。
import {test} from "node:test";
import assert from "node:assert/strict";
import {existsSync, readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";

const root = new URL("../", import.meta.url);
const read = f => readFileSync(fileURLToPath(new URL(f, root)), "utf8");
const sw = read("sw.js");
const html = read("index.html");
const manifest = JSON.parse(read("manifest.json"));

const ASSETS = JSON.parse(sw.match(/const ASSETS = (\[[\s\S]*?\]);/)[1].replace(/\s+/g, " "));

// 一個模組 import 到的其他本地模組，遞迴展開。
function importGraph(entry){
  const seen = new Set();
  const walk = file => {
    if(seen.has(file)) return;
    seen.add(file);
    const src = read(file);
    const dir = file.slice(0, file.lastIndexOf("/") + 1);
    for(const m of src.matchAll(/from\s+"(\.[^"]+)"/g)){
      const rel = new URL(m[1], new URL(file, root)).pathname;
      walk(rel.slice(fileURLToPath(root).length - 1).replace(/^\/+/, "") || dir + m[1]);
    }
  };
  walk(entry);
  seen.delete(entry);
  return [...seen];
}

test("快取清單裡的每個檔案都真的存在", () => {
  for(const a of ASSETS){
    assert.ok(existsSync(fileURLToPath(new URL(a, root))), `${a} 在快取清單裡但檔案不存在`);
  }
});

test("快取清單沒有重複項", () => {
  assert.equal(new Set(ASSETS).size, ASSETS.length);
});

test("index.html 會載入的模組全部在快取清單裡", () => {
  const entry = html.match(/import\s*{[^}]*}\s*from\s*"(\.\/src\/[^"]+)"/)[1];
  const files = [entry.replace("./", ""), ...importGraph(entry.replace("./", ""))];
  for(const f of files){
    assert.ok(ASSETS.includes(`./${f}`), `${f} 會被載入但不在 sw.js 的 ASSETS 裡`);
  }
});

test("manifest 的圖示與 index.html 參照的本地檔案都在快取清單裡", () => {
  for(const icon of manifest.icons){
    assert.ok(ASSETS.includes(`./${icon.src}`), `${icon.src} 是 manifest 圖示但沒進快取`);
  }
  const refs = [...html.matchAll(/(?:src|href)="(?!https?:|data:|#)([^"]+)"/g)].map(m => m[1]);
  for(const r of new Set(refs)){
    assert.ok(ASSETS.includes(`./${r}`), `index.html 參照 ${r} 但沒進快取`);
  }
});

test("改過快取內容就要換版本號：ASSETS 變了 CACHE 名稱也得動", () => {
  // 版本號本身沒辦法自動比對，這裡只確認格式沒被寫壞——sw.js 位元組沒變的話
  // 既有安裝不會裝新的 worker，cache-first 會繼續送舊檔案。
  assert.match(sw.match(/const CACHE = "([^"]+)"/)[1], /^skill-tree-v\d+$/);
});

test("外部字型不在快取清單：離線時會掉回系統等寬字，這是已知取捨", () => {
  assert.ok(html.includes("fonts.googleapis.com"), "字型來源變了就要重看這條");
  assert.ok(!ASSETS.some(a => a.includes("http")), "跨網域資源不該進 addAll");
});
