// 節奏與回顧（§5.2–5.4）：週界、日界、結算去重、每週彙總、待歸屬清單。
import {test} from "node:test";
import assert from "node:assert/strict";
import {createStore} from "../src/store.js";
import * as m from "../src/model.js";
import {logicalToday, DAY_START_HOUR, XP_LOG_RETENTION_DAYS} from "../src/rpg.js";
import {weekStart, weekRange, dailySummary, hasDailyContent, weeklySummary,
        unassignedEntries} from "../src/review.js";
import {globalStreak} from "../src/achievements.js";

function backend(){
  const map = new Map();
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {map.set(k, String(v));},
  };
}

function fresh(){
  const store = createStore(backend());
  store.load();
  return store;
}

function addSkill(store, {id = "sk_a", coreId = "body", xp = 0} = {}){
  const state = store.legacyState();
  store.saveLegacyState({
    ...state,
    subSkills: [...state.subSkills, {id, coreId, name: id, type: "active", xp,
                                     icon: "⭐", desc: "", source: "", notes: []}],
  });
  return id;
}

// ── 週界：週一起算（§5.4）────────────────────────────────────────────────────
test("週首是週一，週日屬於前一週而不是新的一週", () => {
  // 2026-09-07 是週一
  assert.equal(weekStart("2026-09-07"), "2026-09-07", "週一是自己");
  assert.equal(weekStart("2026-09-10"), "2026-09-07", "週四");
  assert.equal(weekStart("2026-09-13"), "2026-09-07", "週日仍屬同一週");
  assert.equal(weekStart("2026-09-14"), "2026-09-14", "下一個週一才換週");
  assert.deepEqual(weekRange("2026-09-13"), {from: "2026-09-07", to: "2026-09-13"});
});

test("週界跨月與跨年都算得出來", () => {
  assert.equal(weekStart("2026-03-01"), "2026-02-23");
  assert.equal(weekStart("2026-01-01"), "2025-12-29");
  assert.deepEqual(weekRange("2026-01-01"), {from: "2025-12-29", to: "2026-01-04"});
});

// ── 日界：凌晨 4:00（§5.0）───────────────────────────────────────────────────
test("凌晨 0:00–4:00 算前一天，4:00 之後才換日", () => {
  const at = (h, mi = 0) => {
    const d = new Date(2026, 8, 10, h, mi, 0); // 本地時間 2026-09-10
    return logicalToday(d);
  };
  assert.equal(DAY_START_HOUR, 4);
  assert.equal(at(0, 30), "2026-09-09", "凌晨半夜還算前一天");
  assert.equal(at(3, 59), "2026-09-09");
  assert.equal(at(4, 0), "2026-09-10", "4:00 整換日");
  assert.equal(at(23, 30), "2026-09-10");
});

// ── 每日結算（§5.3）─────────────────────────────────────────────────────────
const stateWith = patch => ({
  cores: [], skills: [], goals: [], steps: [], xpLog: [], meta: m.createMeta(), ...patch,
});

const entry = (date, xp, o = {}) => m.createXpEntry({date, xp, ...o});

test("同一個步驟的多筆 rewards 只算完成一項", () => {
  const s = dailySummary(stateWith({
    xpLog: [
      entry("2026-09-09", 30, {skillId: "sk_a", refId: "s1"}),
      entry("2026-09-09", 20, {skillId: "sk_b", refId: "s1"}),
      entry("2026-09-09", 10, {skillId: "sk_a", refId: "s2"}),
    ],
  }), "2026-09-09");
  assert.equal(s.steps, 2, "兩個步驟，不是三筆紀錄");
  assert.equal(s.xp, 60);
});

test("每日結算只看那一天，前後兩天不算進來", () => {
  const log = [
    entry("2026-09-08", 10, {skillId: "sk_a", refId: "s0"}),
    entry("2026-09-09", 25, {skillId: "sk_a", refId: "s1"}),
    entry("2026-09-10", 40, {skillId: "sk_a", refId: "s2"}),
  ];
  const s = dailySummary(stateWith({xpLog: log}), "2026-09-09");
  assert.equal(s.steps, 1);
  assert.equal(s.xp, 25);
});

