import {test} from "node:test";
import assert from "node:assert/strict";
import * as rpg from "../src/rpg.js";
import * as m from "../src/model.js";

// ── 日界（§5.0）────────────────────────────────────────────────────────────
test("邏輯日：凌晨 4:00 前算前一天", () => {
  assert.equal(rpg.logicalToday(new Date(2026, 8, 7, 12, 0)), "2026-09-07");
  assert.equal(rpg.logicalToday(new Date(2026, 8, 7, 3, 59)), "2026-09-06");
  assert.equal(rpg.logicalToday(new Date(2026, 8, 7, 4, 0)), "2026-09-07");
  assert.equal(rpg.logicalToday(new Date(2026, 8, 7, 23, 59)), "2026-09-07");
  // 跨月與跨年的邊界也要跟著退一天
  assert.equal(rpg.logicalToday(new Date(2026, 9, 1, 0, 30)), "2026-09-30");
  assert.equal(rpg.logicalToday(new Date(2027, 0, 1, 2, 0)), "2026-12-31");
  // 日光節約時間切換當天，日界仍然落在本地時間 04:00：減 4 小時的「時間量」
  // 會在那天把界線推到 05:00（在 America/New_York 這類時區跑才看得出差別）。
  assert.equal(rpg.logicalToday(new Date(2026, 2, 8, 4, 0)), "2026-03-08");
  assert.equal(rpg.logicalToday(new Date(2026, 2, 8, 3, 59)), "2026-03-07");
  assert.equal(rpg.logicalToday(new Date(2026, 10, 1, 4, 0)), "2026-11-01");
});

// ── 等級（§4.1、§6.1）──────────────────────────────────────────────────────
test("階層名沿用既有級距", () => {
  assert.equal(rpg.lvName(1), "初學者");
  assert.equal(rpg.lvName(5), "初學者");
  assert.equal(rpg.lvName(6), "見習生");
  assert.equal(rpg.lvName(41), "宗師");
  assert.equal(rpg.lvName(99), "神域");
});

test("等級進度：Lv1 從 0 起算，不會算出負的", () => {
  for(const xp of [0, 1, 50, 99, 299]){
    const p = rpg.levelProgress(xp);
    assert.equal(p.lv, 1);
    assert.ok(p.pct >= 0 && p.pct <= 100, `${xp} XP 的進度不該是 ${p.pct}%`);
    assert.ok(p.cur >= 0, `${xp} XP 的已累積不該是 ${p.cur}`);
  }
  assert.deepEqual(rpg.levelProgress(0), {lv: 1, pct: 0, cur: 0, need: 300});
  assert.deepEqual(rpg.levelProgress(150), {lv: 1, pct: 50, cur: 150, need: 300});
  // Lv2 起以門檻為基準，數值與既有曲線一致
  assert.deepEqual(rpg.levelProgress(300), {lv: 2, pct: 0, cur: 0, need: 300});
  assert.deepEqual(rpg.levelProgress(450), {lv: 2, pct: 50, cur: 150, need: 300});
});

test("滿級之後進度停在 100%", () => {
  const p = rpg.levelProgress(m.LEVEL_XP[m.MAX_LV] + 999);
  assert.equal(p.lv, m.MAX_LV);
  assert.equal(p.pct, 100);
  assert.equal(p.need, 0);
});

const core = (id, order) => m.createCore({id, name: id, order});
const skill = (id, coreId, xp) => m.createSkill({id, coreId, name: id, xp});

test("稱號取等級最高的核心，同分時取 order 較前者", () => {
  const cores = [core("body", 0), core("learn", 1)];
  const skills = [skill("sk_a", "body", 300), skill("sk_b", "learn", 900)];
  assert.equal(rpg.charTitle(cores, skills), `learn・${rpg.lvName(m.calcLv(900))}`);
  // 同分：order 較前的 body 贏，重算幾次都一樣
  const tied = [skill("sk_a", "body", 300), skill("sk_b", "learn", 300)];
  assert.equal(rpg.charTitle(cores, tied), `body・${rpg.lvName(2)}`);
  assert.equal(rpg.charTitle(cores, tied), `body・${rpg.lvName(2)}`);
  assert.equal(rpg.charTitle([], []), "", "沒有核心時不編一個稱號出來");
});

test("屬性推導照目前實際核心數，不假設剛好 9 個", () => {
  const cores = [core("body", 0), core("core_diy", 1)];
  const levels = rpg.coreLevels(cores, [skill("sk_a", "body", 300)]);
  assert.equal(levels.length, 2);
  assert.deepEqual(levels.map(l => l.lv), [2, 1]);
  assert.deepEqual(levels.map(l => l.xp), [300, 0]);
});

// ── XP 歸屬（§4.2–4.3）────────────────────────────────────────────────────
const step = (patch = {}) => m.createStep({title: "t", order: 0, ...patch});

test("四種 kind 的預設 XP", () => {
  const skills = [];
  for(const [kind, xp] of Object.entries(m.KIND_DEFAULT_XP)){
    const grants = rpg.resolveGrants(step({kind}), {skills});
    assert.deepEqual(grants, [{skillId: null, xp}], `${kind} 的預設值應為 ${xp}`);
  }
});

test("rewards 有內容就逐筆發放，可一次加到多個技能", () => {
  const skills = [skill("sk_a", "body", 0), skill("sk_b", "learn", 0)];
  const grants = rpg.resolveGrants(
    step({rewards: [{skillId: "sk_a", xp: 30}, {skillId: "sk_b", xp: 20}]}), {skills});
  assert.deepEqual(grants, [{skillId: "sk_a", xp: 30}, {skillId: "sk_b", xp: 20}]);
});

