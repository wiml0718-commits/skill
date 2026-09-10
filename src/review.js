// ── 節奏與回顧（§5.2–5.4）───────────────────────────────────────────────────
// 每日結算與每週回顧的彙總邏輯。純函式：吃一份 state 與「今天」，不碰 store，
// 也不決定要不要顯示——那是 store 的 meta 在管（§5.3）。
//
// 週界是週一、日界是凌晨 4:00（§5.0）。日界已經由 logicalToday() 折算完，所以
// 這裡拿到的一律是邏輯日的日期字串，不需要再管時分。

import * as model from "./model.js";
import {countsAsActivity, sumXp} from "./rpg.js";

// 週一為週首。ISO 日期字串以 UTC 解讀，與 shiftDate / daysBetween 同一套算術，
// 不會因為執行環境的時區而位移一天。
export function weekStart(day){
  const d = new Date(`${day}T00:00:00Z`);
  if(Number.isNaN(d.getTime())) return null;
  // getUTCDay(): 0 = 週日。往回推到週一，週日要退 6 天而不是往前 1 天。
  const back = (d.getUTCDay() + 6) % 7;
  return model.shiftDate(day, -back);
}

export function weekRange(day){
  const from = weekStart(day);
  return from ? {from, to: model.shiftDate(from, 6)} : null;
}

// 一筆 xpLog 屬於哪個核心。skillId 為 null 是未歸屬（§4.3.1），不屬於任何核心。
function coreOfEntry(skills, entry){
  if(!entry.skillId) return null;
  const skill = (skills || []).find(s => s.id === entry.skillId);
  return skill ? skill.coreId : null;
}

// 某個核心在「某一天結束時」的 XP。從現在往回扣，而不是從 xpLog 累加：
// v2 之前就存在的 XP 沒有對應的紀錄，累加會少算一大截。
function coreXpAsOf(state, coreId, day){
  const now = model.coreXp(state.skills || [], coreId);
  const after = (state.xpLog || []).reduce((a, e) =>
    (e.date > day && coreOfEntry(state.skills, e) === coreId ? a + e.xp : a), 0);
  return now - after;
}

// 一天內完成的步驟數：同一個步驟可能有多筆 rewards，各寫一筆 xpLog，所以要
// 依 refId 去重，不能直接數紀錄筆數。
function completedOn(xpLog, from, to){
  const ids = new Set();
  let anonymous = 0;
  for(const e of xpLog || []){
    if(e.source !== model.XP_SOURCE.STEP) continue;
    if(e.date < from || e.date > to) continue;
    if(e.refId) ids.add(e.refId);
    else anonymous += 1;   // 沒有 refId 的舊紀錄只能一筆算一件
  }
  return ids.size + anonymous;
}

function levelChanges(state, from, to){
  const out = [];
  for(const core of state.cores || []){
    const before = coreXpAsOf(state, core.id, model.shiftDate(from, -1));
    const after = coreXpAsOf(state, core.id, to);
    const lvBefore = model.calcLv(before);
    const lvAfter = model.calcLv(after);
    if(lvAfter > lvBefore) out.push({core, from: lvBefore, to: lvAfter});
  }
  return out;
}

// ── 每日結算（§5.3）─────────────────────────────────────────────────────────
export function dailySummary(state, day){
  const xpLog = state.xpLog || [];
  const dailies = (state.steps || []).filter(s => s.kind === model.STEP_KIND.DAILY);
  return {
    day,
    steps: completedOn(xpLog, day, day),
    xp: sumXp(xpLog, {from: day, to: day}),
    levelUps: levelChanges(state, day, day),
    // 當天有打卡的每日任務，附上算到那天為止的連續天數
    streaks: dailies
      .filter(s => (s.streakHistory || []).includes(day))
      .map(s => ({title: s.title, streak: model.calcStreak(s.streakHistory, day)})),
  };
}

// 這一天有沒有任何值得報的東西。全空就不要為了跳而跳一個空摘要。
export function hasDailyContent(summary){
  return !!summary && (summary.steps > 0 || summary.xp !== 0
    || summary.levelUps.length > 0 || summary.streaks.length > 0);
}

// ── 每週回顧（§5.4）─────────────────────────────────────────────────────────
export function weeklySummary(state, today){
  const {from, to} = weekRange(today);
  const xpLog = state.xpLog || [];
  const cores = (state.cores || []).map(core => ({
    core,
    gain: xpLog.reduce((a, e) => (
      countsAsActivity(e.source) && e.date >= from && e.date <= to
        && coreOfEntry(state.skills, e) === core.id ? a + e.xp : a), 0),
  }));
  const bestStreak = (state.steps || [])
    .filter(s => s.kind === model.STEP_KIND.DAILY)
    .reduce((best, s) => Math.max(best, model.calcStreak(s.streakHistory, today)), 0);

  return {
    from, to,
    xp: sumXp(xpLog, {from, to}),
    steps: completedOn(xpLog, from, to),
    cores: cores.filter(c => c.gain !== 0).sort((a, b) => b.gain - a.gain),
    levelUps: levelChanges(state, from, to),
    bestStreak,
    // 待重新決定：沿用既有的三種情況，不另立一套
    review: model.reviewItems(state.goals || [], state.steps || [], today),
    // 待歸屬 XP（§4.3.1）。正常操作不再產生新項目，清完就是空的。
    unassigned: unassignedEntries(xpLog),
  };
}

// 未歸屬的 xpLog：這些永遠不會被壓成月彙總（§3.6），所以清單不會失真。
export function unassignedEntries(xpLog){
  return (xpLog || [])
    .filter(e => e.skillId === null && e.xp !== 0)
    .slice()
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}
