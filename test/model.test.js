import {test} from "node:test";
import assert from "node:assert/strict";
import * as m from "../src/model.js";

const {TODO, DONE, DEFERRED, SCHEDULED, NOTE} = m.STEP_STATE;

// 測試裡一律指定 id 與 order，讓排序與斷言不依賴時間或亂數。
const step = (id, goalId, order, state = TODO, due = null) =>
  m.createStep({id, goalId, title: `step ${id}`, order, state, due});

test("createGoal 帶入預設值並修剪空白", () => {
  const g = m.createGoal({id: "g1", title: "  跑完半馬  ", why: "  為了體力  "});
  assert.deepEqual(g, {id: "g1", title: "跑完半馬", why: "為了體力", status: "active"});
});

test("createGoal 拒絕空標題與未知狀態", () => {
  assert.throws(() => m.createGoal({title: "   "}), /title 不得為空/);
  assert.throws(() => m.createGoal({title: "x", status: "bogus"}), /未知的 goal status/);
});

test("createStep 預設為待辦、無到期日、可歸屬收件匣", () => {
  const s = m.createStep({id: "s1", title: "報名", order: 0});
  assert.deepEqual(s, {id: "s1", goalId: null, title: "報名", due: null, order: 0, state: TODO});
});

test("createStep 驗證 due 格式與 order 型別", () => {
  assert.doesNotThrow(() => m.createStep({title: "x", order: 0, due: "2026-08-23"}));
  assert.throws(() => m.createStep({title: "x", order: 0, due: "8/23"}), /YYYY-MM-DD/);
  assert.throws(() => m.createStep({title: "x"}), /order 必須是有限數字/);
  assert.throws(() => m.createStep({title: "x", order: 0, state: "?"}), /未知的 step state/);
});

test("狀態轉換回傳新物件，不修改原本的 step", () => {
  const s = step("s1", "g1", 0);
  const done = m.completeStep(s);
  assert.equal(done.state, DONE);
  assert.equal(s.state, TODO, "原物件不應被就地修改");
  assert.equal(m.deferStep(s).state, DEFERRED);
  assert.equal(m.noteStep(s).state, NOTE);
  assert.equal(m.reopenStep(done).state, TODO);
});

test("scheduleStep 同時寫入狀態與到期日", () => {
  const s = m.scheduleStep(step("s1", "g1", 0), "2026-09-01");
  assert.equal(s.state, SCHEDULED);
  assert.equal(s.due, "2026-09-01");
  assert.throws(() => m.scheduleStep(step("s2", "g1", 0), "明天"), /YYYY-MM-DD/);
});

test("nextStep 取 order 最小的可行動步驟", () => {
  const steps = [step("s3", "g1", 2), step("s1", "g1", 0), step("s2", "g1", 1)];
  assert.equal(m.nextStep(steps, "g1").id, "s1");
});

test("nextStep 在 order 相同時以 id 決勝，結果穩定", () => {
  const steps = [step("sb", "g1", 0), step("sa", "g1", 0)];
  assert.equal(m.nextStep(steps, "g1").id, "sa");
  assert.equal(m.nextStep([...steps].reverse(), "g1").id, "sa");
});

test("完成之後下一個自動浮出", () => {
  let steps = [step("s1", "g1", 0), step("s2", "g1", 1), step("s3", "g1", 2)];
  assert.equal(m.nextStep(steps, "g1").id, "s1");
  steps = steps.map(s => (s.id === "s1" ? m.completeStep(s) : s));
  assert.equal(m.nextStep(steps, "g1").id, "s2", "完成 s1 之後應該換 s2");
});

test("順延的步驟仍然算可行動，不會被跳過", () => {
  const steps = [m.deferStep(step("s1", "g1", 0)), step("s2", "g1", 1)];
  assert.equal(m.nextStep(steps, "g1").id, "s1");
});

test("已排程的步驟算可行動", () => {
  const steps = [m.scheduleStep(step("s1", "g1", 0), "2026-09-01"), step("s2", "g1", 1)];
  assert.equal(m.nextStep(steps, "g1").id, "s1");
});

test("筆記不會被當成下一步", () => {
  const steps = [m.noteStep(step("s1", "g1", 0)), step("s2", "g1", 1)];
  assert.equal(m.nextStep(steps, "g1").id, "s2");
});

test("全部完成或只剩筆記時沒有下一步", () => {
  const steps = [m.completeStep(step("s1", "g1", 0)), m.noteStep(step("s2", "g1", 1))];
  assert.equal(m.nextStep(steps, "g1"), null);
  assert.equal(m.nextStep([], "g1"), null);
});

test("nextStep 只看自己目標的步驟", () => {
  const steps = [step("s1", "g2", 0), step("s2", "g1", 1)];
  assert.equal(m.nextStep(steps, "g1").id, "s2");
});

test("nextOrder 接在既有步驟之後，各目標獨立計算", () => {
  const steps = [step("s1", "g1", 0), step("s2", "g1", 5), step("s3", "g2", 9)];
  assert.equal(m.nextOrder(steps, "g1"), 6);
  assert.equal(m.nextOrder(steps, "g2"), 10);
  assert.equal(m.nextOrder(steps, "g3"), 0);
  assert.equal(m.nextOrder([], null), 0);
});

test("goalProgress 分別統計完成、筆記與剩餘", () => {
  const steps = [
    m.completeStep(step("s1", "g1", 0)),
    m.noteStep(step("s2", "g1", 1)),
    step("s3", "g1", 2),
    step("s4", "g1", 3),
  ];
  assert.deepEqual(m.goalProgress(steps, "g1"), {total: 4, done: 1, notes: 1, remaining: 2});
});

test("todayList 每個進行中目標只給一個下一步", () => {
  const goals = [
    m.createGoal({id: "g1", title: "半馬"}),
    m.createGoal({id: "g2", title: "存錢"}),
    m.createGoal({id: "g3", title: "已封存", status: "archived"}),
  ];
  const steps = [
    step("s1", "g1", 0), step("s2", "g1", 1),
    step("s3", "g2", 0),
    step("s4", "g3", 0),
  ];
  const today = m.todayList(goals, steps);
  assert.deepEqual(today.map(x => [x.goal.id, x.step.id]), [["g1", "s1"], ["g2", "s3"]]);
});

test("todayList 略過沒有可行動步驟的目標", () => {
  const goals = [m.createGoal({id: "g1", title: "半馬"})];
  const steps = [m.completeStep(step("s1", "g1", 0))];
  assert.deepEqual(m.todayList(goals, steps), []);
});

test("inboxSteps 只收未歸屬目標的項目，並依序排列", () => {
  const steps = [step("s2", null, 1), step("s1", null, 0), step("s3", "g1", 0)];
  assert.deepEqual(m.inboxSteps(steps).map(s => s.id), ["s1", "s2"]);
});
