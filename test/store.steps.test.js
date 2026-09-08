// 統一之後的 step 操作（§3.5、§4.3）：建立與編輯時的歸屬檢查、封存、批次清除，
// 以及收件匣指派到目標的規則。
import {test} from "node:test";
import assert from "node:assert/strict";
import {createStore} from "../src/store.js";
import * as m from "../src/model.js";

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
  const state = store.legacyState();
  store.saveLegacyState({
    ...state,
    subSkills: [{id: "sk_run", coreId: "body", name: "重訓", type: "active",
                 xp: 0, icon: "⭐", desc: "", source: "", notes: []}],
  });
  return store;
}

const REWARD = [{skillId: "sk_run", xp: 20}];
const stepsOf = store => store.getState().steps;

// ── 歸屬是儲存前的必要條件（§4.3）─────────────────────────────────────────
test("main / side / daily 沒有歸屬就存不進去", () => {
  const store = fresh();
  for(const kind of [m.STEP_KIND.MAIN, m.STEP_KIND.SIDE, m.STEP_KIND.DAILY]){
    assert.throws(() => store.addStep({kind, title: "沒歸屬"}), /指定 XP 歸屬/, kind);
  }
  assert.equal(stepsOf(store).length, 0, "擋下來就不該留下半筆資料");
});

test("收件匣是唯一的例外，可以直接捕捉", () => {
  const store = fresh();
  const s = store.addStep({title: "隨手記一筆"});
  assert.equal(s.kind, m.STEP_KIND.INBOX);
  assert.deepEqual(s.rewards, []);
});

test("指定 rewards 或讓目標綁核心，兩條路都算數", () => {
  const store = fresh();
  const withReward = store.addStep({kind: m.STEP_KIND.SIDE, title: "重訓一次", rewards: REWARD});
  assert.deepEqual(withReward.rewards, REWARD);

  const goal = store.addGoal({title: "跑完半馬", coreId: "body"});
  const fromGoal = store.addStep({goalId: goal.id, kind: m.STEP_KIND.MAIN, title: "報名"});
  assert.deepEqual(fromGoal.rewards, [], "靠目標的核心歸屬，不需要自己帶 rewards");
});

test("目標沒綁核心時，它底下的主線步驟一樣存不進去", () => {
  const store = fresh();
  const goal = store.addGoal({title: "沒綁核心的目標"});
  assert.throws(() => store.addStep({goalId: goal.id, kind: m.STEP_KIND.MAIN, title: "第一步"}),
                /指定 XP 歸屬/);
});

test("編輯時把歸屬拿掉同樣擋下來，原本的資料不動", () => {
  const store = fresh();
  const s = store.addStep({kind: m.STEP_KIND.SIDE, title: "重訓一次", rewards: REWARD});
  assert.throws(() => store.updateStep(s.id, {rewards: []}), /指定 XP 歸屬/);
  assert.deepEqual(stepsOf(store)[0].rewards, REWARD, "沒存成功就不該被改到");

  const renamed = store.updateStep(s.id, {title: "重訓兩次", due: "2026-09-30"});
  assert.equal(renamed.title, "重訓兩次");
  assert.equal(renamed.due, "2026-09-30");
  assert.deepEqual(renamed.rewards, REWARD);
});

test("編輯不會弄丟 streak 與完成次數", () => {
  const store = fresh();
  const s = store.addStep({kind: m.STEP_KIND.DAILY, title: "喝水", rewards: REWARD});
  store.completeStep(s.id);
  const after = store.updateStep(s.id, {title: "喝水 2000cc"});
  assert.equal(after.completedCount, 1);
  assert.equal(after.streakHistory.length, 1);
});

test("收件匣改成主線時就要有歸屬了", () => {
  const store = fresh();
  const s = store.addStep({title: "隨手記一筆"});
  assert.throws(() => store.updateStep(s.id, {kind: m.STEP_KIND.MAIN}), /指定 XP 歸屬/);
  assert.equal(stepsOf(store)[0].kind, m.STEP_KIND.INBOX);

  const moved = store.updateStep(s.id, {kind: m.STEP_KIND.MAIN, rewards: REWARD});
  assert.equal(moved.kind, m.STEP_KIND.MAIN);
});

// ── 指派（§4.3）──────────────────────────────────────────────────────────
test("指派到綁了核心的目標會轉成主線並排到最後", () => {
  const store = fresh();
  const goal = store.addGoal({title: "跑完半馬", coreId: "body"});
  const first = store.addStep({goalId: goal.id, kind: m.STEP_KIND.MAIN, title: "報名"});
  const captured = store.addStep({title: "找跑團"});

  const assigned = store.assignStep(captured.id, goal.id);
  assert.equal(assigned.kind, m.STEP_KIND.MAIN);
  assert.ok(assigned.order > first.order, "排到最後，不搶走現有的下一步");
  assert.equal(store.nextStep(goal.id).id, first.id);
});

