import {test} from "node:test";
import assert from "node:assert/strict";
import * as m from "../src/model.js";

const {TODO, DONE, DEFERRED, SCHEDULED, NOTE} = m.STEP_STATE;

// 測試裡一律指定 id 與 order，讓排序與斷言不依賴時間或亂數。
// kind 依有沒有目標決定，與 store.addStep 的預設一致。
const step = (id, goalId, order, state = TODO, due = null) =>
  m.createStep({id, goalId, kind: goalId ? m.STEP_KIND.MAIN : m.STEP_KIND.INBOX,
                title: `step ${id}`, order, state, due});

test("createGoal 帶入預設值並修剪空白", () => {
  const g = m.createGoal({id: "g1", title: "  跑完半馬  ", why: "  為了體力  "});
  assert.deepEqual(g, {id: "g1", title: "跑完半馬", why: "為了體力", status: "active",
                       coreId: null});
});

test("createGoal 拒絕空標題與未知狀態", () => {
  assert.throws(() => m.createGoal({title: "   "}), /title 不得為空/);
  assert.throws(() => m.createGoal({title: "x", status: "bogus"}), /未知的 goal status/);
});

test("createStep 預設為待辦、無到期日、可歸屬收件匣、順延次數為 0", () => {
  const s = m.createStep({id: "s1", title: "報名", order: 0});
  assert.deepEqual(s, {id: "s1", goalId: null, kind: "main", title: "報名", desc: "",
                       due: null, dueTime: null, order: 0, state: TODO, deferCount: 0,
                       xp: 50, rewards: [], streakHistory: [], completedCount: 0,
                       lastCompletedDate: null, archived: false, archivedAt: null,
                       createdAt: null, completedAt: null});
});

test("既有資料沒有 deferCount 時補 0，壞掉的值也歸零而不丟掉整筆", () => {
  // 舊版存下來的步驟沒有這個欄位
  assert.equal(m.createStep({id: "s1", title: "x", order: 0}).deferCount, 0);
  for(const bad of [-1, 1.5, NaN, Infinity, "3", null, {}]){
    assert.equal(m.createStep({id: "s1", title: "x", order: 0, deferCount: bad}).deferCount, 0,
      `${JSON.stringify(bad)} 應歸零`);
  }
  assert.equal(m.createStep({id: "s1", title: "x", order: 0, deferCount: 4}).deferCount, 4);
});

test("createStep 驗證 due 格式與 order 型別", () => {
  assert.doesNotThrow(() => m.createStep({title: "x", order: 0, due: "2026-08-23"}));
  assert.throws(() => m.createStep({title: "x", order: 0, due: "8/23"}), /YYYY-MM-DD/);
  assert.throws(() => m.createStep({title: "x"}), /order 必須是有限數字/);
  assert.throws(() => m.createStep({title: "x", order: 0, state: "?"}), /未知的 step state/);
});

test("due 必須是實際存在的日期，格式對但日期不存在也要擋", () => {
  for(const bad of ["2026-02-31", "2026-99-99", "2026-13-01", "2026-00-10", "2025-02-29"]){
    assert.throws(() => m.createStep({title: "x", order: 0, due: bad}),
      /不是實際存在的日期/, `${bad} 應該被拒絕`);
  }
  for(const ok of ["2026-02-28", "2024-02-29", "2026-12-31", "2026-01-01"]){
    assert.equal(m.createStep({title: "x", order: 0, due: ok}).due, ok);
  }
});

test("scheduleStep 同樣擋掉不存在的日期", () => {
  const s = m.createStep({id: "s1", title: "x", order: 0});
  assert.throws(() => m.scheduleStep(s, "2026-02-31"), /不是實際存在的日期/);
  assert.equal(s.due, null, "驗證失敗不應改動原物件");
});

test("id 限制字元集，擋掉會夾帶內容的 id", () => {
  // 這類 id 若進得來，放進 DOM 屬性時可能被當成可執行內容
  const crafted = ["'||alert(1)||'", 'a"b', "a<b", "a b", "a;b", "x".repeat(65), "a\\b"];
  for(const bad of crafted){
    assert.throws(() => m.createStep({id: bad, title: "x", order: 0}),
      /id 只允許/, `${JSON.stringify(bad)} 應該被拒絕`);
    assert.throws(() => m.createGoal({id: bad, title: "x"}), /id 只允許/);
  }
  for(const ok of ["s_abc-123", "g1", "A_b-C_9"]){
    assert.equal(m.createStep({id: ok, title: "x", order: 0}).id, ok);
  }
});

