// ── Goal / Step 資料模型 ─────────────────────────────────────────────────────
// 純函式：不讀寫 storage、不碰 DOM。所有轉換都回傳新物件，不就地修改。

// BuJo 符號
export const STEP_STATE = {
  TODO:      "•",
  DONE:      "×",
  DEFERRED:  ">",
  SCHEDULED: "<",
  NOTE:      "–",
  DROPPED:   "~",
};

export const STEP_STATE_LABEL = {
  [STEP_STATE.TODO]:      "待辦",
  [STEP_STATE.DONE]:      "完成",
  [STEP_STATE.DEFERRED]:  "順延",
  [STEP_STATE.SCHEDULED]: "已排程",
  [STEP_STATE.NOTE]:      "筆記",
  [STEP_STATE.DROPPED]:   "放棄",
};

const ALL_STEP_STATES = Object.values(STEP_STATE);

// 可被推導成「下一步」的狀態。完成、筆記與放棄都不是待行動的事。
const ACTIONABLE = new Set([STEP_STATE.TODO, STEP_STATE.SCHEDULED, STEP_STATE.DEFERRED]);

// 順延一兩次很正常，第三次起才是「卡住了」的訊號。
export const DEFER_WARN_THRESHOLD = 3;

// 逾期超過這麼多天就該重新決定，而不是繼續掛著。
export const LONG_OVERDUE_DAYS = 7;

export const GOAL_STATUS = {ACTIVE:"active", DONE:"done", ARCHIVED:"archived"};
const ALL_GOAL_STATUS = Object.values(GOAL_STATUS);

export function isActionable(state){return ACTIONABLE.has(state);}

// ── id ───────────────────────────────────────────────────────────────────────
let _seq = 0;
export function newId(prefix){
  _seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${_seq.toString(36)}`;
}

// id 會被放進 DOM 屬性與事件處理，限制字元集可以在資料邊界就擋掉夾帶內容的 id
// （例如從匯入的備份檔進來的）。newId() 產生的 id 一律符合這個樣式。
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function requireId(id, prefix){
  if(id === undefined || id === null || id === "") return newId(prefix);
  if(typeof id !== "string" || !ID_PATTERN.test(id)){
    throw new Error(`id 只允許英數字、底線與連字號（最多 64 字元）：${id}`);
  }
  return id;
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
    id: requireId(id, "g"),
    title: requireTitle(title),
    why: typeof why === "string" ? why.trim() : "",
    status,
  };
}

// order 一律由呼叫端（store）指定，避免多筆同序造成排序不穩定。
// deferCount 是衍生的中繼資料而不是使用者內容，所以壞掉時歸零而不是丟掉整筆步驟——
// 為了一個計數器而讓使用者遺失一件事，代價不成比例。
function normalizeDeferCount(n){
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

export function createStep({id, goalId = null, title, due = null, order,
                            state = STEP_STATE.TODO, deferCount = 0} = {}){
  if(typeof order !== "number" || !Number.isFinite(order)) throw new Error("order 必須是有限數字");
  return {
    id: requireId(id, "s"),
    goalId: goalId ?? null,
    title: requireTitle(title),
    due: normalizeDue(due),
    order,
    state: requireStepState(state),
    deferCount: normalizeDeferCount(deferCount),
  };
}

// ── 狀態轉換 ─────────────────────────────────────────────────────────────────
function withState(step, state, patch = {}){
  return {...step, ...patch, state: requireStepState(state)};
}

export function completeStep(step){return withState(step, STEP_STATE.DONE);}
export function dropStep(step){return withState(step, STEP_STATE.DROPPED);}

// 每順延一次就累加，讓「一直被推遲」這件事在資料裡留下痕跡
export function deferStep(step){
  return withState(step, STEP_STATE.DEFERRED,
    {deferCount: normalizeDeferCount(step && step.deferCount) + 1});
}
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
  const dropped = own.filter(s => s.state === STEP_STATE.DROPPED).length;
  return {total: own.length, done, notes, dropped,
          remaining: own.length - done - notes - dropped};
}

// 收件匣：尚未歸屬任何目標的快速捕捉項目（含已完成，由檢視自行決定顯不顯示）
export function inboxSteps(steps){
  return goalSteps(steps, null);
}

// ── 回顧 ─────────────────────────────────────────────────────────────────────
// 兩個日期字串相差幾天。用 UTC 做算術，避免日光節約時間讓某些日子變成 23 或 25 小時。
export function daysBetween(fromISO, toISO){
  const parse = iso => {
    const [y, m, d] = String(iso).split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((parse(toISO) - parse(fromISO)) / 86400000);
}

// 達到門檻就值得被看見（徽章用）。這只描述「被推遲過很多次」這個事實。
export function hasDeferWarning(step){
  return !!step && isActionable(step.state) && normalizeDeferCount(step.deferCount) >= DEFER_WARN_THRESHOLD;
}

// 已排到今天或未來，代表使用者已經做出承諾，在那天到來之前不需要再被問一次。
function hasFutureCommitment(step, today){
  return step.state === STEP_STATE.SCHEDULED && !!step.due && step.due >= today;
}

// 「還需要重新決定嗎」是另一回事：排定日期就是一種決定，所以會解除回顧。
// 次數本身不重置——歷史保留，只是暫時不再要求決定；日期過了又沒動作就會再回來。
export function isStalling(step, today){
  return hasDeferWarning(step) && !hasFutureCommitment(step, today);
}

export function isLongOverdue(step, today){
  if(!step || !isActionable(step.state) || !step.due) return false;
  return daysBetween(step.due, today) >= LONG_OVERDUE_DAYS;
}

// 回顧清單：需要使用者重新做決定的三種情況。
// 每一項都是當場推導的，不落地儲存，所以處理掉之後自然就會從清單消失。
export function reviewItems(goals, steps, today){
  const active = (goals || []).filter(g => g && g.status === GOAL_STATUS.ACTIVE);
  const activeIds = new Set(active.map(g => g.id));
  const visible = (steps || []).filter(s => s && (s.goalId == null || activeIds.has(s.goalId)));

  const stalling = visible.filter(s => isStalling(s, today)).sort((a, b) =>
    (b.deferCount || 0) - (a.deferCount || 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // 已經在反覆順延清單裡的就不重複列，免得同一件事出現兩次
  const stallingIds = new Set(stalling.map(s => s.id));
  const longOverdue = visible
    .filter(s => !stallingIds.has(s.id) && isLongOverdue(s, today))
    .sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : 0));

  // 進行中卻沒有任何可行動下一步的目標：不是該收尾，就是該補一步
  const stalledGoals = active.filter(g => nextStep(steps, g.id) === null);

  return {
    stalling, longOverdue, stalledGoals,
    total: stalling.length + longOverdue.length + stalledGoals.length,
  };
}

// 今日：所有進行中目標的「下一步」匯總成一張平面清單
export function todayList(goals, steps){
  return goals
    .filter(g => g.status === GOAL_STATUS.ACTIVE)
    .map(g => ({goal: g, step: nextStep(steps, g.id)}))
    .filter(x => x.step !== null);
}
