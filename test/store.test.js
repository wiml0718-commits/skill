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

test("snapshot 內的每一筆紀錄也是複本，不能繞過驗證改到內部資料", () => {
  const {store, goal, a} = seeded();

  // 只複製陣列的話，這行會讓目標立刻從 todayList 消失
  store.getState().goals[0].status = "archived";
  store.toJSON().steps[0].state = STEP_STATE.DONE;

  assert.equal(store.getState().goals[0].status, "active");
  assert.equal(store.getState().steps[0].state, STEP_STATE.TODO);
  assert.equal(store.todayList().length, 1);
  assert.equal(store.nextStep(goal.id).id, a.id);
});

test("推導方法回傳的紀錄同樣是複本", () => {
  const {store, goal, a} = seeded();

  store.nextStep(goal.id).title = "被改掉";
  store.goalSteps(goal.id)[0].order = 999;
  store.todayList()[0].goal.status = "archived";
  const captured = store.addStep({title: "收件匣項目"});
  store.inboxSteps()[0].goalId = goal.id;

  assert.equal(store.getState().steps.find(s => s.id === a.id).title, "報名");
  assert.equal(store.getState().steps.find(s => s.id === a.id).order, 0);
  assert.equal(store.getState().goals[0].status, "active");
  assert.equal(store.getState().steps.find(s => s.id === captured.id).goalId, null);
});

test("save() 回傳的也是複本，不能透過它改到內部狀態", () => {
  const {store, goal, a} = seeded();
  const snapshot = store.save();

  snapshot.goals[0].status = "archived";
  snapshot.steps[0].state = STEP_STATE.DONE;
  snapshot.goals.length = 0;

  assert.equal(store.getState().goals[0].status, "active");
  assert.equal(store.getState().steps[0].state, STEP_STATE.TODO);
  assert.equal(store.getState().goals.length, 1);
  assert.equal(store.todayList().length, 1);
  assert.equal(store.nextStep(goal.id).id, a.id);
});

test("mutation 方法回傳的紀錄也是複本", () => {
  const {store, goal, a} = seeded();
  store.addGoal({title: "另一個"}).title = "被改掉";
  store.completeStep(a.id).state = STEP_STATE.TODO;
  assert.deepEqual(store.getState().goals.map(g => g.title), ["跑完半馬", "另一個"]);
  assert.equal(store.getState().steps.find(s => s.id === a.id).state, STEP_STATE.DONE);
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
  assert.deepEqual(store.goalProgress(goal.id),
    {total: 2, done: 1, notes: 0, dropped: 0, remaining: 1});
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

test("指向不存在目標的步驟退回無目標，不被丟棄", () => {
  const backend = fakeBackend({
    version: 2,
    goals: [],
    steps: [{id: "s1", goalId: "ghost", kind: "main", title: "孤兒",
             due: null, order: 0, state: "•"}],
  });
  const store = createStore(backend);
  store.load();
  // main 的 goalId 允許為 null，所以整筆留著，只是不再屬於任何目標
  const kept = store.getState().steps;
  assert.deepEqual(kept.map(s => [s.title, s.goalId, s.kind]), [["孤兒", null, "main"]]);
});

test("收件匣項目掛著不存在的目標時仍留在收件匣", () => {
  const backend = fakeBackend({
    version: 2,
    goals: [],
    steps: [{id: "s1", goalId: "ghost", kind: "inbox", title: "隨手記",
             due: null, order: 0, state: "•"}],
  });
  const store = createStore(backend);
  store.load();
  assert.deepEqual(store.inboxSteps().map(s => s.title), ["隨手記"]);
});

test("匯入的備份夾帶惡意 id 時，該筆會被丟棄", () => {
  const backend = fakeBackend();
  const store = createStore(backend);
  store.load();

  store.replaceAll({
    version: 1,
    goals: [{id: "g1", title: "正常目標", why: "", status: "active"}],
    steps: [
      {id: "'||alert(1)||'", goalId: "g1", title: "惡意", due: null, order: 0, state: "•"},
      {id: "s1", goalId: "g1", title: "正常步驟", due: null, order: 1, state: "•"},
    ],
  });

  assert.deepEqual(store.getState().steps.map(s => s.id), ["s1"]);
  assert.equal(store.nextStep("g1").title, "正常步驟");
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
  assert.equal(dump.version, 2);
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

test("順延經由 store 也會累加計數", () => {
  const {store, a} = seeded();
  assert.equal(store.getState().steps.find(s => s.id === a.id).deferCount, 0);
  store.deferStep(a.id);
  store.deferStep(a.id);
  assert.equal(store.getState().steps.find(s => s.id === a.id).deferCount, 2);
});

test("放棄的步驟不再是下一步", () => {
  const {store, goal, a, b} = seeded();
  assert.equal(store.nextStep(goal.id).id, a.id);
  store.dropStep(a.id);
  assert.equal(store.getState().steps.find(s => s.id === a.id).state, STEP_STATE.DROPPED);
  assert.equal(store.nextStep(goal.id).id, b.id);
});

test("dropStep 對不存在的 id 拋錯", () => {
  const {store} = seeded();
  assert.throws(() => store.dropStep("nope"), /找不到 step/);
});

test("reviewItems 經由 store 取得，且回傳複本", () => {
  const {store, goal, a} = seeded();
  for(let i = 0; i < 3; i++) store.deferStep(a.id);

  const r = store.reviewItems("2026-08-24");
  assert.deepEqual(r.stalling.map(s => s.id), [a.id]);
  assert.equal(r.total, 1);

  r.stalling[0].deferCount = 99;
  r.stalledGoals.push({id: "x"});
  assert.equal(store.reviewItems("2026-08-24").stalling[0].deferCount, 3);
  assert.equal(store.reviewItems("2026-08-24").stalledGoals.length, 0);
});

test("重新載入後順延次數仍在", () => {
  const backend = fakeBackend();
  const store = createStore(backend);
  store.load();
  const g = store.addGoal({title: "半馬"});
  const s = store.addStep({goalId: g.id, title: "報名"});
  store.deferStep(s.id);
  store.deferStep(s.id);

  const again = createStore(backend);
  again.load();
  assert.equal(again.getState().steps[0].deferCount, 2);
});

test("放棄的收件匣項目不再出現在可處理的清單裡", () => {
  const {store} = seeded();
  const a = store.addStep({title: "收件匣 A"});
  const b = store.addStep({title: "收件匣 B"});
  store.dropStep(a.id);

  const visible = store.inboxSteps().filter(s =>
    s.state !== STEP_STATE.DONE && s.state !== STEP_STATE.DROPPED);
  assert.deepEqual(visible.map(s => s.id), [b.id]);
});

test("在回顧裡排程之後就從回顧消失，次數仍保留", () => {
  const {store, a} = seeded();
  for(let i = 0; i < 3; i++) store.deferStep(a.id);
  assert.equal(store.reviewItems("2026-08-25").stalling.length, 1);

  store.scheduleStep(a.id, "2026-12-31");
  assert.equal(store.reviewItems("2026-08-25").stalling.length, 0);
  assert.equal(store.getState().steps.find(s => s.id === a.id).deferCount, 3);
  assert.equal(store.reviewItems("2027-01-01").stalling.length, 1, "日期過了再回來");
});
