import {test} from "node:test";
import assert from "node:assert/strict";
import {createStore, STORAGE_KEY, LEGACY_PWA_KEY, LEGACY_GOALS_KEY, BACKUP_KEY}
  from "../src/store.js";
import * as m from "../src/model.js";

function backend(seed = {}){
  const map = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {map.set(k, String(v));},
    raw: k => JSON.parse(map.get(k)),
    has: k => map.has(k),
  };
}

const PWA = {
  charName: "阿維",
  subSkills: [{id: 1, coreId: "body", name: "重訓", type: "active", xp: 80}],
  quests: [{id: 100, title: "報名馬拉松", type: "main", dueDate: "2026-09-01",
            rewards: [{skillId: 1, xp: 60}], done: false,
            createdAt: "2026-08-01T00:00:00.000Z"}],
};
const GOALS = {
  version: 1,
  goals: [{id: "g1", title: "跑完半馬", why: "體力", status: "active"}],
  steps: [{id: "s1", goalId: "g1", title: "買鞋", order: 0, state: "•"}],
};

test("首次載入會遷移舊資料，並且一筆都不動舊 key", () => {
  const be = backend({[LEGACY_PWA_KEY]: PWA, [LEGACY_GOALS_KEY]: GOALS});
  const store = createStore(be);
  store.load();

  assert.equal(store.migrationReport().migrated, true);
  assert.equal(be.raw(STORAGE_KEY).version, 2);
  // 舊 key 是最後的回退路徑，遷移不得刪也不得改
  assert.deepEqual(be.raw(LEGACY_PWA_KEY), PWA);
  assert.deepEqual(be.raw(LEGACY_GOALS_KEY), GOALS);
});

test("遷移前先留一份原樣快照", () => {
  const be = backend({[LEGACY_PWA_KEY]: PWA, [LEGACY_GOALS_KEY]: GOALS});
  createStore(be).load();
  const backup = be.raw(BACKUP_KEY);
  assert.deepEqual(backup[LEGACY_PWA_KEY], PWA);
  assert.deepEqual(backup[LEGACY_GOALS_KEY], GOALS);
  assert.ok(backup.savedAt, "要記錄備份時間");
});

test("已經有快照就不覆寫，避免第二次遷移把第一份蓋掉", () => {
  const be = backend({[LEGACY_PWA_KEY]: PWA, [BACKUP_KEY]: {savedAt: "早就存了"}});
  createStore(be).load();
  assert.equal(be.raw(BACKUP_KEY).savedAt, "早就存了");
});

test("第二次載入直接讀 v2，不再跑遷移", () => {
  const be = backend({[LEGACY_PWA_KEY]: PWA, [LEGACY_GOALS_KEY]: GOALS});
  createStore(be).load();
  const first = be.raw(STORAGE_KEY);

  const again = createStore(be);
  again.load();
  assert.equal(again.migrationReport().migrated, false);
  assert.deepEqual(again.getState().steps.map(s => s.id), first.steps.map(s => s.id));
});

test("完全沒有舊資料時也能開起來", () => {
  const store = createStore(backend());
  const state = store.load();
  assert.equal(store.migrationReport().migrated, false);
  assert.equal(state.cores.length, 9);
  assert.deepEqual(state.goals, []);
});

test("每個核心都會補上一個承接技能，而且不外流到 legacy 檢視", () => {
  const store = createStore(backend({[LEGACY_PWA_KEY]: PWA}));
  store.load();
  const skills = store.getState().skills;
  const general = skills.filter(s => s.builtin);
  assert.equal(general.length, 9, "9 個核心各一個");
  assert.ok(general.every(s => s.id === m.generalSkillId(s.coreId)));
  // 它是系統產生的容器，不是使用者建立的技能，畫面上不該多出來
  assert.deepEqual(store.legacyState().subSkills.map(s => s.id), ["sk_1"]);
});

test("承接技能的 XP 為 0，不會改到既有的核心等級", () => {
  const store = createStore(backend({[LEGACY_PWA_KEY]: PWA}));
  store.load();
  assert.equal(store.coreXp("body"), 80);
});

// ── 高水位 ───────────────────────────────────────────────────────────────────
test("inboxPeak 記的是待處理數，處理完之後不會退回去", () => {
  const store = createStore(backend());
  store.load();
  for(const t of ["a", "b", "c"]) store.addStep({title: t});
  assert.equal(store.getState().meta.inboxPeak, 3);

  const ids = store.inboxSteps().map(s => s.id);
  store.completeStep(ids[0]);
  store.noteStep(ids[1]);
  store.dropStep(ids[2]);
  assert.equal(store.inboxPending().length, 0, "畫面上已經清空");
  assert.equal(store.getState().meta.inboxPeak, 3, "高水位是歷史，不能跟著退");
});

