// ── 今日計畫：推導規則（schema v3）──────────────────────────────────────────
// 純函式：不讀寫 storage、不碰 DOM，也不自己決定「今天是哪一天」——今天一律由
// 呼叫端傳進來（rpg.logicalToday()）。班別、出勤連續、時間建議與主線接續都只是
// 從 planner + 既有 goals / steps 推導出來的結果，不落地儲存。

import {ATTENDANCE, ENERGY, DAY_MODE, PHASE_COUNT, MAX_MINUTES, GOAL_BINDING_KEYS,
        GOAL_STATUS, daysBetween, shiftDate, isActionable, nextStep} from "./model.js";

// 四日循環：工作 1、工作 2、休假 1、休假 2。
export const PHASE_LABEL = ["工作日 1", "工作日 2", "休假日 1", "休假日 2"];
export const PHASE_ATTENDANCE = [ATTENDANCE.WORK, ATTENDANCE.WORK,
                                 ATTENDANCE.REST, ATTENDANCE.REST];
// phase 與目標綁定的對應。存的是 goalBindings 的 key，實際目標由使用者指定，
// 不從目標標題猜類別。
export const PHASE_BINDING = ["ai", "video", "ai", "video"];
export const BINDING_LABEL = {ai: "目前 AI 產品", video: "當前影片"};

// 預估未來至少涵蓋這麼多天（§3.4）。畫面上要標出實際查到哪一天。
export const PROJECTION_HORIZON = 7;
// 往回走的迴圈上界，純粹防止壞資料造成無窮迴圈，不是規則。
const MAX_LOOKBACK = 400;

// 這段出勤到第幾天起改用「短時間」建議（§4）。
export const LONG_RUN_DAYS = 5;

function dayRecord(planner, date){
  const days = planner && planner.days ? planner.days : null;
  const rec = days && Object.prototype.hasOwnProperty.call(days, date) ? days[date] : null;
  return rec && typeof rec === "object" ? rec : null;
}

// ── 班別（§3.2）─────────────────────────────────────────────────────────────
// phase = ((daysBetween(anchorDate, day) + anchorPhase) % 4 + 4) % 4
// anchor 沒設定就是沒設定：不猜一個起算日，回 null 讓畫面顯示「未設定」。
export function phaseForDate(config, date){
  if(!config || config.anchorDate === null || config.anchorPhase === null) return null;
  const diff = daysBetween(config.anchorDate, date);
  if(!Number.isFinite(diff)) return null;
  return ((diff + config.anchorPhase) % PHASE_COUNT + PHASE_COUNT) % PHASE_COUNT;
}

// 原定班表說這天是上班還是休假。覆寫不會改到它（§3.2）。
export function scheduledAttendance(config, date){
  const phase = phaseForDate(config, date);
  return phase === null ? null : PHASE_ATTENDANCE[phase];
}

// 預定安排 = 當日覆寫值（若有）或原定班表。
export function plannedAttendance(planner, date){
  const rec = dayRecord(planner, date);
  if(rec && rec.attendancePlan) return rec.attendancePlan;
  return scheduledAttendance(planner && planner.config, date);
}

// 實際出勤只認使用者另外確認過的值。日期過了不會自動變成已出勤（§3.2）。
export function actualAttendance(planner, date){
  const rec = dayRecord(planner, date);
  return rec && rec.attendanceActual ? rec.attendanceActual : null;
}

// work 與 overtime 都是一個出勤日；加班不會變成兩天。
export function countsAsAttendance(value){
  return value === ATTENDANCE.WORK || value === ATTENDANCE.OVERTIME;
}

export function isRest(value){return value === ATTENDANCE.REST;}

// 今天的決策看實際值，未來看安排（§3.4）。
export function effectiveAttendance(planner, date, today){
  if(date <= today){
    const actual = actualAttendance(planner, date);
    if(actual) return actual;
  }
  return plannedAttendance(planner, date);
}

// ── 實際連續出勤（§3.4）─────────────────────────────────────────────────────
// 從 from 往回走，只認實際出勤。遇 rest 代表邊界已知；遇缺資料就停下並標成
// 「至少 N」——把未知當成休息會憑空宣稱完整歷史，當成出勤則是捏造紀錄。
function walkBack(planner, from){
  let count = 0;
  let date = from;
  for(let i = 0; i <= MAX_LOOKBACK; i++){
    const actual = actualAttendance(planner, date);
    if(isRest(actual)) return {count, exact: true, boundary: date};
    if(!countsAsAttendance(actual)) return {count, exact: false, boundary: null};
    count += 1;
    date = shiftDate(date, -1);
  }
  return {count, exact: false, boundary: null};
}

