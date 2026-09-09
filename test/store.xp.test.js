// store 的 XP 引擎（§4）：發放、歸屬、手動調整、合併與 xpLog 上限。
import {test} from "node:test";
import assert from "node:assert/strict";
import {createStore, STORAGE_KEY} from "../src/store.js";
import * as m from "../src/model.js";
import {logicalToday, XP_LOG_RETENTION_DAYS} from "../src/rpg.js";

function backend(seed = {}){
  const map = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {map.set(k, String(v));},
    raw: k => JSON.parse(map.get(k)),
  };
}

const TODAY = logicalToday();

// 空白 store：載入後每個核心都有承接技能，其餘都是空的。
function fresh(){
  const be = backend();
  const store = createStore(be);
  store.load();
  return {store, be};
}

function addSkill(store, {id = "sk_run", coreId = "body", xp = 0} = {}){
  // 技能目前只有 legacy 投影這條建立路徑（UI 的統一是 PR 3 的事）
  const state = store.legacyState();
  store.saveLegacyState({
    ...state,
    subSkills: [...state.subSkills, {id, coreId, name: id, type: "active", xp,
                                     icon: "⭐", desc: "", source: "", notes: []}],
  });
  return id;
}

const xpOf = (store, id) => store.getState().skills.find(s => s.id === id).xp;
const logOf = store => store.getState().xpLog;

test("完成主線步驟：技能 XP 增加、核心等級同步、xpLog 多一筆", () => {
  const {store} = fresh();
  addSkill(store, {id: "sk_run", coreId: "body", xp: 280});
  const goal = store.addGoal({title: "跑完半馬"});
  const step = store.addStep({goalId: goal.id, kind: m.STEP_KIND.MAIN, title: "報名",
                              rewards: [{skillId: "sk_run", xp: 50}]});

  assert.equal(store.coreXp("body"), 280);
  const done = store.completeStep(step.id);

  assert.equal(done.state, m.STEP_STATE.DONE);
  assert.ok(done.completedAt, "完成時間要留下來");
  assert.equal(xpOf(store, "sk_run"), 330);
  assert.equal(store.coreXp("body"), 330);
  assert.equal(m.calcLv(store.coreXp("body")), 2, "跨過 300 就升到 Lv2");

  const log = logOf(store);
  assert.equal(log.length, 1);
  assert.deepEqual(
    {skillId: log[0].skillId, xp: log[0].xp, source: log[0].source, refId: log[0].refId, date: log[0].date},
    {skillId: "sk_run", xp: 50, source: m.XP_SOURCE.STEP, refId: step.id, date: TODAY});
});

test("多筆 rewards 逐筆發放，每筆各自留下紀錄", () => {
  const {store} = fresh();
  addSkill(store, {id: "sk_a", coreId: "body"});
  addSkill(store, {id: "sk_b", coreId: "learn"});
  const step = store.addStep({kind: m.STEP_KIND.SIDE, title: "雙修",
                              rewards: [{skillId: "sk_a", xp: 30}, {skillId: "sk_b", xp: 20}]});
  store.completeStep(step.id);

  assert.equal(xpOf(store, "sk_a"), 30);
  assert.equal(xpOf(store, "sk_b"), 20);
  assert.deepEqual(logOf(store).map(e => [e.skillId, e.xp]), [["sk_a", 30], ["sk_b", 20]]);
});

test("重複完成不重複發放", () => {
  const {store} = fresh();
  addSkill(store, {id: "sk_a"});
  const step = store.addStep({kind: m.STEP_KIND.SIDE, title: "一次就好",
                              rewards: [{skillId: "sk_a", xp: 30}]});
  store.completeStep(step.id);
  store.completeStep(step.id);
  assert.equal(xpOf(store, "sk_a"), 30);
  assert.equal(logOf(store).length, 1);
});