test("已完成的收件匣項目不會把高水位灌高", () => {
  const be = backend({[STORAGE_KEY]: {
    version: 2, cores: [], skills: [], goals: [],
    steps: [{id: "s1", goalId: null, kind: "inbox", title: "早就做完了",
             order: 0, state: "×"}],
  }});
  const store = createStore(be);
  store.load();
  assert.equal(store.getState().meta.inboxPeak, 0);
});

// ── legacy 投影 ──────────────────────────────────────────────────────────────
test("legacy 投影往返之後任務內容不變", () => {
  const store = createStore(backend({[LEGACY_PWA_KEY]: PWA, [LEGACY_GOALS_KEY]: GOALS}));
  store.load();
  const before = store.legacyState();
  store.saveLegacyState(before);
  assert.deepEqual(store.legacyState(), before);
});

test("legacy 存檔只動 quest，不碰 Goal / Step 層", () => {
  const store = createStore(backend({[LEGACY_PWA_KEY]: PWA, [LEGACY_GOALS_KEY]: GOALS}));
  store.load();
  const state = store.legacyState();
  state.quests[0].title = "改過的標題";
  store.saveLegacyState(state);

  assert.equal(store.goalSteps("g1").map(s => s.title).join(), "買鞋");
  assert.equal(store.legacyState().quests[0].title, "改過的標題");
});

test("legacy 存檔不會把順延狀態抹平成待辦", () => {
  const store = createStore(backend({[LEGACY_PWA_KEY]: PWA}));
  store.load();
  store.deferStep("q_100");
  // 任務頁只知道 done 或不 done，存一次不該把別的狀態洗掉
  store.saveLegacyState(store.legacyState());
  const step = store.getState().steps.find(s => s.id === "q_100");
  assert.equal(step.state, m.STEP_STATE.DEFERRED);
  assert.equal(step.deferCount, 1);
});

test("新建立的任務與技能拿到合法 id", () => {
  const store = createStore(backend());
  store.load();
  const state = store.legacyState();
  state.subSkills.push({id: "sk_9001", coreId: "body", name: "游泳", type: "active", xp: 0});
  state.quests.push({id: "q_9002", title: "報名泳訓", type: "side", done: false});
  store.saveLegacyState(state);
  assert.ok(store.getState().skills.some(s => s.id === "sk_9001"));
  assert.ok(store.getState().steps.some(s => s.id === "q_9002"));
});

test("刪除核心是一筆交易：技能、承接技能、reward、goal 綁定一起清掉", () => {
  const store = createStore(backend({[LEGACY_PWA_KEY]: PWA, [LEGACY_GOALS_KEY]: GOALS}));
  store.load();
  store.updateGoal("g1", {coreId: "body"});
  assert.deepEqual(store.getState().steps.find(s => s.id === "q_100").rewards,
                   [{skillId: "sk_1", xp: 60}]);

  const state = store.legacyState();
  state.cores = state.cores.filter(c => c.id !== "body");
  state.subSkills = state.subSkills.filter(s => s.coreId !== "body");
  store.saveLegacyState(state);

  const after = store.getState();
  assert.ok(!after.cores.some(c => c.id === "body"));
  assert.ok(!after.skills.some(c => c.coreId === "body"), "承接技能也要跟著走");
  assert.deepEqual(after.steps.find(s => s.id === "q_100").rewards, [],
                   "指向已刪技能的獎勵不能留成懸空參照");
  assert.equal(after.goals.find(g => g.id === "g1").coreId, null);
});

// ── 匯出 / 匯入 ──────────────────────────────────────────────────────────────
test("匯入 v2 備份直接吃", () => {
  const src = createStore(backend({[LEGACY_PWA_KEY]: PWA}));
  src.load();
  const dump = src.toJSON();

  const store = createStore(backend());
  store.load();
  store.replaceAll(dump);
  assert.equal(store.getState().profile.charName, "阿維");
  assert.ok(store.getState().steps.some(s => s.id === "q_100"));
});

test("匯入 v1 備份走同一條遷移路徑", () => {
  const store = createStore(backend());
  store.load();
  store.replaceAll({...PWA, goals: GOALS.goals, steps: GOALS.steps});
  const state = store.getState();
  assert.equal(state.profile.charName, "阿維");
  assert.deepEqual(state.skills.filter(s => !s.builtin).map(s => s.id), ["sk_1"]);
  assert.ok(state.goals.some(g => g.id === "g1"));
});

test("全新安裝與「使用者清空了資料」分得出來", () => {
  const be = backend();
  const first = createStore(be);
  first.load();
  assert.equal(first.migrationReport().fresh, true, "第一次開就是全新安裝");

  // 再開一次時 v2 已經存在，即使裡面沒有技能也不算全新
  const again = createStore(be);
  again.load();
  assert.equal(again.migrationReport().fresh, false);
});

test("有舊資料可遷移時不算全新安裝", () => {
  const store = createStore(backend({[LEGACY_PWA_KEY]: PWA}));
  store.load();
  const r = store.migrationReport();
  assert.equal(r.migrated, true);
  assert.equal(r.fresh, false);
});
