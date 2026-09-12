// ── 資料模型（schema v2）─────────────────────────────────────────────────────
// 純函式：不讀寫 storage、不碰 DOM。所有轉換都回傳新物件，不就地修改。
// 規格見 docs/RPG_SPEC.md §3。

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

// §3.5：kind 決定預設 XP、是否參與下一步推導、以及完成後的行為。
export const STEP_KIND = {MAIN:"main", SIDE:"side", DAILY:"daily", INBOX:"inbox"};
const ALL_STEP_KINDS = Object.values(STEP_KIND);

export const KIND_DEFAULT_XP = {
  [STEP_KIND.MAIN]:  50,
  [STEP_KIND.SIDE]:  20,
  [STEP_KIND.DAILY]: 10,
  [STEP_KIND.INBOX]: 5,
};

export const SKILL_TYPE = {ACTIVE:"active", PASSIVE:"passive"};
const ALL_SKILL_TYPES = Object.values(SKILL_TYPE);

// §3.6：xpLog 的來源。rollup 是壓縮後的月彙總，必須是正式的一員，
// 否則載入驗證會把自己寫出的彙總資料當成髒資料丟掉。
export const XP_SOURCE = {STEP:"step", MANUAL:"manual", MERGE:"merge", ROLLUP:"rollup"};
const ALL_XP_SOURCES = Object.values(XP_SOURCE);

// §3.2：9 個內建核心。builtin 只標示「隨 App 內建」，不代表不可刪除。
export const BUILTIN_CORES = [
  {id:"body",    name:"身體管理", title:"John Wick",     icon:"🔫",  color:"#ef4444"},
  {id:"emotion", name:"情緒管理", title:"明鏡止水",       icon:"🪞",  color:"#22d3ee"},
  {id:"time",    name:"時間管理", title:"預知眼",         icon:"👁️", color:"#a855f7"},
  {id:"think",   name:"思維能力", title:"零的領域",       icon:"🌀",  color:"#6366f1"},
  {id:"learn",   name:"學習能力", title:"識破",           icon:"📖",  color:"#f59e0b"},
  {id:"comm",    name:"溝通能力", title:"安妮亞",         icon:"🥜",  color:"#ec4899"},
  {id:"social",  name:"人際能力", title:"葬送的芙莉蓮",   icon:"🧝",  color:"#10b981"},
  {id:"finance", name:"財務能力", title:"黃金鄉的馬哈特", icon:"💰",  color:"#84cc16"},
  {id:"lead",    name:"領導能力", title:"指揮官",         icon:"⚜️", color:"#f97316"},
];

const BUILTIN_CORE_IDS = new Set(BUILTIN_CORES.map(c => c.id));
export function isBuiltinCoreId(id){return BUILTIN_CORE_IDS.has(id);}

// §4.3：每個核心的承接技能，接住沒有指定 rewards 的 XP。
export function generalSkillId(coreId){return `sk_${coreId}_general`;}
export const GENERAL_SKILL_NAME = "歷練";

export function isActionable(state){return ACTIONABLE.has(state);}

