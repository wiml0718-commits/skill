// ── Goal / Step 資料模型 ─────────────────────────────────────────────────────
// 純函式：不讀寫 storage、不碰 DOM。所有轉換都回傳新物件，不就地修改。

// BuJo 符號
export const STEP_STATE = {
  TODO:      "•",
  DONE:      "×",
  DEFERRED:  ">",
  SCHEDULED: "<",
  NOTE:      "–",
};

export const STEP_STATE_LABEL = {
  [STEP_STATE.TODO]:      "待辦",
  [STEP_STATE.DONE]:      "完成",
  [STEP_STATE.DEFERRED]:  "順延",
  [STEP_STATE.SCHEDULED]: "已排程",
  [STEP_STATE.NOTE]:      "筆記",
};

const ALL_STEP_STATES = Object.values(STEP_STATE);

// 可被推導成「下一步」的狀態。完成與筆記不算，因為兩者都不是待行動的事。
const ACTIONABLE = new Set([STEP_STATE.TODO, STEP_STATE.SCHEDULED, STEP_STATE.DEFERRED]);

export const GOAL_STATUS = {ACTIVE:"active", DONE:"done", ARCHIVED:"archived"};
const ALL_GOAL_STATUS = Object.values(GOAL_STATUS);

export function isActionable(state){return ACTIONABLE.has(state);}

// ── id ───────────────────────────────────────────────────────────────────────
let _seq = 0;
export function newId(prefix){
  _seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${_seq.toString(36)}`;
}

// ── 驗證 ─────────────────────────────────────────────────────────────────────
function requireTitle(title){
  const t = typeof title === "string" ? title.trim() : "";
  if(!t) throw new Error("title 不得為空");
  return t;
}

function normalizeDue(due){
  if(due === undefined || due === null || due === "") return null;
  if(typeof due !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(due)){
    throw new Error("due 必須是 YYYY-MM-DD 字串或 null");
  }
  // 光靠格式擋不掉 2026-02-31 這種不存在的日期，實際轉成日期再比對一次。
  const [y, m, d] = due.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if(dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d){
    throw new Error(`due 不是實際存在的日期：${due}`);
  }
  return due;
}

function requireStepState(state){
  if(!ALL_STEP_STATES.includes(state)) throw new Error(`未知的 step state：${state}`);
  return state;
}

// ── 建立 ─────────────────────────────────────────────────────────────────────
export function createGoal({id, title, why = "", status = GOAL_STATUS.ACTIVE} = {}){
  if(!ALL_GOAL_STATUS.includes(status)) throw new Error(`未知的 goal status：${status}`);
  return {
    id: id || newId("g"),
    title: requireTitle(title),
    why: typeof why === "string" ? why.trim() : "",
    status,
  };
}

// order 一律由呼叫端（store）指定，避免多筆同序造成排序不穩定。
export function createStep({id, goalId = null, title, due = null, order, state = STEP_STATE.TODO} = {}){
  if(typeof order !== "number" || !Number.isFinite(order)) throw new Error("order 必須是有限數字");
  return {
    id: id || newId("s"),
    goalId: goalId ?? null,
    title: requireTitle(title),
    due: normalizeDue(due),
    order,
    state: requireStepState(state),
  };
}

// ── 狀態轉換 ─────────────────────────────────────────────────────────────────
function withState(step, state, patch = {}){
  return {...step, ...patch, state: requireStepState(state)};
}

export function completeStep(step){return withState(step, STEP_STATE.DONE);}
export function deferStep(step){return withState(step, STEP_STATE.DEFERRED);}
export function reopenStep(step){return withState(step, STEP_STATE.TODO);}
export function noteStep(step){return withState(step, STEP_STATE.NOTE);}
export function scheduleStep(step, due){
  return withState(step, STEP_STATE.SCHEDULED, {due: normalizeDue(due)});
}

// ── 查詢與推導 ───────────────────────────────────────────────────────────────
function byOrderThenId(a, b){
  if(a.order !== b.order) return a.order - b.order;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function goalSteps(steps, goalId){
  return steps.filter(s => s.goalId === goalId).sort(byOrderThenId);
}

// 核心規則：每個目標同時只有一個下一步。
// 推導出來的，不落地儲存 —— 所以完成一個之後，下一個自然浮出。
export function nextStep(steps, goalId){
  return goalSteps(steps, goalId).find(s => isActionable(s.state)) || null;
}

export function nextOrder(steps, goalId){
  const own = steps.filter(s => s.goalId === goalId);
  return own.length ? Math.max(...own.map(s => s.order)) + 1 : 0;
}

export function goalProgress(steps, goalId){
  const own = goalSteps(steps, goalId);
  const done = own.filter(s => s.state === STEP_STATE.DONE).length;
  const notes = own.filter(s => s.state === STEP_STATE.NOTE).length;
  return {total: own.length, done, notes, remaining: own.length - done - notes};
}

// 收件匣：尚未歸屬任何目標的快速捕捉項目（含已完成，由檢視自行決定顯不顯示）
export function inboxSteps(steps){
  return goalSteps(steps, null);
}

// 今日：所有進行中目標的「下一步」匯總成一張平面清單
export function todayList(goals, steps){
  return goals
    .filter(g => g.status === GOAL_STATUS.ACTIVE)
    .map(g => ({goal: g, step: nextStep(steps, g.id)}))
    .filter(x => x.step !== null);
}
