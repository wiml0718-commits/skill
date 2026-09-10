// 成就（§6.2）：每一條的觸發與不觸發，以及 store 只加不減的解鎖行為。
import {test} from "node:test";
import assert from "node:assert/strict";
import {createStore} from "../src/store.js";
import * as m from "../src/model.js";
import {logicalToday} from "../src/rpg.js";
import {ACHIEVEMENTS, ACHIEVEMENT_IDS, evaluateAchievements, completedSteps,
        bestDailyStreak, globalStreak} from "../src/achievements.js";

const TODAY = logicalToday();

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

// 判定是純函式，直接餵形狀最省事；只有需要 store 行為時才走 store。
function evalWith(patch){
  return evaluateAchievements({
    cores: [], skills: [], goals: [], steps: [], xpLog: [],
    meta: m.createMeta(), ...patch,
  }, TODAY);
}

const core = (id, order) => m.createCore({id, name: id, order});
const daysBack = n => Array.from({length: n}, (_, i) => m.shiftDate(TODAY, -(n - 1 - i)));

test("常數表就是 §6.2 那 15 條，id 不重複", () => {
  assert.equal(ACHIEVEMENTS.length, 15);
  assert.equal(new Set(ACHIEVEMENT_IDS).size, 15);
  for(const a of ACHIEVEMENTS){
    assert.ok(a.name && a.desc && a.icon, `${a.id} 少了顯示欄位`);
  }
});

// ── 完成數 ───────────────────────────────────────────────────────────────────
test("完成數：每日算打卡次數，其餘算完成狀態", () => {
  const steps = [
    m.createStep({title: "a", order: 0, kind: m.STEP_KIND.SIDE, state: m.STEP_STATE.DONE}),
    m.createStep({title: "b", order: 1, kind: m.STEP_KIND.SIDE}),
    m.createStep({title: "c", order: 2, kind: m.STEP_KIND.DAILY, completedCount: 4}),
    // 封存是收納不是沒做過
    m.createStep({title: "d", order: 3, kind: m.STEP_KIND.MAIN,
                  state: m.STEP_STATE.DONE, archived: true}),
  ];
  assert.equal(completedSteps(steps), 6);
  assert.equal(completedSteps([]), 0);
});

test("first_step / steps_10 / steps_50 / steps_100 依完成數解鎖", () => {
  const withCount = n => evalWith({
    steps: [m.createStep({title: "d", order: 0, kind: m.STEP_KIND.DAILY,
                          completedCount: n})],
  });
  assert.ok(!withCount(0).has("first_step"));
  assert.ok(withCount(1).has("first_step"));
  assert.ok(!withCount(9).has("steps_10"));
  assert.ok(withCount(10).has("steps_10"));
  assert.ok(!withCount(49).has("steps_50"));
  assert.ok(withCount(50).has("steps_50"));
  assert.ok(!withCount(99).has("steps_100"));
  assert.ok(withCount(100).has("steps_100"));
});

// ── 連續天數 ─────────────────────────────────────────────────────────────────
test("streak_7 / streak_30 取所有每日任務裡最長的一條", () => {
  const withDays = n => [
    m.createStep({title: "少", order: 0, kind: m.STEP_KIND.DAILY,
                  streakHistory: daysBack(2)}),
    m.createStep({title: "多", order: 1, kind: m.STEP_KIND.DAILY,
                  streakHistory: daysBack(n)}),
  ];
  assert.equal(bestDailyStreak(withDays(7), TODAY), 7);
  assert.ok(!evalWith({steps: withDays(6)}).has("streak_7"));
  assert.ok(evalWith({steps: withDays(7)}).has("streak_7"));
  assert.ok(!evalWith({steps: withDays(29)}).has("streak_30"));
  assert.ok(evalWith({steps: withDays(30)}).has("streak_30"));
  // 非每日的 streakHistory 不算數（model 也不會給它填）
  assert.equal(bestDailyStreak([m.createStep({title: "x", order: 0, kind: m.STEP_KIND.SIDE,
                                              streakHistory: daysBack(9)})], TODAY), 0);
});