// 遷移進來的 legacy quest：沒有 rewards、也沒有目標可以借 coreId（§4.3.1）。
// 這種形狀只會從舊資料進來，所以直接從 storage 載入而不是用 addStep 建。
function withLegacyStep(patch = {}){
  const be = backend({[STORAGE_KEY]: {
    version: 2,
    profile: {charName: "阿維", schemaVersion: 2, createdAt: null, unassignedXP: 0},
    cores: [{id: "body", name: "身體管理", order: 0, builtin: true},
            {id: "learn", name: "學習能力", order: 1, builtin: true}],
    skills: [], goals: [], achievements: [], xpLog: [],
    meta: {inboxPeak: 0, reviewPeak: 0, activeDays: []},
    steps: [{id: "s_legacy", goalId: null, kind: "main", title: "舊任務", order: 0,
             state: "•", rewards: [], ...patch}],
  }});
  const store = createStore(be);
  store.load();
  return {store, be};
}

test("遷移進來、沒有歸屬的舊任務完成時走未歸屬，不計入任何核心等級", () => {
  const {store} = withLegacyStep();
  store.completeStep("s_legacy");

  const state = store.getState();
  assert.equal(state.profile.unassignedXP, 50, "main 預設 50 XP");
  assert.equal(store.totalLevel(), 2, "未歸屬的 XP 不會讓任何核心升級");
  assert.equal(state.xpLog[0].skillId, null);
  assert.equal(state.xpLog[0].refId, "s_legacy", "事後要找得回是哪個步驟");
});

test("收件匣完成時必須指定核心，沒指定就不完成（§4.3）", () => {
  const {store} = fresh();
  const step = store.addStep({kind: m.STEP_KIND.INBOX, title: "隨手記一筆"});

  assert.throws(() => store.completeStep(step.id), /指定這筆 XP 歸到哪個核心/);
  assert.equal(logOf(store).length, 0, "沒完成就不該留下任何紀錄");
  assert.equal(store.getState().steps[0].state, m.STEP_STATE.TODO);

  store.completeStep(step.id, {coreId: "learn"});
  assert.equal(xpOf(store, m.generalSkillId("learn")), 5, "inbox 預設 5 XP");
  assert.equal(store.getState().profile.unassignedXP, 0, "指定了就不是未歸屬");
});

test("事後指定核心是更新那一筆，不新增紀錄", () => {
  const {store} = withLegacyStep();
  store.completeStep("s_legacy");
  const entryId = logOf(store)[0].id;

  const updated = store.assignXpEntry(entryId, "learn");

  const state = store.getState();
  assert.equal(state.xpLog.length, 1, "總 XP 不能被算兩次");
  assert.equal(updated.skillId, m.generalSkillId("learn"));
  assert.equal(state.profile.unassignedXP, 0);
  assert.equal(store.coreXp("learn"), 50);
  assert.throws(() => store.assignXpEntry(entryId, "body"), /已經歸屬/);
  assert.throws(() => store.assignXpEntry("x_nope", "body"), /找不到 xpLog/);

  const {store: other} = withLegacyStep();
  other.completeStep("s_legacy");
  const pending = logOf(other).find(e => e.skillId === null).id;
  assert.throws(() => other.assignXpEntry(pending, "core_nope"), /找不到 core/);
});

test("goal 綁定核心時，沒有 rewards 的步驟加到承接技能", () => {
  const {store} = fresh();
  const goal = store.addGoal({title: "讀完一本書", coreId: "learn"});
  const step = store.addStep({goalId: goal.id, kind: m.STEP_KIND.MAIN, title: "讀第一章"});
  store.completeStep(step.id);

  assert.equal(xpOf(store, m.generalSkillId("learn")), 50);
  assert.equal(store.getState().profile.unassignedXP, 0);
});

test("承接技能的核心被刪掉時，XP 走未歸屬而不是消失", () => {
  const {store} = fresh();
  const goal = store.addGoal({title: "讀完一本書", coreId: "learn"});
  const step = store.addStep({goalId: goal.id, kind: m.STEP_KIND.MAIN, title: "讀第一章"});
  // 刪除核心是一筆交易：底下的技能連同承接技能一起走，goal.coreId 清成 null
  const legacy = store.legacyState();
  store.saveLegacyState({...legacy, cores: legacy.cores.filter(c => c.id !== "learn")});

  assert.equal(store.getState().goals[0].coreId, null);
  store.completeStep(step.id);
  assert.equal(store.getState().profile.unassignedXP, 50);
  assert.equal(logOf(store)[0].skillId, null);
});