test("合併與月彙總不計入每日 XP（§4.5、§5.2）", () => {
  const s = dailySummary(stateWith({
    xpLog: [
      entry("2026-09-09", 20, {skillId: "sk_a", refId: "s1"}),
      entry("2026-09-09", 0, {skillId: "sk_m", source: m.XP_SOURCE.MERGE}),
      entry("2026-09-09", 900, {skillId: "sk_a", source: m.XP_SOURCE.ROLLUP}),
    ],
  }), "2026-09-09");
  assert.equal(s.xp, 20);
  assert.equal(s.steps, 1, "rollup 沒有 refId，也不是 step，不該被算成完成");
});

test("每日結算列出當天打卡的每日任務與當下連續天數", () => {
  const days = ["2026-09-07", "2026-09-08", "2026-09-09"];
  const s = dailySummary(stateWith({
    steps: [
      m.createStep({title: "冥想", order: 0, kind: m.STEP_KIND.DAILY,
                    streakHistory: days}),
      m.createStep({title: "沒打卡", order: 1, kind: m.STEP_KIND.DAILY,
                    streakHistory: ["2026-09-01"]}),
    ],
  }), "2026-09-09");
  assert.deepEqual(s.streaks, [{title: "冥想", streak: 3}]);
});

test("升級是比對那天前後的核心等級，不靠 xpLog 從零累加", () => {
  // 技能現值剛好到 Lv2，當天拿到的 XP 讓它跨過門檻
  const gain = m.LEVEL_XP[2] - m.LEVEL_XP[1];
  const state = stateWith({
    cores: [m.createCore({id: "body", name: "身體", order: 0})],
    skills: [m.createSkill({id: "sk_a", coreId: "body", name: "a", xp: m.LEVEL_XP[2]})],
    xpLog: [entry("2026-09-09", gain, {skillId: "sk_a", refId: "s1"})],
  });
  const s = dailySummary(state, "2026-09-09");
  assert.equal(s.levelUps.length, 1);
  assert.equal(s.levelUps[0].from, 1);
  assert.equal(s.levelUps[0].to, 2);

  // 同一份資料看「前一天」：那天沒有進帳，不該報升級
  assert.deepEqual(dailySummary(state, "2026-09-08").levelUps, []);
});

test("空白的一天沒有內容可報", () => {
  assert.equal(hasDailyContent(dailySummary(stateWith({}), "2026-09-09")), false);
  assert.equal(hasDailyContent(dailySummary(stateWith({
    xpLog: [entry("2026-09-09", 10, {skillId: "sk_a", refId: "s1"})],
  }), "2026-09-09")), true);
});

// ── 結算去重（§5.3）─────────────────────────────────────────────────────────
test("同一天重複開啟只顯示一次每日結算", () => {
  const store = fresh();
  addSkill(store);
  const today = logicalToday();
  const step = store.addStep({kind: m.STEP_KIND.DAILY, title: "喝水",
                              rewards: [{skillId: "sk_a", xp: 10}]});
  // 昨天打卡，今天才會有東西可報
  store.backfillDaily(step.id, m.shiftDate(today, -1));

  assert.ok(store.pendingDailySummary(), "第一次開啟該有摘要");
  store.markDailySummarySeen();
  assert.equal(store.pendingDailySummary(), null, "看過就不該再跳");
  assert.equal(store.getState().meta.lastDailySummaryDate, today);
});

test("昨天沒東西可報時也記下已看過，不用每次重算", () => {
  const store = fresh();
  assert.equal(store.pendingDailySummary(), null);
  store.markDailySummarySeen();
  assert.equal(store.getState().meta.lastDailySummaryDate, logicalToday());
});