test("指派到沒綁核心的目標會被擋下，項目留在收件匣", () => {
  const store = fresh();
  const goal = store.addGoal({title: "沒綁核心的目標"});
  const captured = store.addStep({title: "找跑團"});

  assert.throws(() => store.assignStep(captured.id, goal.id), /指定 XP 歸屬/);
  const after = stepsOf(store).find(s => s.id === captured.id);
  assert.equal(after.kind, m.STEP_KIND.INBOX);
  assert.equal(after.goalId, null);
});

test("自己帶 rewards 的收件匣項目，指派到沒綁核心的目標仍然可以", () => {
  const store = fresh();
  const goal = store.addGoal({title: "沒綁核心的目標"});
  const captured = store.addStep({title: "找跑團"});
  store.updateStep(captured.id, {rewards: REWARD});
  assert.equal(store.assignStep(captured.id, goal.id).kind, m.STEP_KIND.MAIN);
});

// ── kind 與下一步（§3.5）─────────────────────────────────────────────────
test("支線與每日不會擋住主線的下一步", () => {
  const store = fresh();
  const goal = store.addGoal({title: "跑完半馬", coreId: "body"});
  store.addStep({goalId: goal.id, kind: m.STEP_KIND.SIDE, title: "研究跑鞋"});
  store.addStep({goalId: goal.id, kind: m.STEP_KIND.DAILY, title: "伸展"});
  const main = store.addStep({goalId: goal.id, kind: m.STEP_KIND.MAIN, title: "報名"});
  assert.equal(store.nextStep(goal.id).id, main.id);

  store.completeStep(main.id);
  assert.equal(store.nextStep(goal.id), null, "主線做完就沒有下一步，支線不遞補");
});

// ── 封存與清除（§3.5）────────────────────────────────────────────────────
test("封存與 state 正交：封存不改變完成或放棄", () => {
  const store = fresh();
  const s = store.addStep({kind: m.STEP_KIND.SIDE, title: "重訓一次", rewards: REWARD});
  store.completeStep(s.id);

  const archived = store.archiveStep(s.id);
  assert.equal(archived.archived, true);
  assert.ok(archived.archivedAt, "封存時間要留下來");
  assert.equal(archived.state, m.STEP_STATE.DONE, "封存不該把完成抹掉");

  const back = store.archiveStep(s.id, false);
  assert.equal(back.archived, false);
  assert.equal(back.archivedAt, null);
  assert.equal(back.state, m.STEP_STATE.DONE);
});

test("批次封存只收已完成的，每日任務不會被掃進去", () => {
  const store = fresh();
  const done = store.addStep({kind: m.STEP_KIND.SIDE, title: "做完了", rewards: REWARD});
  store.completeStep(done.id);
  const daily = store.addStep({kind: m.STEP_KIND.DAILY, title: "喝水", rewards: REWARD});
  store.completeStep(daily.id);
  const todo = store.addStep({kind: m.STEP_KIND.SIDE, title: "還沒做", rewards: REWARD});

  assert.equal(store.archiveDoneSteps(), 1);
  const byId = Object.fromEntries(stepsOf(store).map(s => [s.id, s]));
  assert.equal(byId[done.id].archived, true);
  assert.equal(byId[daily.id].archived, false, "每日任務不進 DONE，也就不該被封存");
  assert.equal(byId[todo.id].archived, false);
  assert.equal(store.archiveDoneSteps(), 0, "第二次沒有東西可封存");
});

test("批次清除只刪符合條件的，回報實際刪掉幾筆", () => {
  const store = fresh();
  const a = store.addStep({kind: m.STEP_KIND.SIDE, title: "做完了", rewards: REWARD});
  store.completeStep(a.id);
  store.archiveStep(a.id);
  const keep = store.addStep({kind: m.STEP_KIND.SIDE, title: "還沒做", rewards: REWARD});

  assert.equal(store.deleteSteps(s => s.archived === true), 1);
  assert.deepEqual(stepsOf(store).map(s => s.id), [keep.id]);
});

test("刪除單筆，找不到的 id 拋錯", () => {
  const store = fresh();
  const s = store.addStep({title: "隨手記一筆"});
  assert.equal(store.deleteStep(s.id).id, s.id);
  assert.equal(stepsOf(store).length, 0);
  assert.throws(() => store.deleteStep(s.id), /找不到 step/);
});

test("新建立的步驟留下建立時間，重新載入還在", () => {
  const be = backend();
  const store = createStore(be);
  store.load();
  const s = store.addStep({title: "隨手記一筆"});
  assert.ok(s.createdAt, "建立時間有真實來源，不該留 null");

  const again = createStore(be);
  again.load();
  assert.equal(again.getState().steps[0].createdAt, s.createdAt);
});