test("單獨刪掉一個子技能時，指向它的 reward 不留懸空參照", () => {
  const {store} = fresh();
  addSkill(store, {id: "sk_a"});
  const step = store.addStep({kind: m.STEP_KIND.SIDE, title: "練習",
                              rewards: [{skillId: "sk_a", xp: 25}]});
  const legacy = store.legacyState();
  store.saveLegacyState({...legacy,
                         subSkills: legacy.subSkills.filter(s => s.id !== "sk_a")});

  assert.deepEqual(store.getState().steps[0].rewards, []);
  // 懸空的 reward 會讓 hasAttribution() 說謊：步驟看起來有歸屬，實際指向不存在
  // 的技能。清掉之後 §4.3 的前門才擋得住，再編輯時會要求重新指定。
  assert.throws(() => store.updateStep(step.id, {title: "練習 2"}), /指定 XP 歸屬/);
  store.completeStep(step.id);
  assert.equal(store.getState().profile.unassignedXP,
               m.KIND_DEFAULT_XP[m.STEP_KIND.SIDE]);
  assert.equal(logOf(store).at(-1).skillId, null);
});

test("每日任務同一天只給一次 XP，也不進 DONE", () => {
  const {store} = fresh();
  addSkill(store, {id: "sk_a"});
  const step = store.addStep({kind: m.STEP_KIND.DAILY, title: "喝水",
                              rewards: [{skillId: "sk_a", xp: 10}]});
  const first = store.completeStep(step.id);
  const second = store.completeStep(step.id);

  assert.equal(first.state, m.STEP_STATE.TODO, "每日任務不進 DONE，隔天又是待辦");
  assert.deepEqual(first.streakHistory, [TODAY]);
  assert.equal(first.completedCount, 1);
  assert.equal(first.lastCompletedDate, TODAY);
  assert.deepEqual(second.streakHistory, [TODAY], "重複完成不重複打卡");
  assert.equal(second.completedCount, 1);
  assert.equal(xpOf(store, "sk_a"), 10);
  assert.equal(logOf(store).length, 1);
});

test("補登：XP 記在被補登的那一天，超過 3 天就擋下來", () => {
  const {store} = fresh();
  addSkill(store, {id: "sk_a"});
  const step = store.addStep({kind: m.STEP_KIND.DAILY, title: "冥想",
                              rewards: [{skillId: "sk_a", xp: 10}]});
  const twoDaysAgo = shiftDays(TODAY, -2);

  const after = store.backfillDaily(step.id, twoDaysAgo);
  assert.deepEqual(after.streakHistory, [twoDaysAgo]);
  assert.equal(after.lastCompletedDate, twoDaysAgo);
  assert.equal(logOf(store)[0].date, twoDaysAgo);
  assert.ok(store.getState().meta.activeDays.includes(twoDaysAgo), "補登併入被補登的那一天");

  assert.throws(() => store.backfillDaily(step.id, shiftDays(TODAY, -4)), /3 天/);
  assert.throws(() => store.backfillDaily(step.id, shiftDays(TODAY, 1)), /3 天/);
  // 今天完成之後 lastCompletedDate 走比較晚的那天，不會被補登往回拉
  store.completeStep(step.id);
  assert.equal(store.getState().steps[0].lastCompletedDate, TODAY);
  store.backfillDaily(step.id, shiftDays(TODAY, -1));
  assert.equal(store.getState().steps[0].lastCompletedDate, TODAY);
});

test("非每日任務不能補登", () => {
  const {store} = fresh();
  addSkill(store, {id: "sk_a"});
  const step = store.addStep({kind: m.STEP_KIND.SIDE, title: "側寫",
                              rewards: [{skillId: "sk_a", xp: 20}]});
  assert.throws(() => store.backfillDaily(step.id, TODAY), /只有每日任務/);
});

test("手動加分寫入 manual 紀錄，xpLog 加總等於目前 XP", () => {
  const {store} = fresh();
  addSkill(store, {id: "sk_a", xp: 0});
  store.adjustSkillXp("sk_a", 10);
  store.adjustSkillXp("sk_a", 100);
  const skill = store.setSkillXp("sk_a", 60);

  assert.equal(skill.xp, 60);
  const log = logOf(store);
  assert.deepEqual(log.map(e => e.xp), [10, 100, -50]);
  assert.ok(log.every(e => e.source === m.XP_SOURCE.MANUAL));
  assert.equal(log.reduce((a, e) => a + e.xp, 0), xpOf(store, "sk_a"));
});

