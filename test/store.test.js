import {test} from "node:test";
import assert from "node:assert/strict";
import {createStore, STORAGE_KEY} from "../src/store.js";
import {STEP_STATE} from "../src/model.js";

// 假 backend：只實作 getItem / setItem，證明 store 不依賴 localStorage 本身。
function fakeBackend(seed = null){
  const m = new Map();
  if(seed !== null) m.set(STORAGE_KEY, JSON.stringify(seed));
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => {m.set(k, String(v));},
    raw: () => JSON.parse(m.get(STORAGE_KEY)),
  };
}

function seeded(){
  const store = createStore(fakeBackend());
  store.load();
  const goal = store.addGoal({title: "跑完半馬", why: "體力"});
  const a = store.addStep({goalId: goal.id, title: "報名"});
  const b = store.addStep({goalId: goal.id, title: "買鞋"});
  return {store, goal, a, b};
}

test("空 backend 載入為空資料", () => {
  const store = createStore(fakeBackend());
  const s = store.load();
  assert.deepEqual(s.goals, []);
  assert.deepEqual(s.steps, []);
});

test("新增之後即寫入 backend，重新載入拿得回來", () => {
  const backend = fakeBackend();
  const store = createStore(backend);
  store.load();
  const goal = store.addGoal({title: "跑完半馬"});
  store.addStep({goalId: goal.id, title: "報名"});

  const reloaded = createStore(backend);
  reloaded.load();
  assert.equal(reloaded.getState().goals.length, 1);
  assert.equal(reloaded.getState().steps[0].title, "報名");
  assert.equal(backend.raw().goals[0].title, "跑完半馬");
});

test("addStep 依序遞增 order，各目標獨立", () => {
  const {store, goal, a, b} = seeded();
  assert.equal(a.order, 0);
  assert.equal(b.order, 1);
  const other = store.addGoal({title: "存錢"});
  assert.equal(store.addStep({goalId: other.id, title: "記帳"}).order, 0);
});

test("addStep 指向不存在的目標會拋錯", () => {
  const {store} = seeded();
  assert.throws(() => store.addStep({goalId: "nope", title: "x"}), /找不到 goal/);
});

test("完成下一步之後，store 推導出的下一步換人", () => {
  const {store, goal, a, b} = seeded();
  assert.equal(store.nextStep(goal.id).id, a.id);
  store.completeStep(a.id);
  assert.equal(store.nextStep(goal.id).id, b.id);
  store.completeStep(b.id);
  assert.equal(store.nextStep(goal.id), null);
});

test("順延不會讓步驟失去下一步資格", () => {
  const {store, goal, a} = seeded();
  const deferred = store.deferStep(a.id);
  assert.equal(deferred.state, STEP_STATE.DEFERRED);
  assert.equal(store.nextStep(goal.id).id, a.id);
});

test("排程寫入到期日，格式錯誤時拋錯且不改動資料", () => {
  const {store, a} = seeded();
  assert.equal(store.scheduleStep(a.id, "2026-09-01").due, "2026-09-01");
  assert.throws(() => store.scheduleStep(a.id, "9/1"), /YYYY-MM-DD/);
  assert.equal(store.getState().steps.find(s => s.id === a.id).due, "2026-09-01");
});

test("操作不存在的 step 會拋錯", () => {
  const {store} = seeded();
  assert.throws(() => store.completeStep("nope"), /找不到 step/);
});

test("getState 回傳複本，外部改動不會污染 store", () => {
  const {store, goal} = seeded();
  const snapshot = store.getState();
  snapshot.goals.push({id: "x"});
  snapshot.steps.length = 0;
  assert.equal(store.getState().goals.length, 1);
  assert.equal(store.getState().steps.length, 2);
  assert.equal(store.nextStep(goal.id).title, "報名");
});

