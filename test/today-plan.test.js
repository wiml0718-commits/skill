// 班表、出勤連續與時間建議的純函式。驗收對照 docs/TODAY_PLAN.md 的 A01–A06、A18。
import {test} from "node:test";
import assert from "node:assert/strict";
import * as m from "../src/model.js";
import * as tp from "../src/today-plan.js";

// 使用者案例的 D。這裡是測試自己選的日期，不是程式裡的硬編碼「今天」。
const D = "2026-09-10";
const at = n => m.shiftDate(D, n);

// D 是工作日 2（phase 1）：anchor 設在 D−1 的工作日 1。
function planner({days = {}, anchorDate = at(-1), anchorPhase = 0, bindings = {}} = {}){
  const p = m.createPlanner({});
  p.config = m.createPlannerConfig({anchorDate, anchorPhase, goalBindings: bindings});
  for(const [date, patch] of Object.entries(days)) p.days[date] = m.createPlannerDay(patch);
  return p;
}

test("四日循環：phase 依 anchor 推導，跨月與 anchor 之前的日期都不偏移", () => {
  const p = planner();
  assert.equal(tp.phaseForDate(p.config, at(-1)), 0);
  assert.equal(tp.phaseForDate(p.config, at(0)), 1);
  assert.equal(tp.phaseForDate(p.config, at(1)), 2);
  assert.equal(tp.phaseForDate(p.config, at(2)), 3);
  assert.equal(tp.phaseForDate(p.config, at(3)), 0);
  // anchor 之前：負的 daysBetween 也要落在 0–3
  assert.equal(tp.phaseForDate(p.config, at(-5)), 0);
  assert.equal(tp.phaseForDate(p.config, at(-6)), 3);
  // 跨月
  assert.equal(tp.phaseForDate(p.config, "2026-10-01"), tp.phaseForDate(p.config, "2026-09-27"));
});

test("anchor 沒設定就是未設定，不猜一個起算日", () => {
  const p = m.createPlanner({});
  assert.equal(tp.phaseForDate(p.config, D), null);
  assert.equal(tp.plannedAttendance(p, D), null);
  const proj = tp.projectedStreak(p, D);
  assert.equal(proj.unknown, true);
  assert.equal(proj.count, 0);
});

test("原定班表：工作 1／2 上班，休假 1／2 休息；覆寫不動原班表", () => {
  const p = planner({days: {[at(1)]: {attendancePlan: m.ATTENDANCE.OVERTIME}}});
  assert.equal(tp.scheduledAttendance(p.config, at(1)), m.ATTENDANCE.REST);
  assert.equal(tp.plannedAttendance(p, at(1)), m.ATTENDANCE.OVERTIME);
  // 取消覆寫就回原班表
  const q = planner();
  assert.equal(tp.plannedAttendance(q, at(1)), m.ATTENDANCE.REST);
});

// A01
test("A01 六天案例（D−2 已確認休息）：今天實際 2、這段預計 6", () => {
  const p = planner({days: {
    [at(-2)]: {attendanceActual: m.ATTENDANCE.REST},
    [at(-1)]: {attendanceActual: m.ATTENDANCE.WORK},
    [at(0)]: {attendanceActual: m.ATTENDANCE.WORK},
    [at(1)]: {attendancePlan: m.ATTENDANCE.OVERTIME},
    [at(2)]: {attendancePlan: m.ATTENDANCE.OVERTIME},
  }});
  const run = tp.actualStreak(p, D);
  assert.deepEqual([run.count, run.exact, run.todayConfirmed], [2, true, true]);
  const proj = tp.projectedStreak(p, D);
  assert.equal(proj.count, 6);
  assert.equal(proj.exact, true);
  assert.equal(proj.broke, true, "D+5 是休假 1，預計連續段在那裡中斷");
  // 第 3／4 天是加班，第 5／6 天是新一輪的原定工作日
  assert.equal(tp.plannedAttendance(p, at(1)), m.ATTENDANCE.OVERTIME);
  assert.equal(tp.plannedAttendance(p, at(3)), m.ATTENDANCE.WORK);
  assert.equal(tp.plannedAttendance(p, at(4)), m.ATTENDANCE.WORK);
  assert.equal(tp.plannedAttendance(p, at(5)), m.ATTENDANCE.REST);
});

