// ── 成就（§6.2）─────────────────────────────────────────────────────────────
// 判定是純函式：只讀 goals / steps / skills / xpLog / meta，不碰 store，也不寫
// 任何東西。解鎖與否由 store 在 commit 時 diff 出來（§6.2），這裡不負責記時間。
//
// 歷史型條件一律靠 meta 的高水位判定。「收件匣曾有 ≥5 筆」無法從清空後的狀態
// 回推：逐筆清到最後只看得到 0，重新載入 App 更沒有記憶體可依靠。

import * as model from "./model.js";
import {coreLevels} from "./rpg.js";

// 清單以 §6.2 為準，不自行增減。desc 是給成就頁顯示的條件說明。
export const ACHIEVEMENTS = [
  {id: "first_step",    name: "第一步",     icon: "👣", desc: "完成第一個步驟"},
  {id: "steps_10",      name: "十步",       icon: "🚶", desc: "累計完成 10 個步驟"},
  {id: "steps_50",      name: "五十步",     icon: "🏃", desc: "累計完成 50 個步驟"},
  {id: "steps_100",     name: "百步",       icon: "🏆", desc: "累計完成 100 個步驟"},
  {id: "streak_7",      name: "一週不斷",   icon: "🔥", desc: "任一每日任務連續 7 天"},
  {id: "streak_30",     name: "一月不斷",   icon: "🌋", desc: "任一每日任務連續 30 天"},
  {id: "core_lv10",     name: "登堂",       icon: "⭐", desc: "任一核心達 Lv10"},
  {id: "core_lv25",     name: "入室",       icon: "🌟", desc: "任一核心達 Lv25"},
  {id: "core_lv50",     name: "宗師",       icon: "💫", desc: "任一核心達 Lv50"},
  {id: "total_lv50",    name: "總等級 50",  icon: "📈", desc: "所有核心等級加總達 50"},
  {id: "total_lv100",   name: "總等級 100", icon: "📊", desc: "所有核心等級加總達 100"},
  {id: "all_cores_lv5", name: "全面發展",   icon: "🧭", desc: "核心數 ≥ 5，且每個核心都達 Lv5"},
  {id: "first_merge",   name: "融會貫通",   icon: "⚗️", desc: "合併過任一組技能"},
  {id: "inbox_zero",    name: "收件匣清空", icon: "📥", desc: "收件匣曾有 ≥ 5 筆待處理，且目前清空"},
  {id: "review_clear",  name: "回顧清空",   icon: "🧹", desc: "回顧清單曾有 ≥ 3 項，且目前清空"},
];

export const ACHIEVEMENT_IDS = ACHIEVEMENTS.map(a => a.id);
const BY_ID = new Map(ACHIEVEMENTS.map(a => [a.id, a]));
export function achievementById(id){return BY_ID.get(id) || null;}

// 累計完成數：每日任務算打卡次數，其餘算「現在是完成狀態」。
// 非每日的完成不會累加 completedCount（store 只在打卡那條路徑加），所以兩種
// kind 不能用同一個欄位算。已封存的仍然算數——封存是收納，不是沒做過。
export function completedSteps(steps){
  return (steps || []).reduce((n, s) => {
    if(!s) return n;
    if(s.kind === model.STEP_KIND.DAILY) return n + (s.completedCount || 0);
    return n + (s.state === model.STEP_STATE.DONE ? 1 : 0);
  }, 0);
}

// 任一每日任務當下的連續天數。跨過門檻的那一刻會有一次 commit（打卡本身就是
// 寫入），所以用當下值判定不會漏掉。
export function bestDailyStreak(steps, today){
  let best = 0;
  for(const s of steps || []){
    if(!s || s.kind !== model.STEP_KIND.DAILY) continue;
    best = Math.max(best, model.calcStreak(s.streakHistory, today));
  }
  return best;
}

// 全域連續天數：meta.activeDays 與每日任務的 streakHistory 是同一種形狀，
// 連續天數的算法也一樣（今天還沒有活動不算中斷）。
export function globalStreak(meta, today){
  return model.calcStreak(meta && meta.activeDays, today);
}

export function evaluateAchievements(state, today){
  const {goals = [], steps = [], skills = [], cores = [], meta} = state || {};
  const safeMeta = meta || {inboxPeak: 0, reviewPeak: 0, activeDays: []};

  const done = completedSteps(steps);
  const streak = bestDailyStreak(steps, today);
  const levels = coreLevels(cores, skills).map(x => x.lv);
  const maxCoreLv = levels.length ? Math.max(...levels) : 0;
  const totalLv = model.totalLevel(cores, skills);
  const inboxOpen = model.inboxPending(steps).length;
  const reviewOpen = model.reviewItems(goals, steps, today).total;

  const hit = {
    first_step:    done >= 1,
    steps_10:      done >= 10,
    steps_50:      done >= 50,
    steps_100:     done >= 100,
    streak_7:      streak >= 7,
    streak_30:     streak >= 30,
    core_lv10:     maxCoreLv >= 10,
    core_lv25:     maxCoreLv >= 25,
    core_lv50:     maxCoreLv >= 50,
    total_lv50:    totalLv >= 50,
    total_lv100:   totalLv >= 100,
    all_cores_lv5: levels.length >= 5 && levels.every(lv => lv >= 5),
    first_merge:   (skills || []).some(s => s && s.mergedFrom !== null),
    // 高水位與計數共用 inboxPending / reviewItems，否則畫面清空了成就還解不開
    inbox_zero:    inboxOpen === 0 && (safeMeta.inboxPeak || 0) >= 5,
    review_clear:  reviewOpen === 0 && (safeMeta.reviewPeak || 0) >= 3,
  };

  // 依常數表的順序回傳，讓解鎖與顯示的先後穩定
  return new Set(ACHIEVEMENT_IDS.filter(id => hit[id]));
}