test("rewards 為空時退回所屬 goal 的承接技能", () => {
  const goals = [m.createGoal({id: "g1", title: "g", coreId: "body"})];
  const skills = [m.createSkill({id: m.generalSkillId("body"), coreId: "body",
                                 name: "歷練", builtin: true})];
  assert.deepEqual(rpg.resolveGrants(step({goalId: "g1", kind: "main"}), {goals, skills}),
    [{skillId: "sk_body_general", xp: 50}]);
});

test("承接技能不存在時走未歸屬，不建立技能也不丟掉 XP", () => {
  const goals = [m.createGoal({id: "g1", title: "g", coreId: "body"})];
  assert.deepEqual(rpg.resolveGrants(step({goalId: "g1", kind: "side"}), {goals, skills: []}),
    [{skillId: null, xp: 20}]);
});

test("指向不存在技能的 reward 同樣走未歸屬", () => {
  const grants = rpg.resolveGrants(step({rewards: [{skillId: "sk_gone", xp: 40}]}), {skills: []});
  assert.deepEqual(grants, [{skillId: null, xp: 40}]);
});

test("步驟自訂的 xp 覆蓋 kind 預設值", () => {
  assert.deepEqual(rpg.resolveGrants(step({kind: "daily", xp: 3}), {}), [{skillId: null, xp: 3}]);
  assert.deepEqual(rpg.resolveGrants(step({kind: "daily", xp: 0}), {}), [{skillId: null, xp: 0}]);
});

// ── 補登（§5.1）───────────────────────────────────────────────────────────
test("補登窗口是過去 3 天，未來的日期不算", () => {
  assert.equal(rpg.canBackfill("2026-09-07", "2026-09-07"), true);
  assert.equal(rpg.canBackfill("2026-09-04", "2026-09-07"), true);
  assert.equal(rpg.canBackfill("2026-09-03", "2026-09-07"), false);
  assert.equal(rpg.canBackfill("2026-09-08", "2026-09-07"), false);
});

// ── xpLog 壓縮（§3.6）──────────────────────────────────────────────────────
const entry = (date, skillId, xp, source = m.XP_SOURCE.STEP) =>
  m.createXpEntry({date, skillId, xp, source});

test("超過 400 天的紀錄壓成每月每技能一筆", () => {
  const log = [
    entry("2025-01-05", "sk_a", 10),
    entry("2025-01-20", "sk_a", 15),
    entry("2025-01-20", "sk_b", 5),
    entry("2025-02-01", "sk_a", 7),
    entry("2026-09-01", "sk_a", 50),   // 保留期限內，逐筆留著
  ];
  const out = rpg.compressXpLog(log, "2026-09-07");
  const rolled = out.filter(e => e.source === m.XP_SOURCE.ROLLUP);
  assert.equal(rolled.length, 3);
  assert.deepEqual(rolled.map(e => [e.date, e.skillId, e.xp, e.refId]), [
    ["2025-01-01", "sk_a", 25, null],
    ["2025-01-01", "sk_b", 5, null],
    ["2025-02-01", "sk_a", 7, null],
  ]);
  assert.equal(out.filter(e => e.source === m.XP_SOURCE.STEP).length, 1);
  // 總量不因壓縮而改變
  assert.equal(out.reduce((a, e) => a + e.xp, 0), 87);
});

test("壓縮是冪等的：再壓一次金額不變，id 也不換", () => {
  const log = [entry("2025-01-05", "sk_a", 10), entry("2025-01-20", "sk_a", 15)];
  const once = rpg.compressXpLog(log, "2026-09-07");
  const twice = rpg.compressXpLog(once, "2026-09-07");
  assert.deepEqual(twice, once);
});

test("skillId 為 null 的紀錄永遠不壓，待歸屬清單不失真", () => {
  const log = [
    m.createXpEntry({id: "x_old", date: "2020-01-05", skillId: null, xp: 50, refId: "s1"}),
    m.createXpEntry({id: "x_old2", date: "2020-01-09", skillId: null, xp: 20, refId: "s2"}),
  ];
  const out = rpg.compressXpLog(log, "2026-09-07");
  assert.deepEqual(out.map(e => e.id), ["x_old", "x_old2"]);
  assert.deepEqual(out.map(e => e.refId), ["s1", "s2"], "來源步驟不能被清掉");
});

test("沒有東西要壓縮時原樣回傳", () => {
  const log = [entry("2026-09-01", "sk_a", 10)];
  assert.equal(rpg.compressXpLog(log, "2026-09-07"), log);
});

test("負數的手動修正也能壓縮，加總照實反映", () => {
  const log = [entry("2025-01-05", "sk_a", 30, m.XP_SOURCE.MANUAL),
               entry("2025-01-06", "sk_a", -10, m.XP_SOURCE.MANUAL)];
  const out = rpg.compressXpLog(log, "2026-09-07");
  assert.deepEqual(out.map(e => e.xp), [20]);
});

// ── 統計過濾（§4.5、§5.2）────────────────────────────────────────────────
test("每日 / 每週 XP 加總排除 merge 與 rollup", () => {
  const log = [
    entry("2026-09-07", "sk_a", 50),
    entry("2026-09-07", "sk_a", 10, m.XP_SOURCE.MANUAL),
    m.createXpEntry({date: "2026-09-07", skillId: "sk_a", xp: 900, source: m.XP_SOURCE.MERGE}),
    m.createXpEntry({date: "2026-09-01", skillId: "sk_a", xp: 400, source: m.XP_SOURCE.ROLLUP}),
  ];
  assert.equal(rpg.sumXp(log, {from: "2026-09-07", to: "2026-09-07"}), 60);
  assert.equal(rpg.countsAsActivity(m.XP_SOURCE.MERGE), false);
  assert.equal(rpg.countsAsActivity(m.XP_SOURCE.ROLLUP), false);
});