test("newId 產生的 id 通過自身的驗證", () => {
  for(let i = 0; i < 5; i++){
    const g = m.createGoal({title: "x"});
    const s = m.createStep({title: "x", order: 0});
    assert.doesNotThrow(() => m.createGoal({id: g.id, title: "x"}));
    assert.doesNotThrow(() => m.createStep({id: s.id, title: "x", order: 0}));
  }
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

test("每順延一次就累加計數", () => {
  let s = m.createStep({id: "s1", title: "x", order: 0});
  assert.equal(s.deferCount, 0);
  s = m.deferStep(s); assert.equal(s.deferCount, 1);
  s = m.deferStep(s); assert.equal(s.deferCount, 2);
  assert.equal(s.state, DEFERRED);
});

test("其他狀態轉換不會動到順延次數", () => {
  const s = m.deferStep(m.deferStep(m.createStep({id: "s1", title: "x", order: 0})));
  assert.equal(s.deferCount, 2);
  assert.equal(m.completeStep(s).deferCount, 2);
  assert.equal(m.reopenStep(s).deferCount, 2);
  assert.equal(m.noteStep(s).deferCount, 2);
  assert.equal(m.dropStep(s).deferCount, 2);
  assert.equal(m.scheduleStep(s, "2026-09-01").deferCount, 2);
});

test("放棄是一個不可行動的狀態，不會被推導成下一步", () => {
  const dropped = m.dropStep(m.createStep({id: "s1", title: "x", order: 0}));
  assert.equal(dropped.state, m.STEP_STATE.DROPPED);
  assert.equal(m.isActionable(dropped.state), false);
  const steps = [{...dropped, goalId: "g1"}, {...m.createStep({id: "s2", title: "y", order: 1}), goalId: "g1"}];
  assert.equal(m.nextStep(steps, "g1").id, "s2");
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
  assert.deepEqual(m.goalProgress(steps, "g1"),
    {total: 4, done: 1, notes: 1, dropped: 0, remaining: 2});
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

test("inboxSteps 只收收件匣項目，並依序排列", () => {
  const steps = [step("s2", null, 1), step("s1", null, 0), step("s3", "g1", 0)];
  assert.deepEqual(m.inboxSteps(steps).map(s => s.id), ["s1", "s2"]);
});

test("inboxPending 只算還需要行動的收件匣項目", () => {
  // 整理成筆記之後畫面上已經清空，計數也必須跟著清空，否則成就永遠解不開
  const steps = [
    step("s1", null, 0),
    m.completeStep(step("s2", null, 1)),
    m.noteStep(step("s3", null, 2)),
    m.dropStep(step("s4", null, 3)),
    {...step("s5", null, 4), archived: true},
  ];
  assert.deepEqual(m.inboxPending(steps).map(s => s.id), ["s1"]);
});

test("main 的 goalId 可以是 null，但那樣就不參與下一步推導", () => {
  // legacy quest 沒有目標概念，遷移後就是這個形狀
  const orphan = m.createStep({id: "q1", goalId: null, kind: "main", title: "舊任務", order: 0});
  assert.equal(orphan.goalId, null);
  assert.equal(m.nextStep([orphan], null), null);
});

test("nextStep 只看 main，支線與每日任務不擋路也不被遮住", () => {
  const side = m.createStep({id: "s1", goalId: "g1", kind: "side", title: "支線", order: 0});
  const daily = m.createStep({id: "s2", goalId: "g1", kind: "daily", title: "每日", order: 1});
  const main = m.createStep({id: "s3", goalId: "g1", kind: "main", title: "主線", order: 2});
  assert.equal(m.nextStep([side, daily, main], "g1").id, "s3");
});

test("封存過的步驟不會被推成下一步", () => {
  const a = {...m.createStep({id: "s1", goalId: "g1", kind: "main", title: "a", order: 0}),
             archived: true};
  const b = m.createStep({id: "s2", goalId: "g1", kind: "main", title: "b", order: 1});
  assert.equal(m.nextStep([a, b], "g1").id, "s2");
});

// ── 回顧 ────────────────────────────────────────────────────────────────────
const TODAY = "2026-08-24";
const goal = (id, status = "active") => m.createGoal({id, title: `goal ${id}`, status});
const deferred = (id, goalId, times) => {
  let s = m.createStep({id, goalId, title: `step ${id}`, order: 0});
  for(let i = 0; i < times; i++) s = m.deferStep(s);
  return s;
};

test("daysBetween 用 UTC 算術，跨月與跨年都正確", () => {
  assert.equal(m.daysBetween("2026-08-24", "2026-08-24"), 0);
  assert.equal(m.daysBetween("2026-08-17", "2026-08-24"), 7);
  assert.equal(m.daysBetween("2026-08-31", "2026-09-01"), 1);
  assert.equal(m.daysBetween("2025-12-31", "2026-01-01"), 1);
  assert.equal(m.daysBetween("2026-08-25", "2026-08-24"), -1, "未來的日期給負數");
});

test("hasDeferWarning 在門檻以下不觸發，達到門檻才觸發", () => {
  assert.equal(m.DEFER_WARN_THRESHOLD, 3);
  assert.equal(m.hasDeferWarning(deferred("s1", "g1", 2)), false);
  assert.equal(m.hasDeferWarning(deferred("s1", "g1", 3)), true);
  assert.equal(m.hasDeferWarning(deferred("s1", "g1", 9)), true);
});

test("已完成、筆記或放棄的步驟不算卡住，即使順延過很多次", () => {
  const s = deferred("s1", "g1", 5);
  for(const t of [m.completeStep(s), m.noteStep(s), m.dropStep(s)]){
    assert.equal(m.hasDeferWarning(t), false);
    assert.equal(m.isStalling(t, TODAY), false);
  }
});

test("排定到今天或未來就解除回顧，但次數與徽章都保留", () => {
  const s = deferred("s1", "g1", 4);
  assert.equal(m.isStalling(s, TODAY), true, "還沒排程時要求決定");

  const future = m.scheduleStep(s, "2026-12-31");
  assert.equal(m.isStalling(future, TODAY), false, "排到未來 = 已經做了決定");
  assert.equal(future.deferCount, 4, "次數不重置，歷史保留");
  assert.equal(m.hasDeferWarning(future), true, "徽章仍顯示，使用者看得到被推遲過幾次");

  const todaySchedule = m.scheduleStep(s, TODAY);
  assert.equal(m.isStalling(todaySchedule, TODAY), false, "排在今天也算已決定");
});

test("排定的日期過了又沒動作，就重新回到回顧", () => {
  const scheduled = m.scheduleStep(deferred("s1", "g1", 4), "2026-08-20");
  assert.equal(m.isStalling(scheduled, "2026-08-19"), false, "日期還沒到");
  assert.equal(m.isStalling(scheduled, "2026-08-21"), true, "日期過了就再問一次");
});

test("順延狀態即使帶著舊的到期日也不算已決定", () => {
  // 順延不是承諾，所以殘留的 due 不該讓它逃過回顧
  const s = {...deferred("s1", "g1", 4), due: "2099-01-01"};
  assert.equal(s.state, DEFERRED);
  assert.equal(m.isStalling(s, TODAY), true);
});

test("isLongOverdue 以 7 天為界", () => {
  assert.equal(m.LONG_OVERDUE_DAYS, 7);
  const at = due => ({...m.createStep({id: "s1", title: "x", order: 0, due}), goalId: "g1"});
  assert.equal(m.isLongOverdue(at("2026-08-18"), TODAY), false, "逾期 6 天還不算");
  assert.equal(m.isLongOverdue(at("2026-08-17"), TODAY), true, "逾期 7 天開始算");
  assert.equal(m.isLongOverdue(at("2026-09-01"), TODAY), false, "還沒到期");
  assert.equal(m.isLongOverdue(at(null), TODAY), false, "沒有到期日就不算");
  assert.equal(m.isLongOverdue(m.completeStep(at("2026-01-01")), TODAY), false, "完成的不算");
});

test("在回顧裡重新排程之後，該項就從清單消失", () => {
  const goals = [goal("g1")];
  const stuck = deferred("s1", "g1", 4);
  assert.equal(m.reviewItems(goals, [stuck], TODAY).stalling.length, 1);
  const rescheduled = m.scheduleStep(stuck, "2026-12-31");
  assert.equal(m.reviewItems(goals, [rescheduled], TODAY).stalling.length, 0,
    "回顧文案建議排定日期，做了就該被解除");
});

test("goalProgress 把放棄與完成分開計", () => {
  const steps = [
    m.completeStep(m.createStep({id: "s1", goalId: "g1", title: "a", order: 0})),
    m.dropStep(m.createStep({id: "s2", goalId: "g1", title: "b", order: 1})),
    m.noteStep(m.createStep({id: "s3", goalId: "g1", title: "c", order: 2})),
    m.createStep({id: "s4", goalId: "g1", title: "d", order: 3}),
  ];
  assert.deepEqual(m.goalProgress(steps, "g1"),
    {total: 4, done: 1, notes: 1, dropped: 1, remaining: 1});
});

test("只剩放棄的目標：沒有下一步，但完成數仍是 0", () => {
  const dropped = m.dropStep(m.createStep({id: "s1", goalId: "g1", title: "x", order: 0}));
  assert.equal(m.nextStep([dropped], "g1"), null);
  const p = m.goalProgress([dropped], "g1");
  assert.equal(p.done, 0, "不能被當成全部完成");
  assert.equal(p.total, 1);
  assert.equal(p.dropped, 1);
});

test("reviewItems 收集三種需要決定的情況", () => {
  const goals = [goal("g1"), goal("g2"), goal("g3")];
  const steps = [
    deferred("s1", "g1", 4),
    {...m.createStep({id: "s2", goalId: "g1", title: "久逾期", order: 1, due: "2026-08-01"})},
    {...m.createStep({id: "s3", goalId: "g2", title: "正常", order: 0, due: "2026-09-01"})},
    m.completeStep(m.createStep({id: "s4", goalId: "g3", title: "做完了", order: 0})),
  ];
  const r = m.reviewItems(goals, steps, TODAY);
  assert.deepEqual(r.stalling.map(s => s.id), ["s1"]);
  assert.deepEqual(r.longOverdue.map(s => s.id), ["s2"]);
  assert.deepEqual(r.stalledGoals.map(g => g.id), ["g3"], "沒有可行動下一步的進行中目標");
  assert.equal(r.total, 3);
});

test("同一個步驟同時卡住又久逾期時只列一次", () => {
  const s = {...deferred("s1", "g1", 5), due: "2026-01-01"};
  const r = m.reviewItems([goal("g1")], [s], TODAY);
  assert.deepEqual(r.stalling.map(x => x.id), ["s1"]);
  assert.deepEqual(r.longOverdue, [], "不重複列在第二個分類");
  assert.equal(r.total, 1);
});

test("reviewItems 略過封存目標底下的步驟，但保留收件匣", () => {
  const goals = [goal("g1", "archived")];
  const steps = [deferred("s1", "g1", 5), deferred("s2", null, 5)];
  const r = m.reviewItems(goals, steps, TODAY);
  assert.deepEqual(r.stalling.map(s => s.id), ["s2"]);
  assert.deepEqual(r.stalledGoals, [], "封存的目標不列入停滯");
});

test("reviewItems 依嚴重程度排序，順延最多的排最前", () => {
  const goals = [goal("g1")];
  const steps = [deferred("sa", "g1", 3), deferred("sb", "g1", 7), deferred("sc", "g1", 5)];
  assert.deepEqual(m.reviewItems(goals, steps, TODAY).stalling.map(s => s.id), ["sb", "sc", "sa"]);
});

test("久逾期依到期日排序，最舊的排最前", () => {
  const goals = [goal("g1")];
  const mk = (id, due) => m.createStep({id, goalId: "g1", title: id, order: 0, due});
  const steps = [mk("s2", "2026-08-10"), mk("s1", "2026-07-01"), mk("s3", "2026-08-15")];
  assert.deepEqual(m.reviewItems(goals, steps, TODAY).longOverdue.map(s => s.id), ["s1", "s2", "s3"]);
});

test("沒有任何需要決定的事情時 total 為 0", () => {
  const goals = [goal("g1")];
  const steps = [m.createStep({id: "s1", goalId: "g1", title: "x", order: 0})];
  assert.equal(m.reviewItems(goals, steps, TODAY).total, 0);
  assert.equal(m.reviewItems([], [], TODAY).total, 0);
});

test("處理掉之後就會從回顧清單消失（推導而非儲存）", () => {
  const goals = [goal("g1")];
  const stuck = deferred("s1", "g1", 4);
  assert.equal(m.reviewItems(goals, [stuck], TODAY).stalling.length, 1);
  assert.equal(m.reviewItems(goals, [m.dropStep(stuck)], TODAY).stalling.length, 0,
    "放棄之後不該再要求決定");
});

test("完全沒有步驟的進行中目標也算停滯（該補一步或收掉）", () => {
  const r = m.reviewItems([goal("g1")], [], TODAY);
  assert.deepEqual(r.stalledGoals.map(g => g.id), ["g1"]);
});