// ── id ───────────────────────────────────────────────────────────────────────
let _seq = 0;
export function newId(prefix){
  _seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${_seq.toString(36)}`;
}

// id 會被放進 DOM 屬性與事件處理，限制字元集可以在資料邊界就擋掉夾帶內容的 id
// （例如從匯入的備份檔進來的）。newId() 產生的 id 一律符合這個樣式。
export const MAX_ID_LENGTH = 64;
const ID_PATTERN = new RegExp(`^[A-Za-z0-9_-]{1,${MAX_ID_LENGTH}}$`);

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

function text(v){return typeof v === "string" ? v : "";}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// 日期字串的唯一驗證入口：due、xpLog.date、streakHistory、補登日期都走它。
export function normalizeDue(due){
  if(due === undefined || due === null || due === "") return null;
  if(typeof due !== "string" || !DATE_PATTERN.test(due)){
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

function normalizeDueTime(t){
  if(t === undefined || t === null || t === "") return null;
  if(typeof t !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(t)){
    throw new Error("dueTime 必須是 HH:MM 字串或 null");
  }
  return t;
}

// 時間點沒有來源時一律留 null，不以當下時間頂替（§7.3）。
function normalizeInstant(v, field){
  if(v === undefined || v === null || v === "") return null;
  if(typeof v !== "string" || Number.isNaN(Date.parse(v))){
    throw new Error(`${field} 必須是可解析的時間字串或 null`);
  }
  return v;
}

function requireStepState(state){
  if(!ALL_STEP_STATES.includes(state)) throw new Error(`未知的 step state：${state}`);
  return state;
}

function requireStepKind(kind){
  if(!ALL_STEP_KINDS.includes(kind)) throw new Error(`未知的 step kind：${kind}`);
  return kind;
}

function count(n){return Number.isSafeInteger(n) && n >= 0 ? n : 0;}

function requireXp(n, field){
  if(!Number.isSafeInteger(n) || n < 0) throw new Error(`${field} 必須是非負整數`);
  return n;
}

// 只留下實際存在的日期，去重並升序。壞掉的項目跳過而不是丟掉整段歷史——
// 為了一個格式錯誤的日期而讓使用者失去整條連續紀錄，代價不成比例。
function normalizeDateList(list){
  if(!Array.isArray(list)) return [];
  const seen = new Set();
  for(const d of list){
    try{
      const ok = normalizeDue(d);
      if(ok) seen.add(ok);
    }catch{ /* 跳過無法解析的日期 */ }
  }
  return [...seen].sort();
}

// reward 少了 skillId 就不知道 XP 該加到哪，補一個新 id 只會指向不存在的技能，
// 因此整筆跳過。壞掉的是這筆獎勵，不是整個步驟。
function normalizeRewards(list){
  if(!Array.isArray(list)) return [];
  const out = [];
  for(const r of list){
    if(!r || typeof r !== "object") continue;
    if(typeof r.skillId !== "string" || !ID_PATTERN.test(r.skillId)) continue;
    if(!Number.isSafeInteger(r.xp) || r.xp < 0) continue;
    out.push({skillId: r.skillId, xp: r.xp});
  }
  return out;
}

// 根 version 與 profile.schemaVersion 同步。v3 = v2 加上今日計畫（planner）。
export const DATA_VERSION = 3;

// ── 建立：profile / core / skill / goal ───────────────────────────────────────
export function createProfile({charName = "冒險者", createdAt = null,
                               unassignedXP = 0} = {}){
  const name = typeof charName === "string" ? charName.trim() : "";
  return {
    charName: name || "冒險者",
    schemaVersion: DATA_VERSION,
    createdAt: normalizeInstant(createdAt, "profile.createdAt"),
    unassignedXP: count(unassignedXP),
  };
}

// 顏色會被直接插進 inline style。HTML 跳脫擋不住 CSS 的分隔字元（`;` `:` `(`），
// 所以 `esc()` 之後仍然可以塞進整串宣告；匯入的備份是不受信任的輸入。收斂成
// 十六進位色碼是在建立實體時就做完，而不是留給每個渲染點各自判斷。
//
// 輸出一律是六位數：畫面上到處都在色碼後面接透明度（`${color}15`、`${color}44`），
// 只要放行三位或帶 alpha 的寫法，接完就是 `#fff15` 這種無效值，卡片背景與漸層
// 會整片消失。三位數展開成六位，帶 alpha 的一律不收。
export const DEFAULT_CORE_COLOR = "#4a9eff";
const HEX_SHORT = /^#[0-9a-fA-F]{3}$/;
const HEX_FULL = /^#[0-9a-fA-F]{6}$/;

export function normalizeColor(v){
  const s = text(v).trim();
  if(HEX_FULL.test(s)) return s;
  if(HEX_SHORT.test(s)) return "#" + [...s.slice(1)].map(c => c + c).join("");
  return DEFAULT_CORE_COLOR;
}

export function createCore({id, name, title = "", icon = "", color = "",
                            order, builtin} = {}){
  const coreId = requireId(id, "core");
  if(typeof order !== "number" || !Number.isFinite(order)) throw new Error("core order 必須是有限數字");
  return {
    id: coreId,
    name: requireTitle(name),
    title: text(title).trim(),
    icon: text(icon),
    color: normalizeColor(color),
    order,
    builtin: typeof builtin === "boolean" ? builtin : isBuiltinCoreId(coreId),
  };
}

export function createNote({id, text: body, date = ""} = {}){
  const t = text(body).trim();
  if(!t) throw new Error("note text 不得為空");
  return {id: requireId(id, "n"), text: t, date: text(date)};
}

export function createSkill({id, coreId, name, type = SKILL_TYPE.ACTIVE,
                             icon = "", desc = "", source = "", xp = 0,
                             notes, mergedFrom = null, builtin = false,
                             createdAt = null} = {}){
  if(typeof coreId !== "string" || !ID_PATTERN.test(coreId)){
    throw new Error(`skill 必須屬於一個核心：${coreId}`);
  }
  if(!ALL_SKILL_TYPES.includes(type)) throw new Error(`未知的 skill type：${type}`);
  const cleanNotes = [];
  for(const n of Array.isArray(notes) ? notes : []){
    try{ cleanNotes.push(createNote(n)); }catch{ /* 跳過壞掉的筆記 */ }
  }
  return {
    id: requireId(id, "sk"),
    coreId,
    name: requireTitle(name),
    type,
    icon: text(icon),
    desc: text(desc),
    source: text(source),
    xp: requireXp(xp, "skill.xp"),
    notes: cleanNotes,
    // null = 從未合併；[] = 曾經合併但來源不可考（遷移進來的舊紀錄，§7.3）
    mergedFrom: Array.isArray(mergedFrom)
      ? mergedFrom.filter(x => typeof x === "string" && ID_PATTERN.test(x))
      : null,
    builtin: builtin === true,
    createdAt: normalizeInstant(createdAt, "skill.createdAt"),
  };
}

export function createGoal({id, title, why = "", status = GOAL_STATUS.ACTIVE,
                            coreId = null} = {}){
  if(!ALL_GOAL_STATUS.includes(status)) throw new Error(`未知的 goal status：${status}`);
  if(coreId !== null && coreId !== undefined && coreId !== ""){
    if(typeof coreId !== "string" || !ID_PATTERN.test(coreId)){
      throw new Error(`goal coreId 不合法：${coreId}`);
    }
  }
  return {
    id: requireId(id, "g"),
    title: requireTitle(title),
    why: text(why).trim(),
    status,
    coreId: coreId ? coreId : null,
  };
}

// ── 建立：step ───────────────────────────────────────────────────────────────
// order 一律由呼叫端（store）指定，避免多筆同序造成排序不穩定。
// deferCount 是衍生的中繼資料而不是使用者內容，所以壞掉時歸零而不是丟掉整筆步驟——
// 為了一個計數器而讓使用者遺失一件事，代價不成比例。
export function createStep({id, goalId = null, kind = STEP_KIND.MAIN, title,
                            desc = "", due = null, dueTime = null, order,
                            state = STEP_STATE.TODO, deferCount = 0,
                            xp, rewards, streakHistory, completedCount = 0,
                            lastCompletedDate = null, archived = false,
                            archivedAt = null, createdAt = null,
                            completedAt = null} = {}){
  if(typeof order !== "number" || !Number.isFinite(order)) throw new Error("order 必須是有限數字");
  const k = requireStepKind(kind);
  let gid = goalId ?? null;
  if(gid !== null && (typeof gid !== "string" || !ID_PATTERN.test(gid))){
    throw new Error(`goalId 不合法：${gid}`);
  }
  // 收件匣就是「還沒歸到任何目標」的東西，帶著 goalId 這件事自相矛盾。
  if(k === STEP_KIND.INBOX) gid = null;
  return {
    id: requireId(id, "s"),
    goalId: gid,
    kind: k,
    title: requireTitle(title),
    desc: text(desc),
    due: normalizeDue(due),
    dueTime: normalizeDueTime(dueTime),
    order,
    state: requireStepState(state),
    deferCount: count(deferCount),
    xp: Number.isSafeInteger(xp) && xp >= 0 ? xp : KIND_DEFAULT_XP[k],
    rewards: normalizeRewards(rewards),
    streakHistory: k === STEP_KIND.DAILY ? normalizeDateList(streakHistory) : [],
    completedCount: count(completedCount),
    lastCompletedDate: lastCompletedDate ? normalizeDue(lastCompletedDate) : null,
    // 封存與 state 正交：封存只決定顯不顯示，不改變這件事最後是完成還是放棄。
    archived: archived === true,
    archivedAt: normalizeInstant(archivedAt, "step.archivedAt"),
    createdAt: normalizeInstant(createdAt, "step.createdAt"),
    completedAt: normalizeInstant(completedAt, "step.completedAt"),
  };
}

// ── 建立：xpLog / achievement / meta ─────────────────────────────────────────
export function createXpEntry({id, date, skillId = null, xp,
                               source = XP_SOURCE.STEP, refId = null} = {}){
  if(!ALL_XP_SOURCES.includes(source)) throw new Error(`未知的 xpLog source：${source}`);
  if(!Number.isSafeInteger(xp)) throw new Error("xpLog.xp 必須是整數");
  if(skillId !== null && skillId !== undefined && skillId !== ""){
    if(typeof skillId !== "string" || !ID_PATTERN.test(skillId)){
      throw new Error(`xpLog.skillId 不合法：${skillId}`);
    }
  }
  if(refId !== null && refId !== undefined && refId !== ""){
    if(typeof refId !== "string" || !ID_PATTERN.test(refId)){
      throw new Error(`xpLog.refId 不合法：${refId}`);
    }
  }
  const day = normalizeDue(date);
  if(!day) throw new Error("xpLog.date 不得為空");
  return {
    id: requireId(id, "x"),
    date: day,
    // null = 尚未歸屬到任何技能（§4.3.1）
    skillId: skillId ? skillId : null,
    xp,
    source,
    refId: refId ? refId : null,
  };
}

export function createAchievement({id, unlockedAt} = {}){
  if(typeof id !== "string" || !ID_PATTERN.test(id)){
    throw new Error(`achievement id 不合法：${id}`);
  }
  const at = normalizeInstant(unlockedAt, "achievement.unlockedAt");
  if(!at) throw new Error("achievement unlockedAt 不得為空");
  return {id, unlockedAt: at};
}

export function createMeta({lastDailySummaryDate = null, lastWeeklyReviewDate = null,
                            inboxPeak = 0, reviewPeak = 0, activeDays} = {}){
  return {
    lastDailySummaryDate: lastDailySummaryDate ? normalizeDue(lastDailySummaryDate) : null,
    lastWeeklyReviewDate: lastWeeklyReviewDate ? normalizeDue(lastWeeklyReviewDate) : null,
    // 高水位：歷史型成就無法從當下快照回推，只能持續記錄（§3.8）
    inboxPeak: count(inboxPeak),
    reviewPeak: count(reviewPeak),
    activeDays: normalizeDateList(activeDays),
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
    {deferCount: count(step && step.deferCount) + 1});
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
// 只看 main：支線與每日任務不會擋住主線，也不會被主線遮住（§3.5）。
// 封存過的不算待辦，所以也不會被推成下一步。
export function nextStep(steps, goalId){
  if(goalId === null || goalId === undefined) return null;
  return goalSteps(steps, goalId)
    .find(s => s.kind === STEP_KIND.MAIN && !s.archived && isActionable(s.state)) || null;
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
  return steps.filter(s => s.kind === STEP_KIND.INBOX).sort(byOrderThenId);
}

// 收件匣「待處理數」的唯一定義（§6.2）。高水位與成就判定必須共用這個函式：
// 用 isActionable 而不是「排除完成與放棄」，否則把項目整理成筆記之後畫面已清空，
// 計數卻還停在原地。
export function inboxPending(steps){
  return inboxSteps(steps).filter(s => !s.archived && isActionable(s.state));
}

// ── 每日任務（§5.1）─────────────────────────────────────────────────────────
// 連續天數當場從 streakHistory 推導，不落地儲存。從今天往回走，今天還沒完成
// 不算中斷——早上打開 app 時 streak 不該先歸零再等使用者去補。
export function calcStreak(streakHistory, today){
  const days = new Set(Array.isArray(streakHistory) ? streakHistory : []);
  if(!days.size) return 0;
  let streak = 0;
  for(let back = 0; back <= MAX_STREAK_LOOKBACK; back++){
    const day = shiftDate(today, -back);
    if(days.has(day)){ streak += 1; continue; }
    if(back === 0) continue;   // 今天還沒做，不算斷
    break;
  }
  return streak;
}

// 往前 / 往後幾天。用 UTC 做算術，避免日光節約時間讓某些日子變成 23 或 25 小時。
export function shiftDate(iso, days){
  const [y, m, d] = String(iso).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  const pad = n => String(n).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

// 一條 streak 最多往回看這麼多天。純粹是迴圈的上界，不是規則。
const MAX_STREAK_LOOKBACK = 3650;

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
  return !!step && isActionable(step.state) && count(step.deferCount) >= DEFER_WARN_THRESHOLD;
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
  const visible = (steps || []).filter(s =>
    s && !s.archived && (s.goalId == null || activeIds.has(s.goalId)));

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

// ── 等級（§4.1）─────────────────────────────────────────────────────────────
// 沿用既有曲線，數值不變：LEVEL_XP[i] = 50i² + 50i，Lv1–99。
export const MAX_LV = 99;
export const LEVEL_XP = (() => {
  const a = [0];
  for(let i = 1; i <= MAX_LV; i++) a.push(50 * i * i + 50 * i);
  return a;
})();

export function calcLv(xp){
  let lv = 1;
  for(let i = 1; i <= MAX_LV; i++){
    if(xp >= LEVEL_XP[i]) lv = i; else break;
  }
  return Math.min(lv, MAX_LV);
}

export function coreXp(skills, coreId){
  return skills.filter(s => s.coreId === coreId).reduce((a, s) => a + (s.xp || 0), 0);
}

// 總等級 = 目前所有核心的等級相加，含自訂核心，不假設剛好 9 個（§4.1）。
export function totalLevel(cores, skills){
  return cores.reduce((a, c) => a + calcLv(coreXp(skills, c.id)), 0);
}

// ── 今日計畫（planner，schema v3）───────────────────────────────────────────
// 班表、每日安排、主線接續與成果紀錄的資料實體。與 v2 的實體一樣：純建構 +
// 驗證，不讀寫 storage、不決定「今天是哪一天」。推導規則住在 today-plan.js。
export const PLANNER_VERSION = 1;

// 一天的出勤只有這三種。work 與 overtime 都算一個出勤日，rest 中斷連續。
export const ATTENDANCE = {WORK: "work", OVERTIME: "overtime", REST: "rest"};
const ALL_ATTENDANCE = Object.values(ATTENDANCE);

// 精力是使用者自選的主觀值，不是量測結果。未填一律留 null，不以 mid 頂替。
export const ENERGY = {LOW: "low", MID: "mid", HIGH: "high"};
const ALL_ENERGY = Object.values(ENERGY);

// recovery = 這天收工。只影響建議與畫面，不完成步驟、不發 XP。
export const DAY_MODE = {ACTIVE: "active", RECOVERY: "recovery"};
const ALL_DAY_MODE = Object.values(DAY_MODE);

export const OUTCOME = {PROGRESS: "progress", COMPLETE: "complete"};
const ALL_OUTCOME = Object.values(OUTCOME);

export const PHASE_COUNT = 4;
export const MAX_MINUTES = 120;
export const MINUTE_CHOICES = [0, 5, 15, 25, 60, 120];
export const GOAL_BINDING_KEYS = ["ai", "video"];

// 外觀主題。auto = 交給 prefers-color-scheme，light／dark = 使用者明確指定。
export const THEME = {AUTO: "auto", LIGHT: "light", DARK: "dark"};
const ALL_THEME = Object.values(THEME);

export const PLANNER_LIMITS = {
  changeReason: 300,
  stepDetail: 1000,
  note: 4000,
  nextAction: 1000,
  url: 2048,
};

function optionalEnum(v, all, field){
  if(v === undefined || v === null || v === "") return null;
  if(!all.includes(v)) throw new Error(`${field} 不合法：${v}`);
  return v;
}

function optionalText(v, max, field){
  if(v === undefined || v === null) return "";
  if(typeof v !== "string") throw new Error(`${field} 必須是文字`);
  const t = v.trim();
  if(t.length > max) throw new Error(`${field} 最多 ${max} 字元`);
  return t;
}

function optionalMinutes(v, field){
  if(v === undefined || v === null || v === "") return null;
  if(!Number.isSafeInteger(v) || v < 0 || v > MAX_MINUTES){
    throw new Error(`${field} 必須是 0–${MAX_MINUTES} 的整數`);
  }
  return v;
}

function optionalRefId(v, field){
  if(v === undefined || v === null || v === "") return null;
  if(typeof v !== "string" || !ID_PATTERN.test(v)) throw new Error(`${field} 不合法：${v}`);
  return v;
}

// 成果連結只收絕對的 http / https。相對路徑與 javascript: 在畫面上看起來都像
// 一個連結，點下去卻是另一回事，所以擋在資料邊界而不是渲染時才判斷。
export function normalizeOutcomeUrl(v){
  if(v === undefined || v === null || v === "") return null;
  if(typeof v !== "string") throw new Error("成果連結必須是文字");
  const s = v.trim();
  if(!s) return null;
  if(s.length > PLANNER_LIMITS.url){
    throw new Error(`成果連結最多 ${PLANNER_LIMITS.url} 字元`);
  }
  let parsed;
  try{ parsed = new URL(s); }
  catch{ throw new Error("成果連結必須是完整的 http 或 https 網址"); }
  if(parsed.protocol !== "http:" && parsed.protocol !== "https:"){
    throw new Error("成果連結只接受 http 或 https");
  }
  return s;
}

// anchorDate 與 anchorPhase 少了任一個都算不出 phase。只留半組會讓畫面誤判
// 「已設定班表」，所以一併收斂成未設定。
export function createPlannerConfig({anchorDate = null, anchorPhase = null,
                                     goalBindings = null, theme = null} = {}){
  const date = anchorDate ? normalizeDue(anchorDate) : null;
  let phase = null;
  if(anchorPhase !== null && anchorPhase !== undefined && anchorPhase !== ""){
    if(!Number.isSafeInteger(anchorPhase) || anchorPhase < 0 || anchorPhase >= PHASE_COUNT){
      throw new Error(`anchorPhase 必須是 0–${PHASE_COUNT - 1} 的整數`);
    }
    phase = anchorPhase;
  }
  const paired = date !== null && phase !== null;
  const bindings = {};
  const raw = goalBindings && typeof goalBindings === "object" ? goalBindings : {};
  for(const key of GOAL_BINDING_KEYS){
    bindings[key] = optionalRefId(raw[key], `goalBindings.${key}`);
  }
  return {
    anchorDate: paired ? date : null,
    anchorPhase: paired ? phase : null,
    goalBindings: bindings,
    theme: normalizeTheme(theme),
  };
}

// 主題是純外觀，壞掉的值不該讓整份 config 被丟回預設值（那會連 anchor 一起
// 失去，§store restorePlanner）。因此這裡不丟例外，只把三種壞法各自擋掉：
// 缺席（undefined／null）、空值（""）、型別偽裝（陣列、物件、數字都不是
// 合法主題字串）。都退回 auto。
export function normalizeTheme(v){
  return typeof v === "string" && ALL_THEME.includes(v) ? v : THEME.AUTO;
}

export function createPlannerFocus({goalId, stepId, acceptedAt = null} = {}){
  const g = optionalRefId(goalId, "focus.goalId");
  const s = optionalRefId(stepId, "focus.stepId");
  if(!g || !s) throw new Error("focus 必須同時有 goalId 與 stepId");
  return {goalId: g, stepId: s, acceptedAt: normalizeInstant(acceptedAt, "focus.acceptedAt")};
}

export function createPlannerDay({attendancePlan = null, attendanceActual = null,
                                  energy = null, availableMinutes = null,
                                  plannedMinutes = null, mode = DAY_MODE.ACTIVE,
                                  focus = null, changeReason = "",
                                  updatedAt = null} = {}){
  const available = optionalMinutes(availableMinutes, "availableMinutes");
  let planned = optionalMinutes(plannedMinutes, "plannedMinutes");
  // 可用時間被調低時把已選時間縮到上限（§4）。0 與 null 是兩件事：0 代表使用者
  // 選了「今天不做」，null 代表還沒選，所以只夾上限，不把 0 當成未填。
  if(planned !== null && available !== null && planned > available) planned = available;
  return {
    attendancePlan: optionalEnum(attendancePlan, ALL_ATTENDANCE, "attendancePlan"),
    attendanceActual: optionalEnum(attendanceActual, ALL_ATTENDANCE, "attendanceActual"),
    energy: optionalEnum(energy, ALL_ENERGY, "energy"),
    availableMinutes: available,
    plannedMinutes: planned,
    mode: optionalEnum(mode, ALL_DAY_MODE, "mode") || DAY_MODE.ACTIVE,
    focus: focus ? createPlannerFocus(focus) : null,
    changeReason: optionalText(changeReason, PLANNER_LIMITS.changeReason, "changeReason"),
    updatedAt: normalizeInstant(updatedAt, "day.updatedAt"),
  };
}

// 使用者替某個 step 補的說明。不是另建一個 step，所以沒有 id、state 或 XP。
export function createStepDetail({firstAction = "", minimumAction = "",
                                  completionCriteria = ""} = {}){
  const max = PLANNER_LIMITS.stepDetail;
  return {
    firstAction: optionalText(firstAction, max, "firstAction"),
    minimumAction: optionalText(minimumAction, max, "minimumAction"),
    completionCriteria: optionalText(completionCriteria, max, "completionCriteria"),
  };
}

export function createPlannerEntry({id, requestId, day, goalId = null, stepId,
                                    outcome, note = "", nextAction = "",
                                    url = null, createdAt = null} = {}){
  if(!ALL_OUTCOME.includes(outcome)) throw new Error(`未知的 outcome：${outcome}`);
  const d = normalizeDue(day);
  if(!d) throw new Error("entry.day 不得為空");
  const s = optionalRefId(stepId, "entry.stepId");
  if(!s) throw new Error("entry.stepId 不得為空");
  const text = optionalText(note, PLANNER_LIMITS.note, "note");
  if(!text) throw new Error("要先寫下這次做了什麼");
  const next = optionalText(nextAction, PLANNER_LIMITS.nextAction, "nextAction");
  // 記錄進度而沒有下一個動作，下次打開就只剩一段回憶，接不下去（§5）。
  if(outcome === OUTCOME.PROGRESS && !next) throw new Error("要先寫下下一個動作");
  return {
    id: requireId(id, "pe"),
    requestId: requireId(requestId, "req"),
    day: d,
    goalId: optionalRefId(goalId, "entry.goalId"),
    stepId: s,
    outcome,
    note: text,
    nextAction: next,
    url: normalizeOutcomeUrl(url),
    createdAt: normalizeInstant(createdAt, "entry.createdAt"),
  };
}

export function createPlanner({version = PLANNER_VERSION, config = null} = {}){
  return {
    version: Number.isSafeInteger(version) && version > 0 ? version : PLANNER_VERSION,
    config: createPlannerConfig(config || {}),
    days: {},
    stepDetails: {},
    entries: [],
  };
}
