// ── XP 引擎（schema v2）──────────────────────────────────────────────────────
// 純函式：不讀寫 storage、不碰 DOM，也不自己決定「現在幾點」以外的事。
// 規格見 docs/RPG_SPEC.md §4（XP 與升級）、§5.0（日界）、§6.1（屬性與稱號）。
//
// 等級曲線本身住在 model.js（LEVEL_XP / calcLv / coreXp / totalLevel），這裡不
// 重寫一份，只補上曲線之外的推導：階層名、進度、歸屬與紀錄壓縮。

import * as model from "./model.js";

// ── 日界（§5.0）─────────────────────────────────────────────────────────────
// 凌晨兩三點完成的事屬於前一天。日界設在 00:00 會讓晚睡的人在跨過午夜的那一刻
// 莫名其妙斷掉 streak，明明還沒睡就被判定成新的一天什麼都沒做。
export const DAY_START_HOUR = 4;

// 這是整個 app 唯一的「今天」來源：xpLog.date、streakHistory、meta.activeDays、
// 到期日比較全部走它，不得各自呼叫 new Date() 取日期。
export function logicalToday(now = new Date()){
  const d = new Date(now.getTime() - DAY_START_HOUR * 3600000);
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ── 等級（§4.1、§6.1）───────────────────────────────────────────────────────
// 階層名沿用 index.html 的既有定義，數值與級距都不改。
export const LV_NAMES = (() => {
  const tiers = [
    [1, 5, "初學者"], [6, 10, "見習生"], [11, 15, "實踐者"], [16, 20, "熟練者"],
    [21, 25, "進階者"], [26, 30, "資深者"], [31, 35, "精英"], [36, 40, "大師"],
    [41, 50, "宗師"], [51, 60, "傳說"], [61, 70, "神話"], [71, 80, "至高"],
    [81, 90, "無敵"], [91, 98, "超越者"], [99, 99, "神域"],
  ];
  const arr = [""];
  for(let i = 1; i <= model.MAX_LV; i++){
    const t = tiers.find(([a, b]) => i >= a && i <= b);
    arr.push(t ? t[2] : "神域");
  }
  return arr;
})();

export function lvName(lv){
  return LV_NAMES[Math.min(Math.max(Math.trunc(lv) || 1, 1), model.MAX_LV)];
}

// Lv1 的起點是 0 而不是 LEVEL_XP[1]：calcLv 讓 0 XP 就是 Lv1，用 LEVEL_XP[1]
// 當基準會讓還沒滿 100 XP 的技能算出負的進度與負的「已累積」。
export function levelProgress(xp){
  const have = Number.isFinite(xp) ? Math.max(0, xp) : 0;
  const lv = model.calcLv(have);
  if(lv >= model.MAX_LV) return {lv, pct: 100, cur: have - model.LEVEL_XP[model.MAX_LV], need: 0};
  const base = lv <= 1 ? 0 : model.LEVEL_XP[lv];
  const next = model.LEVEL_XP[lv + 1];
  return {lv, pct: Math.round((have - base) / (next - base) * 100),
          cur: have - base, need: next - base};
}

// 屬性 = 核心等級（§6.1）。不新增維度，直接照目前實際存在的核心算。
export function coreLevels(cores, skills){
  return (cores || []).map(c => {
    const xp = model.coreXp(skills || [], c.id);
    return {core: c, xp, lv: model.calcLv(xp)};
  });
}

// 稱號 = 等級最高核心的階層名 + 核心名。同分時取 order 較前者，讓結果穩定不跳動。
export function charTitle(cores, skills){
  const ranked = coreLevels(cores, skills);
  if(!ranked.length) return "";
  let best = ranked[0];
  for(const cur of ranked.slice(1)){
    if(cur.lv > best.lv || (cur.lv === best.lv && cur.core.order < best.core.order)) best = cur;
  }
  return `${best.core.name}・${lvName(best.lv)}`;
}

// ── XP 歸屬（§4.2–4.3）──────────────────────────────────────────────────────
// 一個步驟完成時要發放的 XP。skillId 為 null 代表這筆沒有歸屬（§4.3.1）：
// 記下來而不是丟掉，也不猜一個核心塞進去。
//
// 依序判定：rewards → 所屬 goal 的承接技能 → 未歸屬。
// 指向不存在技能的 rewards 同樣走未歸屬，不讓 XP 靜默蒸發（§3.2 末段）。
export function resolveGrants(step, {goals = [], skills = []} = {}){
  const exists = id => skills.some(s => s.id === id);
  if(step.rewards && step.rewards.length){
    return step.rewards.map(r => ({skillId: exists(r.skillId) ? r.skillId : null, xp: r.xp}));
  }
  const amount = Number.isSafeInteger(step.xp) && step.xp >= 0
    ? step.xp : (model.KIND_DEFAULT_XP[step.kind] || 0);
  const goal = step.goalId ? goals.find(g => g.id === step.goalId) : null;
  if(goal && goal.coreId){
    const gid = model.generalSkillId(goal.coreId);
    return [{skillId: exists(gid) ? gid : null, xp: amount}];
  }
  return [{skillId: null, xp: amount}];
}

// ── 補登（§5.1）─────────────────────────────────────────────────────────────
// 窗口刻意壓短：補登窗口愈長，streak 就愈接近「事後補出來的數字」。
export const BACKFILL_DAYS = 3;

export function canBackfill(date, today){
  const diff = model.daysBetween(date, today);
  return Number.isFinite(diff) && diff >= 0 && diff <= BACKFILL_DAYS;
}

// ── xpLog 體積控制（§3.6）───────────────────────────────────────────────────
export const XP_LOG_RETENTION_DAYS = 400;

function rollupKey(entry){
  return `${entry.date.slice(0, 7)}|${entry.skillId}`;
}

// 超過保留期限的紀錄壓成「每月每技能一筆」。skillId 為 null 的永遠不壓：彙總會
// 清掉 refId，未歸屬紀錄一旦被壓，待歸屬清單就再也說不出這筆 XP 來自哪個步驟。
//
// 已經是 rollup 的紀錄會再次落進同一個 bucket，因此壓縮是冪等的；沿用既有那筆的
// id，才不會每次載入都換一組 id。
export function compressXpLog(entries, today){
  const list = Array.isArray(entries) ? entries : [];
  const keep = [];
  const buckets = new Map();
  for(const e of list){
    if(e.skillId === null || model.daysBetween(e.date, today) <= XP_LOG_RETENTION_DAYS){
      keep.push(e);
      continue;
    }
    const key = rollupKey(e);
    const prev = buckets.get(key);
    if(prev){
      prev.xp += e.xp;
      if(!prev.id && e.source === model.XP_SOURCE.ROLLUP) prev.id = e.id;
    }else{
      buckets.set(key, {
        id: e.source === model.XP_SOURCE.ROLLUP ? e.id : undefined,
        date: `${e.date.slice(0, 7)}-01`,
        skillId: e.skillId,
        xp: e.xp,
      });
    }
  }
  if(!buckets.size) return list;
  const rolled = [...buckets.values()]
    .map(b => model.createXpEntry({...b, source: model.XP_SOURCE.ROLLUP}))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  // 壓縮出來的都比保留下來的舊，接在前面就維持了原本的時間順序。
  return [...rolled, ...keep];
}

// ── 統計（§5.2–5.4 會用到，這裡先給共用的過濾規則）───────────────────────
// 合併只是搬移既有 XP，不是當天推進了什麼；rollup 的 date 是月初而不是真的有
// 活動的那天。兩者都不計入活動日與每日 / 每週的 XP 加總（§4.5、§5.2）。
export function countsAsActivity(source){
  return source === model.XP_SOURCE.STEP || source === model.XP_SOURCE.MANUAL;
}

export function sumXp(entries, {from = null, to = null} = {}){
  return (entries || []).reduce((total, e) => {
    if(!countsAsActivity(e.source)) return total;
    if(from && e.date < from) return total;
    if(to && e.date > to) return total;
    return total + e.xp;
  }, 0);
}