// ── 每週回顧（§5.4）─────────────────────────────────────────────────────────
test("每週回顧只收本週的 XP，上週的不算", () => {
  const today = "2026-09-10";                 // 週四
  const {from} = weekRange(today);            // 2026-09-07
  const state = stateWith({
    cores: [m.createCore({id: "body", name: "身體", order: 0}),
            m.createCore({id: "learn", name: "學習", order: 1})],
    skills: [m.createSkill({id: "sk_a", coreId: "body", name: "a", xp: 100}),
             m.createSkill({id: "sk_b", coreId: "learn", name: "b", xp: 30})],
    xpLog: [
      entry(m.shiftDate(from, -1), 999, {skillId: "sk_a", refId: "old"}),
      entry(from, 40, {skillId: "sk_a", refId: "s1"}),
      entry(today, 30, {skillId: "sk_b", refId: "s2"}),
    ],
  });
  const r = weeklySummary(state, today);
  assert.deepEqual({from: r.from, to: r.to}, {from: "2026-09-07", to: "2026-09-13"});
  assert.equal(r.xp, 70, "上週那筆 999 不該算進來");
  assert.equal(r.steps, 2);
  assert.deepEqual(r.cores.map(c => [c.core.id, c.gain]), [["body", 40], ["learn", 30]]);
});

test("每週回顧沿用既有的 reviewItems 三種情況", () => {
  const today = logicalToday();
  const goal = m.createGoal({id: "g1", title: "沒有下一步的目標", coreId: "body"});
  const r = weeklySummary(stateWith({goals: [goal]}), today);
  assert.equal(r.review.stalledGoals.length, 1);
  assert.equal(r.review.total, 1);
});

test("待歸屬清單只收 skillId 為 null 的紀錄，新到舊排序", () => {
  const log = [
    entry("2026-09-01", 10, {skillId: null}),
    entry("2026-09-05", 25, {skillId: null}),
    entry("2026-09-06", 50, {skillId: "sk_a", refId: "s1"}),
    entry("2026-09-07", 0, {skillId: null}),   // 0 沒有東西可歸屬
  ];
  const out = unassignedEntries(log);
  assert.deepEqual(out.map(e => [e.date, e.xp]), [["2026-09-05", 25], ["2026-09-01", 10]]);
  assert.deepEqual(weeklySummary(stateWith({xpLog: log}), "2026-09-10").unassigned
                     .map(e => e.xp), [25, 10]);
});

// ── 全域連續天數（§5.2）─────────────────────────────────────────────────────
test("全域連續天數中斷後只算到斷點", () => {
  const today = logicalToday();
  const days = d => m.createMeta({activeDays: d.map(n => m.shiftDate(today, -n))});
  assert.equal(globalStreak(days([0, 1, 2]), today), 3);
  assert.equal(globalStreak(days([1, 2, 3]), today), 3, "今天還沒動不算中斷");
  assert.equal(globalStreak(days([0, 1, 3]), today), 2, "中間斷過就停在斷點");
  assert.equal(globalStreak(days([5, 6]), today), 0, "斷太久就是 0");
});

test("跨過 400 天壓縮邊界的長 streak 不被截斷", () => {
  const store = fresh();
  addSkill(store);
  const today = logicalToday();
  const span = XP_LOG_RETENTION_DAYS + 30;

  // activeDays 直接灌一段比保留期限更長的連續紀錄，再走一次 commit：
  // xpLog 會被壓成月彙總，activeDays 不該跟著被壓（§5.2）。
  const state = store.getState();
  const activeDays = Array.from({length: span}, (_, i) => m.shiftDate(today, -(span - 1 - i)));
  const oldLog = activeDays.map((d, i) =>
    m.createXpEntry({date: d, xp: 10, skillId: "sk_a", refId: `s${i}`}));
  store.replaceAll({...state, meta: {...state.meta, activeDays}, xpLog: oldLog});

  const after = store.getState();
  assert.ok(after.xpLog.some(e => e.source === m.XP_SOURCE.ROLLUP),
            "超過保留期限的紀錄應該被壓成月彙總");
  assert.equal(after.meta.activeDays.length, span, "activeDays 不該被壓縮");
  assert.equal(globalStreak(after.meta, today), span,
               "長 streak 不該在 400 天邊界被截斷");
});