export function actualStreak(planner, today){
  const todayActual = actualAttendance(planner, today);
  if(!todayActual){
    // 今天還沒確認：只報到昨天為止的已知段落，不拿安排補一個假的實際值。
    const back = walkBack(planner, shiftDate(today, -1));
    return {...back, todayConfirmed: false, todayRest: false};
  }
  if(isRest(todayActual)) return {count: 0, exact: true, boundary: today,
                                  todayConfirmed: true, todayRest: true};
  return {...walkBack(planner, today), todayConfirmed: true, todayRest: false};
}

// ── 預計連續出勤（§3.4）─────────────────────────────────────────────────────
// 已知連續段接上「今日尚未確認的安排 + 未來安排」，遇 rest 中斷。未知的過去
// 不會被跨過去：base 帶著 exact=false 傳下來，結果一樣只能說「至少 N」。
export function projectedStreak(planner, today, {horizon = PROJECTION_HORIZON} = {}){
  const base = actualStreak(planner, today);
  let count = base.count;
  let cursor = base.todayConfirmed ? shiftDate(today, 1) : today;
  let broke = false;
  let unknown = false;
  let through = base.todayConfirmed ? today : shiftDate(today, -1);
  for(let i = 0; i < horizon + 1; i++){
    if(daysBetween(today, cursor) > horizon) break;
    const plan = plannedAttendance(planner, cursor);
    // 班表沒設定就不預估：這不是「預計休息」，只是還不知道。
    if(!plan){ unknown = true; break; }
    if(isRest(plan)){ broke = true; break; }
    count += 1;
    through = cursor;
    cursor = shiftDate(cursor, 1);
  }
  return {
    count,
    exact: base.exact,
    broke,
    unknown,
    // 沒中斷也沒遇到未知，代表只是查到邊界了：這段還沒結束。
    ongoing: !broke && !unknown,
    from: today,
    through,
    horizonEnd: shiftDate(today, horizon),
    todayConfirmed: base.todayConfirmed,
  };
}

// 這段出勤算到今天是第幾天。今天已確認就用實際值，否則接上今天的安排——
// 「今天要加班」本來就是今天的決策依據，不需要等到晚上才承認（§3.4）。
export function streakThroughToday(planner, today){
  const base = actualStreak(planner, today);
  if(base.todayConfirmed) return {count: base.count, exact: base.exact};
  const plan = plannedAttendance(planner, today);
  return {count: base.count + (countsAsAttendance(plan) ? 1 : 0), exact: base.exact};
}

// ── 時間建議（§4）───────────────────────────────────────────────────────────
// 依序判斷，先命中的先算。這是第一輪的產品預設，不是醫療判斷或負荷量測。
export function suggestMinutes({attendance = null, energy = null, streakDays = 0,
                                mode = DAY_MODE.ACTIVE, availableMinutes = null} = {}){
  if(availableMinutes === 0 || mode === DAY_MODE.RECOVERY) return 0;
  // 未填精力一律以 mid 計算，但呼叫端要標示「未填」，不能宣稱測得中等精力。
  const level = energy || ENERGY.MID;
  if(attendance === ATTENDANCE.OVERTIME || streakDays >= LONG_RUN_DAYS
     || level === ENERGY.LOW) return 5;
  if(isRest(attendance) && level === ENERGY.HIGH) return 120;
  return 25;
}

// 這一天的建議分鐘：把班表、精力與收工狀態組起來的單一入口。
export function suggestForDay(planner, date, today){
  const rec = dayRecord(planner, date);
  const attendance = effectiveAttendance(planner, date, today);
  const run = streakThroughToday(planner, today);
  const minutes = suggestMinutes({
    attendance,
    energy: rec ? rec.energy : null,
    streakDays: date === today ? run.count : 0,
    mode: rec ? rec.mode : DAY_MODE.ACTIVE,
    availableMinutes: rec ? rec.availableMinutes : null,
  });
  return {
    minutes,
    attendance,
    energy: rec ? rec.energy : null,
    energyFilled: !!(rec && rec.energy),
    streakDays: run.count,
    streakExact: run.exact,
    mode: rec && rec.mode ? rec.mode : DAY_MODE.ACTIVE,
  };
}

// 預設 plannedMinutes = min(availableMinutes, suggestedMinutes)。可用時間未填時
// 建議值本身就是預填，還沒成為資料（§4）。
export function defaultPlannedMinutes(availableMinutes, suggestedMinutes){
  const suggested = Number.isSafeInteger(suggestedMinutes)
    ? Math.max(0, Math.min(MAX_MINUTES, suggestedMinutes)) : 0;
  if(availableMinutes === null || availableMinutes === undefined) return suggested;
  return Math.min(availableMinutes, suggested);
}