test("全域連續天數用 meta.activeDays，算法與每日任務一致", () => {
  assert.equal(globalStreak(m.createMeta({activeDays: daysBack(3)}), TODAY), 3);
  assert.equal(globalStreak(m.createMeta(), TODAY), 0);
  assert.equal(globalStreak(null, TODAY), 0);
});

// ── 等級 ─────────────────────────────────────────────────────────────────────
// 等級由技能 XP 推導，所以直接餵到門檻的 XP。
// LEVEL_XP[lv] 已經是到該等級的累計門檻，不是每級的增量
const xpForLv = lv => m.LEVEL_XP[lv];

function coresWithLevels(levels){
  const cores = levels.map((_, i) => core(`c${i}`, i));
  const skills = levels.map((lv, i) => m.createSkill({
    id: `sk_c${i}`, coreId: `c${i}`, name: `s${i}`, xp: xpForLv(lv),
  }));
  return {cores, skills};
}

test("core_lv10 / 25 / 50 看等級最高的那個核心", () => {
  for(const [lv, id] of [[10, "core_lv10"], [25, "core_lv25"], [50, "core_lv50"]]){
    assert.ok(!evalWith(coresWithLevels([lv - 1, 1])).has(id), `Lv${lv - 1} 不該解 ${id}`);
    assert.ok(evalWith(coresWithLevels([lv, 1])).has(id), `Lv${lv} 該解 ${id}`);
  }
});

test("total_lv50 / total_lv100 看所有核心的等級加總", () => {
  assert.ok(!evalWith(coresWithLevels([24, 25])).has("total_lv50"));
  assert.ok(evalWith(coresWithLevels([25, 25])).has("total_lv50"));
  assert.ok(!evalWith(coresWithLevels([49, 50])).has("total_lv100"));
  assert.ok(evalWith(coresWithLevels([50, 50])).has("total_lv100"));
});

test("all_cores_lv5 要核心數 ≥ 5 且每個都到 Lv5", () => {
  assert.ok(!evalWith(coresWithLevels([9, 9, 9, 9])).has("all_cores_lv5"),
            "只有四個核心不算");
  assert.ok(!evalWith(coresWithLevels([5, 5, 5, 5, 4])).has("all_cores_lv5"),
            "有一個沒到就不算");
  assert.ok(evalWith(coresWithLevels([5, 5, 5, 5, 5])).has("all_cores_lv5"));
  assert.ok(!evalWith({}).has("all_cores_lv5"), "沒有核心不該解鎖");
});

test("first_merge：mergedFrom 不是 null 就算，空陣列也算", () => {
  const skill = mergedFrom => m.createSkill({id: "sk_a", coreId: "body", name: "a",
                                             mergedFrom});
  assert.ok(!evalWith({skills: [skill(null)]}).has("first_merge"));
  assert.ok(evalWith({skills: [skill(["sk_x", "sk_y"])]}).has("first_merge"));
  // 遷移進來的舊合併紀錄只留下 []，那也是「合併過」
  assert.ok(evalWith({skills: [skill([])]}).has("first_merge"));
});

// ── 高水位型（§3.8）──────────────────────────────────────────────────────────
test("inbox_zero：清空且高水位 ≥ 5 才算，兩個條件缺一不可", () => {
  const pending = n => Array.from({length: n}, (_, i) =>
    m.createStep({title: `i${i}`, order: i, kind: m.STEP_KIND.INBOX}));
  const peak = p => m.createMeta({inboxPeak: p});

  assert.ok(!evalWith({steps: pending(5), meta: peak(5)}).has("inbox_zero"),
            "還沒清空");
  assert.ok(!evalWith({steps: [], meta: peak(4)}).has("inbox_zero"),
            "高水位不足");
  assert.ok(evalWith({steps: [], meta: peak(5)}).has("inbox_zero"));
  // 整理成筆記也算清掉：待處理用 isActionable，不是「排除完成與放棄」
  const asNotes = pending(5).map(s => m.noteStep(s));
  assert.ok(evalWith({steps: asNotes, meta: peak(5)}).has("inbox_zero"));
});