// A02
test("A02 D−2 未知：只能說至少 2／至少 6，未來不列為已出勤", () => {
  const p = planner({days: {
    [at(-1)]: {attendanceActual: m.ATTENDANCE.WORK},
    [at(0)]: {attendanceActual: m.ATTENDANCE.WORK},
    [at(1)]: {attendancePlan: m.ATTENDANCE.OVERTIME},
    [at(2)]: {attendancePlan: m.ATTENDANCE.OVERTIME},
  }});
  const run = tp.actualStreak(p, D);
  assert.equal(run.count, 2);
  assert.equal(run.exact, false, "邊界未知：只能說至少 2");
  const proj = tp.projectedStreak(p, D);
  assert.equal(proj.count, 6);
  assert.equal(proj.exact, false);
  // 未來的安排不會變成實際出勤
  assert.equal(tp.actualAttendance(p, at(1)), null);
});

// A03
test("A03 取消加班覆寫：回原休假安排，預計連續段中斷，anchor 不變", () => {
  const p = planner({days: {
    [at(-2)]: {attendanceActual: m.ATTENDANCE.REST},
    [at(-1)]: {attendanceActual: m.ATTENDANCE.WORK},
    [at(0)]: {attendanceActual: m.ATTENDANCE.WORK},
  }});
  const proj = tp.projectedStreak(p, D);
  assert.equal(proj.count, 2);
  assert.equal(proj.broke, true);
  // 新一輪的工作日還是落在原本的位置
  assert.equal(tp.scheduledAttendance(p.config, at(3)), m.ATTENDANCE.WORK);
});

// A04
test("A04 D+1 已確認休息、D+2 出勤：新段從 D+2 算 1，不與更早的工作日相加", () => {
  const today = at(2);
  const p = planner({days: {
    [at(-1)]: {attendanceActual: m.ATTENDANCE.WORK},
    [at(0)]: {attendanceActual: m.ATTENDANCE.WORK},
    [at(1)]: {attendanceActual: m.ATTENDANCE.REST},
    [today]: {attendanceActual: m.ATTENDANCE.WORK},
  }});
  const run = tp.actualStreak(p, today);
  assert.deepEqual([run.count, run.exact], [1, true]);
});

// A05
test("A05 今日未確認、過去有缺口：顯示待確認，不用原定班表補造實際紀錄", () => {
  const p = planner({days: {[at(-1)]: {attendanceActual: m.ATTENDANCE.WORK}}});
  const run = tp.actualStreak(p, D);
  assert.equal(run.todayConfirmed, false);
  assert.equal(run.count, 1);
  assert.equal(run.exact, false);
  // 原定班表說今天上班，但實際仍然是 null
  assert.equal(tp.plannedAttendance(p, D), m.ATTENDANCE.WORK);
  assert.equal(tp.actualAttendance(p, D), null);
});

test("今天已確認休息：連續歸零，但預計會接上下一段", () => {
  const p = planner({days: {
    [at(-1)]: {attendanceActual: m.ATTENDANCE.WORK},
    [at(0)]: {attendanceActual: m.ATTENDANCE.REST},
    [at(1)]: {attendancePlan: m.ATTENDANCE.WORK},
  }});
  const run = tp.actualStreak(p, D);
  assert.deepEqual([run.count, run.todayRest], [0, true]);
  const proj = tp.projectedStreak(p, D);
  assert.equal(proj.count, 1, "D+1 加班／上班起算新的一段");
});