test("扣減量超過現有 XP 時只扣到 0，記錄的是實際變動量", () => {
  const {store} = fresh();
  addSkill(store, {id: "sk_a", xp: 30});
  store.adjustSkillXp("sk_a", -100);

  assert.equal(xpOf(store, "sk_a"), 0);
  assert.deepEqual(logOf(store).map(e => e.xp), [-30]);
  // 已經是 0 再扣就什麼都沒發生，不留一筆 0 的假紀錄
  store.adjustSkillXp("sk_a", -10);
  assert.equal(logOf(store).length, 1);
  assert.throws(() => store.setSkillXp("sk_a", -1), /非負整數/);
  assert.throws(() => store.adjustSkillXp("sk_nope", 10), /找不到 skill/);
});

test("過期的 legacy 快照回寫不會還原已發放的 XP", () => {
  const {store} = fresh();
  addSkill(store, {id: "sk_a", coreId: "body", xp: 100});
  // 目標頁完成一個步驟之後，index.html 手上那份快照還停在發放前
  const stale = store.legacyState();
  const step = store.addStep({kind: m.STEP_KIND.SIDE, title: "做一件事",
                              rewards: [{skillId: "sk_a", xp: 30}]});
  store.completeStep(step.id);
  assert.equal(xpOf(store, "sk_a"), 130);

  // 之後隨便一次 saveName() / saveQuest() 都會用那份舊快照回寫
  store.saveLegacyState({...stale, charName: "改個名字"});

  assert.equal(xpOf(store, "sk_a"), 130, "XP 只由 XP 引擎改，不吃快照帶回來的數字");
  assert.equal(logOf(store).length, 1, "xpLog 也不該多出或少掉紀錄");
});

test("合併技能：總 XP 不變，紀錄金額為 0", () => {
  const {store} = fresh();
  addSkill(store, {id: "sk_a", coreId: "body", xp: 120});
  addSkill(store, {id: "sk_b", coreId: "body", xp: 80});
  const before = store.coreXp("body");

  const merged = store.mergeSkills({sourceIds: ["sk_a", "sk_b"], coreId: "body",
                                    name: "體能", icon: "🏋️"});

  assert.equal(merged.xp, 200);
  assert.deepEqual(merged.mergedFrom, ["sk_a", "sk_b"]);
  assert.equal(store.coreXp("body"), before, "合併不會平白產生或蒸發等級");
  assert.equal(store.getState().skills.filter(s => s.id === "sk_a").length, 0);

  const entry = logOf(store).at(-1);
  assert.equal(entry.source, m.XP_SOURCE.MERGE);
  assert.equal(entry.xp, 0, "寫進實際金額會讓當天的成果數字整批膨脹");
});

test("合併會把指向來源技能的獎勵改指新技能", () => {
  const {store} = fresh();
  addSkill(store, {id: "sk_a", coreId: "body", xp: 10});
  addSkill(store, {id: "sk_b", coreId: "body", xp: 10});
  const step = store.addStep({kind: m.STEP_KIND.SIDE, title: "兩邊都練",
                              rewards: [{skillId: "sk_a", xp: 30}, {skillId: "sk_b", xp: 20}]});
  const merged = store.mergeSkills({sourceIds: ["sk_a", "sk_b"], coreId: "body", name: "體能"});

  // 同一個步驟獎勵兩個被合併的技能：併成一筆，不然完成時會多發一次
  assert.deepEqual(store.getState().steps.find(s => s.id === step.id).rewards,
                   [{skillId: merged.id, xp: 50}]);
  store.completeStep(step.id);
  assert.equal(xpOf(store, merged.id), 70);
});

test("承接技能與單一技能都不能合併", () => {
  const {store} = fresh();
  addSkill(store, {id: "sk_a", coreId: "body"});
  assert.throws(() => store.mergeSkills({sourceIds: ["sk_a"], coreId: "body", name: "x"}),
                /至少需要兩個/);
  assert.throws(() => store.mergeSkills({
    sourceIds: ["sk_a", m.generalSkillId("body")], coreId: "body", name: "x"}),
                /承接技能/);
});