test("review_clear：回顧清單清空且高水位 ≥ 3 才算", () => {
  // 進行中卻沒有可行動下一步的目標會進回顧清單
  const stalled = Array.from({length: 3}, (_, i) =>
    m.createGoal({title: `g${i}`, coreId: "body"}));
  const peak = p => m.createMeta({reviewPeak: p});

  assert.ok(!evalWith({goals: stalled, meta: peak(3)}).has("review_clear"),
            "清單還有東西");
  assert.ok(!evalWith({meta: peak(2)}).has("review_clear"), "高水位不足");
  assert.ok(evalWith({meta: peak(3)}).has("review_clear"));
});

// ── store 的解鎖行為 ─────────────────────────────────────────────────────────
test("完成第一個步驟就解鎖 first_step，並且只報一次", () => {
  const store = fresh();
  addSkill(store);
  assert.deepEqual(store.achievements(), []);

  const step = store.addStep({kind: m.STEP_KIND.SIDE, title: "做一件事",
                              rewards: [{skillId: "sk_a", xp: 20}]});
  store.completeStep(step.id);

  const got = store.achievements();
  assert.deepEqual(got.map(a => a.id), ["first_step"]);
  assert.match(got[0].unlockedAt, /^\d{4}-\d{2}-\d{2}T/);

  assert.deepEqual(store.drainUnlocks(), ["first_step"]);
  assert.deepEqual(store.drainUnlocks(), [], "取過就不該再取到第二次");
});

test("成就一旦解鎖不會因資料變動被收回", () => {
  const store = fresh();
  addSkill(store);
  const step = store.addStep({kind: m.STEP_KIND.SIDE, title: "做一件事",
                              rewards: [{skillId: "sk_a", xp: 20}]});
  store.completeStep(step.id);
  assert.deepEqual(store.achievements().map(a => a.id), ["first_step"]);

  // 把那個步驟整個刪掉：完成數回到 0，但成就留著
  store.deleteStep(step.id);
  assert.equal(completedSteps(store.getState().steps), 0);
  assert.deepEqual(store.achievements().map(a => a.id), ["first_step"]);
});

test("inbox_zero 靠高水位判定，重新載入 App 之後仍然解得開", () => {
  const be = backend();
  const store = createStore(be);
  store.load();
  const ids = [];
  for(let i = 0; i < 5; i++) ids.push(store.addStep({title: `捕捉 ${i}`}).id);
  assert.equal(store.getState().meta.inboxPeak, 5);
  assert.deepEqual(store.achievements().map(a => a.id), []);

  // 換一個 store 實例重新載入，模擬關掉 App 再打開
  const reopened = createStore(be);
  reopened.load();
  assert.equal(reopened.getState().meta.inboxPeak, 5);

  // 逐一「完成」而不是刪除或指派（§6.2 的驗收）
  for(const id of ids) reopened.completeStep(id, {coreId: "body"});
  assert.equal(m.inboxPending(reopened.getState().steps).length, 0);
  assert.ok(reopened.achievements().some(a => a.id === "inbox_zero"));
});

test("解鎖順序照常數表，不隨資料順序跳動", () => {
  const store = fresh();
  addSkill(store);
  const step = store.addStep({kind: m.STEP_KIND.SIDE, title: "做一件事",
                              rewards: [{skillId: "sk_a", xp: 20}]});
  store.completeStep(step.id);
  store.drainUnlocks();
  // 一次跨過多個門檻：完成數直接補到 10
  const daily = store.addStep({kind: m.STEP_KIND.DAILY, title: "打卡",
                               rewards: [{skillId: "sk_a", xp: 10}]});
  const s = store.getState();
  const patched = s.steps.map(x => (x.id === daily.id
    ? {...x, completedCount: 9} : x));
  store.replaceAll({...s, steps: patched});

  const order = store.achievements().map(a => a.id);
  const table = ACHIEVEMENT_IDS.filter(id => order.includes(id));
  assert.deepEqual(order, table, "落地順序要與常數表一致");
});