// ── 主線接續（§5）───────────────────────────────────────────────────────────
// 最近一天有接受過 focus 的紀錄。只往回找，今天自己不算。
export function findRecentFocus(planner, today, {maxBack = 30} = {}){
  for(let back = 1; back <= maxBack; back++){
    const date = shiftDate(today, -back);
    const rec = dayRecord(planner, date);
    if(rec && rec.focus) return {date, focus: rec.focus};
  }
  return null;
}

function activeGoal(goals, id){
  const goal = (goals || []).find(g => g.id === id) || null;
  return goal && goal.status === GOAL_STATUS.ACTIVE ? goal : null;
}

function openStep(steps, id){
  const step = (steps || []).find(s => s.id === id) || null;
  return step && !step.archived && isActionable(step.state) ? step : null;
}

// 綁定目標：phase 決定看哪一個綁定，綁定存的是 goalId。沒設定、或指向的目標
// 已經不在進行中，就當作沒有，不自動換成另一個作品。
export function boundGoal(planner, date, goals){
  const phase = phaseForDate(planner && planner.config, date);
  if(phase === null) return {key: null, goal: null};
  const key = PHASE_BINDING[phase];
  const bindings = planner && planner.config ? planner.config.goalBindings : null;
  const id = bindings ? bindings[key] : null;
  return {key, goal: id ? activeGoal(goals, id) : null};
}

// 今天該顯示哪一個主線。回傳描述，不做任何寫入：接受與否由使用者按下去決定。
//
// state：
//   accepted  今天已接受、而且還做得下去 —— 重開或改精力都不換題
//   resume    今天還沒接受，但最近有一個沒做完的已接受主線可以接續
//   suggested 沒有可接續的，改用當日 phase 綁定的目標
//   none      連可建議的都沒有，issue 說明原因
export function resolveFocus({planner, today, goals = [], steps = []} = {}){
  const rec = dayRecord(planner, today);
  const none = (issue, extra = {}) => ({state: "none", issue, goal: null, step: null,
                                        goalId: null, stepId: null, stepDone: false, ...extra});

  if(rec && rec.focus){
    const {goalId, stepId} = rec.focus;
    const goal = (goals || []).find(g => g.id === goalId) || null;
    if(!goal) return none("goal-missing");
    if(goal.status !== GOAL_STATUS.ACTIVE) return none("goal-inactive", {goal});
    const step = (steps || []).find(s => s.id === stepId) || null;
    if(!step) return none("step-missing", {goal});
    if(!step.archived && isActionable(step.state)){
      return {state: "accepted", issue: null, goal, step, goalId: goal.id,
              stepId: step.id, stepDone: false};
    }
    // 上次的 step 已經在別頁完成或封存：顯示已完成，並給同一個目標的新下一步，
    // 等使用者自己點接受，不直接續上（§5）。
    const next = nextStep(steps, goal.id);
    return {state: next ? "suggested" : "none", issue: next ? null : "no-next-step",
            goal, step: next, goalId: goal.id, stepId: next ? next.id : null,
            stepDone: true, doneStep: step};
  }

  const recent = findRecentFocus(planner, today);
  if(recent){
    const goal = activeGoal(goals, recent.focus.goalId);
    const step = openStep(steps, recent.focus.stepId);
    if(goal && step && step.goalId === goal.id){
      return {state: "resume", issue: null, goal, step, goalId: goal.id,
              stepId: step.id, stepDone: false, since: recent.date};
    }
  }

  const bound = boundGoal(planner, today, goals);
  if(!bound.goal){
    // 綁定沒設定不擋住使用者：畫面要讓他手動挑一個進行中的目標。
    const fallback = (goals || []).filter(g => g.status === GOAL_STATUS.ACTIVE);
    return none(fallback.length ? "no-binding" : "no-goal", {bindingKey: bound.key});
  }
  const next = nextStep(steps, bound.goal.id);
  if(!next) return none("no-next-step", {goal: bound.goal, bindingKey: bound.key});
  return {state: "suggested", issue: null, goal: bound.goal, step: next,
          goalId: bound.goal.id, stepId: next.id, stepDone: false, bindingKey: bound.key};
}

// 這個 step 最近一次保存的進度。之後若已經完成，顯示完成紀錄而不是過期的
// checkpoint——拿舊 checkpoint 宣稱未完成會讓使用者以為成果沒存進去（§6.1）。
export function latestCheckpoint(planner, stepId){
  const entries = planner && Array.isArray(planner.entries) ? planner.entries : [];
  let found = null;
  for(const e of entries){
    if(e.stepId !== stepId) continue;
    if(!found) found = e;
    else if((e.createdAt || "") >= (found.createdAt || "")) found = e;
  }
  return found;
}

export {ATTENDANCE, ENERGY, DAY_MODE, GOAL_BINDING_KEYS};