test("activeDays 只收 step 與 manual", () => {
  const {store} = fresh();
  addSkill(store, {id: "sk_a", coreId: "body", xp: 10});
  addSkill(store, {id: "sk_b", coreId: "body", xp: 10});
  const step = store.addStep({kind: m.STEP_KIND.SIDE, title: "做一件事",
                              rewards: [{skillId: "sk_a", xp: 5}]});
  store.completeStep(step.id);
  store.adjustSkillXp("sk_a", 10);
  store.mergeSkills({sourceIds: ["sk_a", "sk_b"], coreId: "body", name: "體能"});

  assert.deepEqual(store.getState().meta.activeDays, [TODAY], "同一天只記一次，merge 不併入");
});

test("xpLog 上限在 store 層強制執行，載入時就壓成月彙總", () => {
  const old = shiftDays(TODAY, -(XP_LOG_RETENTION_DAYS + 30));
  const month = `${old.slice(0, 7)}-01`;
  const be = backend({[STORAGE_KEY]: {
    version: 2,
    profile: {charName: "阿維", schemaVersion: 2, createdAt: null, unassignedXP: 0},
    cores: [], skills: [], goals: [], steps: [], achievements: [],
    meta: {inboxPeak: 0, reviewPeak: 0, activeDays: []},
    xpLog: [
      {id: "x_1", date: old, skillId: "sk_a", xp: 10, source: "step", refId: "s1"},
      {id: "x_2", date: old, skillId: "sk_a", xp: 15, source: "step", refId: "s2"},
      {id: "x_3", date: TODAY, skillId: "sk_a", xp: 5, source: "step", refId: "s3"},
    ],
  }});
  const store = createStore(be);
  store.load();

  const log = store.getState().xpLog;
  assert.equal(log.length, 2);
  assert.deepEqual([log[0].date, log[0].xp, log[0].source, log[0].refId],
                   [month, 25, m.XP_SOURCE.ROLLUP, null]);
  assert.equal(log[1].id, "x_3");
  // 寫回去的內容也是壓縮過的，不是只有記憶體裡壓
  assert.equal(be.raw(STORAGE_KEY).xpLog.length, 2);

  // 往返載入：自己寫出的彙總再讀回來要原封不動，也不能被當成髒資料丟掉
  const again = createStore(be);
  again.load();
  assert.equal(again.migrationReport().skippedXpLog, 0);
  assert.deepEqual(again.getState().xpLog, log);
});

test("rollup 紀錄能通過載入驗證，不會被當成髒資料丟掉", () => {
  const be = backend({[STORAGE_KEY]: {
    version: 2,
    profile: {charName: "阿維", schemaVersion: 2, createdAt: null, unassignedXP: 0},
    cores: [], skills: [], goals: [], steps: [], achievements: [],
    meta: {inboxPeak: 0, reviewPeak: 0, activeDays: []},
    xpLog: [{id: "x_r", date: "2025-01-01", skillId: "sk_a", xp: 500,
             source: "rollup", refId: null}],
  }});
  const store = createStore(be);
  store.load();

  assert.equal(store.migrationReport().skippedXpLog, 0);
  assert.deepEqual(store.getState().xpLog.map(e => [e.id, e.xp]), [["x_r", 500]]);
});

test("未歸屬的紀錄再舊也不壓成 rollup", () => {
  const old = shiftDays(TODAY, -(XP_LOG_RETENTION_DAYS + 60));
  const be = backend({[STORAGE_KEY]: {
    version: 2,
    profile: {charName: "阿維", schemaVersion: 2, createdAt: null, unassignedXP: 70},
    cores: [], skills: [], goals: [], steps: [], achievements: [],
    meta: {inboxPeak: 0, reviewPeak: 0, activeDays: []},
    xpLog: [
      {id: "x_1", date: old, skillId: null, xp: 50, source: "step", refId: "s1"},
      {id: "x_2", date: old, skillId: null, xp: 20, source: "step", refId: "s2"},
    ],
  }});
  const store = createStore(be);
  store.load();

  const log = store.getState().xpLog;
  assert.deepEqual(log.map(e => e.id), ["x_1", "x_2"]);
  assert.deepEqual(log.map(e => e.refId), ["s1", "s2"]);
});

// 兩個日期字串相差幾天。測試自己算，不依賴被測程式的實作。
function shiftDays(iso, days){
  const [y, mo, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d + days));
  const pad = n => String(n).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}