test("查到邊界還沒休息：標成持續中，而不是宣稱剛好這麼多天", () => {
  const days = {};
  for(let i = -1; i <= 8; i++) days[at(i)] = {attendancePlan: m.ATTENDANCE.WORK};
  days[at(-1)] = {attendanceActual: m.ATTENDANCE.WORK, attendancePlan: m.ATTENDANCE.WORK};
  days[at(0)] = {attendanceActual: m.ATTENDANCE.WORK, attendancePlan: m.ATTENDANCE.WORK};
  const p = planner({days});
  const proj = tp.projectedStreak(p, D);
  assert.equal(proj.ongoing, true);
  assert.equal(proj.broke, false);
  assert.equal(proj.horizonEnd, at(tp.PROJECTION_HORIZON));
});

// A06
test("A06 建議分鐘：一般 25、低精力 5、加班 5、第 5 天 5、高精力休息 120", () => {
  const A = m.ATTENDANCE, E = m.ENERGY;
  assert.equal(tp.suggestMinutes({attendance: A.WORK, energy: E.MID}), 25);
  assert.equal(tp.suggestMinutes({attendance: A.WORK, energy: E.LOW}), 5);
  assert.equal(tp.suggestMinutes({attendance: A.OVERTIME, energy: E.HIGH}), 5);
  assert.equal(tp.suggestMinutes({attendance: A.WORK, energy: E.HIGH, streakDays: 5}), 5);
  assert.equal(tp.suggestMinutes({attendance: A.REST, energy: E.HIGH}), 120);
  // 休息但精力不是高：不自動給 120
  assert.equal(tp.suggestMinutes({attendance: A.REST, energy: E.MID}), 25);
  // 未填精力以 mid 計算
  assert.equal(tp.suggestMinutes({attendance: A.WORK, energy: null}), 25);
  // 可用時間 0 或收工：0 分鐘，優先於其他條件
  assert.equal(tp.suggestMinutes({attendance: A.REST, energy: E.HIGH, availableMinutes: 0}), 0);
  assert.equal(tp.suggestMinutes({attendance: A.REST, energy: E.HIGH, mode: m.DAY_MODE.RECOVERY}), 0);
});

test("未知歷史不推斷更多出勤天數，但已知至少 5 天就足以套用第 5 天建議", () => {
  const days = {};
  for(let i = -4; i <= 0; i++) days[at(i)] = {attendanceActual: m.ATTENDANCE.WORK};
  const p = planner({days});
  const run = tp.streakThroughToday(p, D);
  assert.equal(run.count, 5);
  assert.equal(run.exact, false, "再往前未知");
  assert.equal(tp.suggestForDay(p, D, D).minutes, 5);
});

test("預設本次時間是可用時間與建議值的較小者", () => {
  assert.equal(tp.defaultPlannedMinutes(null, 25), 25);
  assert.equal(tp.defaultPlannedMinutes(15, 25), 15);
  assert.equal(tp.defaultPlannedMinutes(60, 25), 25);
  assert.equal(tp.defaultPlannedMinutes(0, 120), 0);
});

// ── 主線接續（A09、A10）────────────────────────────────────────────────────
function fixture(){
  const goals = [
    m.createGoal({id: "g_ai", title: "AI 產品", coreId: "think"}),
    m.createGoal({id: "g_vid", title: "影片", coreId: "comm"}),
  ];
  const steps = [
    m.createStep({id: "s_ai1", goalId: "g_ai", title: "AI 第一步", order: 0}),
    m.createStep({id: "s_vid1", goalId: "g_vid", title: "影片第一步", order: 0}),
    m.createStep({id: "s_vid2", goalId: "g_vid", title: "影片第二步", order: 1}),
  ];
  return {goals, steps};
}

test("今日已接受的 focus 會被恢復，不因重開或改精力換題", () => {
  const {goals, steps} = fixture();
  const p = planner({
    days: {[D]: {focus: {goalId: "g_vid", stepId: "s_vid1"}, energy: m.ENERGY.LOW}},
    bindings: {ai: "g_ai", video: "g_vid"},
  });
  const f = tp.resolveFocus({planner: p, today: D, goals, steps});
  assert.equal(f.state, "accepted");
  assert.equal(f.stepId, "s_vid1");
});