test("收件匣項目歸入目標時排到最後，不搶走現有的下一步", () => {
  const {store, goal, a} = seeded();
  const captured = store.addStep({title: "找跑團"});
  assert.equal(captured.goalId, null);
  assert.deepEqual(store.inboxSteps().map(s => s.title), ["找跑團"]);

  const moved = store.assignStep(captured.id, goal.id);
  assert.equal(moved.goalId, goal.id);
  assert.equal(moved.order, 2);
  assert.deepEqual(store.inboxSteps(), []);
  assert.equal(store.nextStep(goal.id).id, a.id, "既有的下一步不應被插隊");
});

test("todayList 每個進行中目標各一個下一步，封存的不列入", () => {
  const {store, goal, a} = seeded();
  const other = store.addGoal({title: "存錢"});
  const c = store.addStep({goalId: other.id, title: "記帳"});
  const archived = store.addGoal({title: "舊目標"});
  store.addStep({goalId: archived.id, title: "殘留"});
  store.setGoalStatus(archived.id, "archived");

  assert.deepEqual(
    store.todayList().map(x => [x.goal.id, x.step.id]),
    [[goal.id, a.id], [other.id, c.id]],
  );
});

test("goalProgress 反映完成進度", () => {
  const {store, goal, a} = seeded();
  store.completeStep(a.id);
  assert.deepEqual(store.goalProgress(goal.id), {total: 2, done: 1, notes: 0, remaining: 1});
});

test("損毀的 JSON 視同空資料，不丟例外", () => {
  const backend = {getItem: () => "{ 不是 JSON", setItem: () => {}};
  const store = createStore(backend);
  assert.doesNotThrow(() => store.load());
  assert.deepEqual(store.getState().goals, []);
});

test("載入時丟掉壞掉的單筆，保留其餘資料", () => {
  const backend = fakeBackend({
    version: 1,
    goals: [{id: "g1", title: "好目標", why: "", status: "active"}, {id: "g2", title: "   "}],
    steps: [
      {id: "s1", goalId: "g1", title: "好步驟", due: null, order: 0, state: "•"},
      {id: "s2", goalId: "g1", title: "壞狀態", due: null, order: 1, state: "?"},
    ],
  });
  const store = createStore(backend);
  store.load();
  assert.deepEqual(store.getState().goals.map(g => g.id), ["g1"]);
  assert.deepEqual(store.getState().steps.map(s => s.id), ["s1"]);
});

test("指向不存在目標的步驟退回收件匣，不被丟棄", () => {
  const backend = fakeBackend({
    version: 1,
    goals: [],
    steps: [{id: "s1", goalId: "ghost", title: "孤兒", due: null, order: 0, state: "•"}],
  });
  const store = createStore(backend);
  store.load();
  assert.deepEqual(store.inboxSteps().map(s => s.title), ["孤兒"]);
});

test("replaceAll 用於匯入備份，會覆蓋並寫回 backend", () => {
  const backend = fakeBackend();
  const store = createStore(backend);
  store.load();
  store.addGoal({title: "舊的"});

  store.replaceAll({
    version: 1,
    goals: [{id: "g9", title: "匯入的目標", why: "", status: "active"}],
    steps: [{id: "s9", goalId: "g9", title: "匯入的步驟", due: null, order: 0, state: "•"}],
  });

  assert.deepEqual(store.getState().goals.map(g => g.title), ["匯入的目標"]);
  assert.equal(backend.raw().steps[0].title, "匯入的步驟");
  assert.equal(store.nextStep("g9").title, "匯入的步驟");
});

test("toJSON 給出可直接寫進備份檔的資料", () => {
  const {store} = seeded();
  const dump = store.toJSON();
  assert.equal(dump.version, 1);
  assert.equal(dump.goals.length, 1);
  assert.equal(dump.steps.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(dump)), dump, "必須可 JSON 序列化");
});

test("backend 寫入失敗時不讓呼叫端崩潰", () => {
  const store = createStore({
    getItem: () => null,
    setItem: () => {throw new Error("QuotaExceeded");},
  });
  store.load();
  assert.doesNotThrow(() => store.addGoal({title: "仍可操作"}));
  assert.equal(store.getState().goals.length, 1);
});