test("今日還沒接受時先接續最近未完成的主線，不跳回班表綁定的目標", () => {
  const {goals, steps} = fixture();
  const p = planner({
    days: {[at(-1)]: {focus: {goalId: "g_vid", stepId: "s_vid1"}}},
    bindings: {ai: "g_ai", video: "g_vid"},
  });
  // D 是 phase 1 → 綁定 video；換成 phase 0（綁 ai）才看得出差別
  const q = planner({
    days: {[at(-1)]: {focus: {goalId: "g_vid", stepId: "s_vid1"}}},
    anchorDate: D, anchorPhase: 0, bindings: {ai: "g_ai", video: "g_vid"},
  });
  assert.equal(tp.resolveFocus({planner: p, today: D, goals, steps}).state, "resume");
  const f = tp.resolveFocus({planner: q, today: D, goals, steps});
  assert.equal(f.state, "resume");
  assert.equal(f.goalId, "g_vid", "有可接續的主線時不改用班表綁定的 AI 目標");
});

test("沒有可接續的主線才用當日 phase 綁定的目標", () => {
  const {goals, steps} = fixture();
  const p = planner({anchorDate: D, anchorPhase: 0, bindings: {ai: "g_ai", video: "g_vid"}});
  const f = tp.resolveFocus({planner: p, today: D, goals, steps});
  assert.equal(f.state, "suggested");
  assert.equal(f.goalId, "g_ai");
  assert.equal(f.stepId, "s_ai1");
});

test("已接受的 step 在別頁完成：顯示已完成，並給同目標的新下一步等待接受", () => {
  const {goals, steps} = fixture();
  const done = steps.map(s => (s.id === "s_vid1" ? {...s, state: m.STEP_STATE.DONE} : s));
  const p = planner({days: {[D]: {focus: {goalId: "g_vid", stepId: "s_vid1"}}}});
  const f = tp.resolveFocus({planner: p, today: D, goals, steps: done});
  assert.equal(f.state, "suggested");
  assert.equal(f.stepDone, true);
  assert.equal(f.stepId, "s_vid2");
});

// A10
test("A10 目標被封存／沒有下一步／完全沒有目標：各有對應狀態，不生成假任務", () => {
  const {goals, steps} = fixture();
  const archived = goals.map(g => (g.id === "g_vid" ? {...g, status: m.GOAL_STATUS.ARCHIVED} : g));
  const p = planner({days: {[D]: {focus: {goalId: "g_vid", stepId: "s_vid1"}}}});
  assert.equal(tp.resolveFocus({planner: p, today: D, goals: archived, steps}).issue,
               "goal-inactive");

  const noSteps = tp.resolveFocus({
    planner: planner({anchorDate: D, anchorPhase: 0, bindings: {ai: "g_ai"}}),
    today: D, goals, steps: steps.filter(s => s.goalId !== "g_ai")});
  assert.equal(noSteps.issue, "no-next-step");

  const empty = tp.resolveFocus({planner: planner({}), today: D, goals: [], steps: []});
  assert.equal(empty.issue, "no-goal");
  assert.equal(empty.step, null);
});

test("最近一次 checkpoint 取同一個 step 的最新紀錄", () => {
  const p = planner({});
  p.entries = [
    m.createPlannerEntry({requestId: "r1", day: at(-2), stepId: "s_vid1",
      outcome: m.OUTCOME.PROGRESS, note: "舊", nextAction: "接舊的",
      createdAt: "2026-09-08T10:00:00.000Z"}),
    m.createPlannerEntry({requestId: "r2", day: at(-1), stepId: "s_vid1",
      outcome: m.OUTCOME.PROGRESS, note: "新", nextAction: "接新的",
      createdAt: "2026-09-09T10:00:00.000Z"}),
    m.createPlannerEntry({requestId: "r3", day: at(-1), stepId: "s_ai1",
      outcome: m.OUTCOME.PROGRESS, note: "別的 step", nextAction: "x",
      createdAt: "2026-09-09T11:00:00.000Z"}),
  ];
  assert.equal(tp.latestCheckpoint(p, "s_vid1").note, "新");
  assert.equal(tp.latestCheckpoint(p, "沒有這個"), null);
});
