// ── 儲存層（schema v2）───────────────────────────────────────────────────────
// 所有讀寫都收斂在這個模組。UI 只透過 store 存取資料，因此之後把 backend 換成
// IndexedDB 時不需要動到任何檢視程式碼。規格見 docs/RPG_SPEC.md §3、§7。

import * as model from "./model.js";
import {migrateV1, emptyReport, reportTotal, hasMergeNote} from "./migrate.js";

export const STORAGE_KEY = "skill-rpg-v2";
export const SCHEMA_VERSION = 2;

// 舊 key 保留不動，作為最後的回退路徑（§7.1）
export const LEGACY_PWA_KEY = "skill-pwa-v1";
export const LEGACY_GOALS_KEY = "skill-goals-v1";
export const BACKUP_KEY = "skill-backup-v1";

// backend 介面只需要 getItem / setItem，方便替換與測試。
function memoryBackend(){
  const m = new Map();
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => {m.set(k, String(v));},
  };
}

export function defaultBackend(){
  try{
    if(typeof localStorage !== "undefined" && localStorage) return localStorage;
  }catch{ /* Safari 隱私模式存取 localStorage 會丟例外 */ }
  return memoryBackend();
}

function emptyData(){
  return {
    version: SCHEMA_VERSION,
    profile: model.createProfile({}),
    cores: model.BUILTIN_CORES.map((c, i) => model.createCore({...c, order: i})),
    skills: [],
    goals: [],
    steps: [],
    xpLog: [],
    achievements: [],
    meta: model.createMeta({}),
  };
}

// 實體都是扁平純值物件，但 notes / rewards / streakHistory 是巢狀陣列，
// 只淺拷貝的話呼叫端仍可改到內部紀錄，繞過驗證。
function copyStep(s){
  return s ? {...s, rewards: s.rewards.map(r => ({...r})),
              streakHistory: [...s.streakHistory]} : s;
}
function copySkill(s){
  return s ? {...s, notes: s.notes.map(n => ({...n})),
              mergedFrom: s.mergedFrom ? [...s.mergedFrom] : null} : s;
}
const copy = rec => (rec ? {...rec} : rec);
const copyAll = (list, fn = copy) => list.map(fn);

function parse(text){
  try{ return text ? JSON.parse(text) : null; }catch{ return null; }
}

// 壞掉的單筆資料就丟掉，不讓整包資料因為一筆髒資料而全滅。
// 但跳過的筆數要能回報出去——靜默的資料遺失是察覺不到的（§7.1）。
function sanitize(raw){
  const data = emptyData();
  const report = emptyReport();
  if(!raw || typeof raw !== "object") return {data, report};

  try{ data.profile = model.createProfile(raw.profile || {}); }catch{ /* 用預設 */ }
  try{ data.meta = model.createMeta(raw.meta || {}); }catch{ /* 用預設 */ }

  if(Array.isArray(raw.cores)){
    const cores = [];
    const used = new Set();
    raw.cores.forEach((c, i) => {
      try{
        const core = model.createCore({...c, order: typeof c?.order === "number" ? c.order : i});
        if(used.has(core.id)) return;
        used.add(core.id);
        cores.push(core);
      }catch{ report.skippedCores += 1; }
    });
    if(cores.length) data.cores = cores.sort((a, b) => a.order - b.order);
  }
  const coreIds = new Set(data.cores.map(c => c.id));

  data.skills = [];
  const skillIds = new Set();
  for(const s of Array.isArray(raw.skills) ? raw.skills : []){
    try{
      const skill = model.createSkill(s);
      if(skillIds.has(skill.id)) continue;
      skillIds.add(skill.id);
      data.skills.push(skill);
    }catch{ report.skippedSkills += 1; }
  }

  const goalIds = new Set();
  for(const g of Array.isArray(raw.goals) ? raw.goals : []){
    try{
      const goal = model.createGoal(g);
      if(goalIds.has(goal.id)) continue;
      // 指向不存在核心的 goal 退回未綁定，而不是整筆丟掉
      if(goal.coreId && !coreIds.has(goal.coreId)) goal.coreId = null;
      goalIds.add(goal.id);
      data.goals.push(goal);
    }catch{ report.skippedGoals += 1; }
  }

  const stepIds = new Set();
  for(const s of Array.isArray(raw.steps) ? raw.steps : []){
    try{
      const step = model.createStep(s);
      if(stepIds.has(step.id)) continue;
      // 指向不存在目標的 step 退回無目標。main 的 goalId 允許為 null，
      // 所以不需要改 kind，也不會被驗證擋掉（§3.5）。
      if(step.goalId !== null && !goalIds.has(step.goalId)) step.goalId = null;
      stepIds.add(step.id);
      data.steps.push(step);
    }catch{ report.skippedSteps += 1; }
  }

  for(const e of Array.isArray(raw.xpLog) ? raw.xpLog : []){
    try{ data.xpLog.push(model.createXpEntry(e)); }catch{ /* 跳過壞掉的紀錄 */ }
  }
  const unlocked = new Set();
  for(const a of Array.isArray(raw.achievements) ? raw.achievements : []){
    try{
      const ach = model.createAchievement(a);
      if(unlocked.has(ach.id)) continue;
      unlocked.add(ach.id);
      data.achievements.push(ach);
    }catch{ /* 跳過壞掉的解鎖紀錄 */ }
  }

  return {data, report};
}

// 每個核心都要有承接技能，接住沒有指定 rewards 的 XP（§4.3）。
// 核心 XP 定義為「底下所有技能 XP 總和」，讓 XP 直接掛在核心上會多出第二條
// 計算路徑，之後每個統計都要處理兩次。
function ensureGeneralSkills(data){
  const have = new Set(data.skills.map(s => s.id));
  for(const core of data.cores){
    const id = model.generalSkillId(core.id);
    if(have.has(id)) continue;
    data.skills.push(model.createSkill({
      id,
      coreId: core.id,
      name: model.GENERAL_SKILL_NAME,
      type: model.SKILL_TYPE.ACTIVE,
      icon: "✨",
      desc: "沒有指定技能的行動累積在這裡",
      builtin: true,
    }));
  }
}

// 高水位一旦沒記就補不回來：「曾經有過幾筆」無法從當下快照回推（§3.8）。
function updatePeaks(data, today){
  const inbox = model.inboxPending(data.steps).length;
  const review = model.reviewItems(data.goals, data.steps, today).total;
  data.meta.inboxPeak = Math.max(data.meta.inboxPeak, inbox);
  data.meta.reviewPeak = Math.max(data.meta.reviewPeak, review);
}

function todayISO(d = new Date()){
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ── legacy 投影 ──────────────────────────────────────────────────────────────
// index.html 的內嵌 script 仍以 {charName, cores, subSkills, quests} 的形狀工作。
// 這一層把 v2 投影成那個形狀再投影回來，讓 UI 不必直接碰 storage，也不需要在
// 這個 PR 就整份重寫（UI 的統一是 PR 3 的事）。

// quest 來源的步驟：沒有目標、也不是收件匣。Goal/Step 層的項目不在這個集合裡，
// 所以 legacy 存檔不會動到它們。
function isQuestStep(s){
  return s.goalId === null && s.kind !== model.STEP_KIND.INBOX;
}

const LEGACY_TYPE = {
  [model.STEP_KIND.MAIN]: "main",
  [model.STEP_KIND.SIDE]: "side",
  [model.STEP_KIND.DAILY]: "daily",
};

function coerceId(raw, prefix){
  if(typeof raw === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(raw)) return raw;
  const part = String(raw ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 48);
  return part ? `${prefix}_${part}` : "";
}

function toLegacyQuest(s){
  return {
    id: s.id,
    title: s.title,
    type: LEGACY_TYPE[s.kind] || "side",
    desc: s.desc,
    dueDate: s.due || "",
    dueTime: s.dueTime || "",
    rewards: s.rewards.map(r => ({...r})),
    rewardSkillId: s.rewards[0] ? s.rewards[0].skillId : null,
    rewardXP: s.rewards[0] ? s.rewards[0].xp : 50,
    done: s.state === model.STEP_STATE.DONE,
    completedAt: s.completedAt,
    completedCount: s.completedCount,
    lastCompletedDate: s.lastCompletedDate,
    createdAt: s.createdAt,
    streakHistory: [...s.streakHistory],
    archived: s.archived,
    archivedAt: s.archivedAt,
  };
}

// legacy 的 note id 是 Date.now() 產生的數字，過不了 ID_PATTERN，先轉成合法形狀。
function legacyNotes(raw){
  const out = [];
  for(const n of Array.isArray(raw) ? raw : []){
    if(!n || typeof n !== "object") continue;
    out.push({...n, id: coerceId(n.id, "n") || undefined});
  }
  return out;
}

function toLegacySkill(s){
  return {
    id: s.id, coreId: s.coreId, name: s.name, type: s.type,
    xp: s.xp, icon: s.icon, desc: s.desc, source: s.source,
    notes: s.notes.map(n => ({...n})),
  };
}

const KIND_FROM_LEGACY = {main: model.STEP_KIND.MAIN,
                          side: model.STEP_KIND.SIDE,
                          daily: model.STEP_KIND.DAILY};

export function createStore(backend = defaultBackend()){
  let data = emptyData();
  let report = emptyReport();
  let migrated = false;
  let fresh = false;

  function persist(){
    try{
      backend.setItem(STORAGE_KEY, JSON.stringify(data));
    }catch{ /* 配額滿或無法寫入時保持記憶體狀態，不讓 UI 崩掉 */ }
    // 刻意不回傳 data：內部紀錄一律不外流，避免呼叫端繞過驗證改到內部狀態。
  }

  function commit(){
    ensureGeneralSkills(data);
    updatePeaks(data, todayISO());
    persist();
  }

  function findStep(id){
    const i = data.steps.findIndex(s => s.id === id);
    if(i < 0) throw new Error(`找不到 step：${id}`);
    return i;
  }

  function findGoal(id){
    const i = data.goals.findIndex(g => g.id === id);
    if(i < 0) throw new Error(`找不到 goal：${id}`);
    return i;
  }

  function replaceStep(i, step){
    data.steps = data.steps.map((s, n) => (n === i ? step : s));
    commit();
    return copyStep(step);
  }

  const store = {
    // 載入：v2 存在就直接用；不存在才跑一次遷移，並且不刪任何舊資料（§7.1）。
    load(){
      const existing = parse(backend.getItem(STORAGE_KEY));
      if(existing){
        const out = sanitize(existing);
        data = out.data;
        report = out.report;
        migrated = false;
        fresh = false;
      }else{
        const pwa = parse(backend.getItem(LEGACY_PWA_KEY));
        const goals = parse(backend.getItem(LEGACY_GOALS_KEY));
        const out = migrateV1({pwa, goals});
        data = out.data;
        report = out.report;
        migrated = !!(pwa || goals);
        // 全新安裝（不是「使用者把資料清空了」）。這兩件事必須分得出來，
        // 否則刪光技能之後重開，預設技能會自己長回來。
        fresh = !migrated;
        // 轉換前先留一份原樣快照，已存在則不覆寫
        if(migrated && !backend.getItem(BACKUP_KEY)){
          try{
            backend.setItem(BACKUP_KEY, JSON.stringify({
              savedAt: new Date().toISOString(),
              [LEGACY_PWA_KEY]: pwa,
              [LEGACY_GOALS_KEY]: goals,
            }));
          }catch{ /* 備份寫不進去也不能擋住載入 */ }
        }
      }
      commit();
      return store.getState();
    },

    // 遷移或載入時跳過了哪些資料。呼叫端負責讓使用者看得到。
    migrationReport(){
      return {...report, total: reportTotal(report), migrated, fresh};
    },

    // 對外一律回傳複本，避免呼叫端繞過 store 直接改到內部陣列
    getState(){
      return {
        version: data.version,
        profile: copy(data.profile),
        cores: copyAll(data.cores),
        skills: copyAll(data.skills, copySkill),
        goals: copyAll(data.goals),
        steps: copyAll(data.steps, copyStep),
        xpLog: copyAll(data.xpLog),
        achievements: copyAll(data.achievements),
        meta: {...data.meta, activeDays: [...data.meta.activeDays]},
      };
    },

    save(){
      commit();
      return store.getState();
    },

    // ── Goal ────────────────────────────────────────────────────────────────
    addGoal({title, why = "", coreId = null} = {}){
      const goal = model.createGoal({title, why, coreId});
      data.goals = [...data.goals, goal];
      commit();
      return copy(goal);
    },

    updateGoal(id, patch = {}){
      const i = findGoal(id);
      const goal = model.createGoal({...data.goals[i], ...patch, id});
      data.goals = data.goals.map((g, n) => (n === i ? goal : g));
      commit();
      return copy(goal);
    },

    setGoalStatus(id, status){return store.updateGoal(id, {status});},

    // ── Step ────────────────────────────────────────────────────────────────
    addStep({goalId = null, kind, title, due = null, desc = "", xp,
             rewards} = {}){
      if(goalId !== null) findGoal(goalId);
      const k = kind || (goalId === null ? model.STEP_KIND.INBOX : model.STEP_KIND.MAIN);
      const step = model.createStep({
        goalId, kind: k, title, due, desc, xp, rewards,
        order: model.nextOrder(data.steps, k === model.STEP_KIND.INBOX ? null : goalId),
      });
      data.steps = [...data.steps, step];
      commit();
      return copyStep(step);
    },

    completeStep(id){
      const i = findStep(id);
      return replaceStep(i, model.completeStep(data.steps[i]));
    },

    deferStep(id){
      const i = findStep(id);
      return replaceStep(i, model.deferStep(data.steps[i]));
    },

    reopenStep(id){
      const i = findStep(id);
      return replaceStep(i, model.reopenStep(data.steps[i]));
    },

    noteStep(id){
      const i = findStep(id);
      return replaceStep(i, model.noteStep(data.steps[i]));
    },

    dropStep(id){
      const i = findStep(id);
      return replaceStep(i, model.dropStep(data.steps[i]));
    },

    scheduleStep(id, due){
      const i = findStep(id);
      return replaceStep(i, model.scheduleStep(data.steps[i], due));
    },

    // 收件匣項目歸入目標時轉成主線並排到最後，不插隊搶走現有的下一步
    assignStep(id, goalId){
      const i = findStep(id);
      if(goalId !== null) findGoal(goalId);
      const kind = goalId === null ? model.STEP_KIND.INBOX : model.STEP_KIND.MAIN;
      return replaceStep(i, model.createStep({
        ...data.steps[i],
        goalId,
        kind,
        order: model.nextOrder(data.steps.filter(s => s.id !== id), goalId),
      }));
    },

    // ── 推導（轉呼叫 model，讓檢視只需要依賴 store）────────────────────────
    nextStep(goalId){return copyStep(model.nextStep(data.steps, goalId));},
    goalSteps(goalId){return copyAll(model.goalSteps(data.steps, goalId), copyStep);},
    goalProgress(goalId){return model.goalProgress(data.steps, goalId);},
    inboxSteps(){return copyAll(model.inboxSteps(data.steps), copyStep);},
    inboxPending(){return copyAll(model.inboxPending(data.steps), copyStep);},
    coreXp(coreId){return model.coreXp(data.skills, coreId);},
    totalLevel(){return model.totalLevel(data.cores, data.skills);},
    reviewItems(today){
      const r = model.reviewItems(data.goals, data.steps, today);
      return {
        stalling: copyAll(r.stalling, copyStep),
        longOverdue: copyAll(r.longOverdue, copyStep),
        stalledGoals: copyAll(r.stalledGoals),
        total: r.total,
      };
    },
    todayList(){
      return model.todayList(data.goals, data.steps)
        .map(({goal, step}) => ({goal: copy(goal), step: copyStep(step)}));
    },

    // ── legacy 投影（給 index.html 的內嵌 script）─────────────────────────
    legacyState(){
      return {
        charName: data.profile.charName,
        // 承接技能是系統產生的容器，不是使用者建立的技能，所以不投影出去。
        cores: data.cores.map(c => ({id:c.id, name:c.name, title:c.title,
                                     icon:c.icon, color:c.color})),
        subSkills: data.skills.filter(s => !s.builtin).map(toLegacySkill),
        quests: data.steps.filter(isQuestStep)
          .sort((a, b) => a.order - b.order).map(toLegacyQuest),
      };
    },

    // 反向投影。只覆寫 legacy 認得的那部分，Goal/Step 層的資料原封不動。
    saveLegacyState(state = {}){
      if(typeof state.charName === "string" && state.charName.trim()){
        data.profile = model.createProfile({...data.profile, charName: state.charName});
      }

      const prevCoreIds = new Set(data.cores.map(c => c.id));
      if(Array.isArray(state.cores) && state.cores.length){
        const cores = [];
        const used = new Set();
        state.cores.forEach((c, i) => {
          try{
            const core = model.createCore({...c, order: i});
            if(used.has(core.id)) return;
            used.add(core.id);
            cores.push(core);
          }catch{ /* 跳過壞掉的核心 */ }
        });
        if(cores.length) data.cores = cores;
      }
      const coreIds = new Set(data.cores.map(c => c.id));
      const coreRemoved = [...prevCoreIds].some(id => !coreIds.has(id));

      const prevSkills = new Map(data.skills.map(s => [s.id, s]));
      const skills = [];
      const usedSkills = new Set();
      for(const raw of Array.isArray(state.subSkills) ? state.subSkills : []){
        if(!raw || typeof raw !== "object") continue;
        const id = coerceId(raw.id, "sk");
        if(!id || usedSkills.has(id)) continue;
        const prev = prevSkills.get(id);
        try{
          const skill = model.createSkill({
            ...raw,
            id,
            notes: legacyNotes(raw.notes),
            builtin: false,
            // legacy 的形狀帶不動這兩個欄位，沿用既有值才不會每存一次就抹掉一次。
            mergedFrom: prev ? prev.mergedFrom : (hasMergeNote(raw.notes) ? [] : null),
            createdAt: prev ? prev.createdAt : null,
          });
          usedSkills.add(id);
          skills.push(skill);
        }catch{ /* 跳過壞掉的技能 */ }
      }
      // 刪除核心是一筆交易：底下的技能連同承接技能一起走（§3.2）。
      data.skills = skills.concat(
        data.skills.filter(s => s.builtin && coreIds.has(s.coreId)));
      const liveSkillIds = new Set(data.skills.map(s => s.id));

      const prevSteps = new Map(data.steps.map(s => [s.id, s]));
      const kept = data.steps.filter(s => !isQuestStep(s));
      const usedStepIds = new Set(kept.map(s => s.id));
      const questSteps = [];
      (Array.isArray(state.quests) ? state.quests : []).forEach((q, order) => {
        if(!q || typeof q !== "object") return;
        const id = coerceId(q.id, "q");
        if(!id || usedStepIds.has(id)) return;
        const prev = prevSteps.get(id);
        const done = q.done === true;
        try{
          const step = model.createStep({
            id,
            goalId: null,
            kind: KIND_FROM_LEGACY[q.type] || model.STEP_KIND.SIDE,
            title: q.title,
            desc: q.desc,
            due: q.dueDate || null,
            dueTime: q.dueTime || null,
            order,
            // legacy 只知道 done 或不 done，別的狀態（順延、排程）沿用既有值，
            // 否則從任務頁存一次就會把它們抹平成待辦。
            state: done ? model.STEP_STATE.DONE
                        : (prev && prev.state !== model.STEP_STATE.DONE
                            ? prev.state : model.STEP_STATE.TODO),
            deferCount: prev ? prev.deferCount : 0,
            xp: prev ? prev.xp : undefined,
            rewards: q.rewards,
            streakHistory: q.streakHistory,
            completedCount: q.completedCount,
            lastCompletedDate: q.lastCompletedDate || null,
            archived: q.archived === true,
            archivedAt: q.archived === true ? (q.archivedAt || null) : null,
            createdAt: q.createdAt || (prev ? prev.createdAt : null),
            completedAt: q.completedAt || null,
          });
          usedStepIds.add(id);
          questSteps.push(step);
        }catch{ /* 跳過壞掉的任務 */ }
      });
      data.steps = [...questSteps, ...kept];

      if(coreRemoved){
        // 指向已移除技能的 reward 一併清掉，不留懸空參照（§3.2）
        data.steps = data.steps.map(s => {
          const rewards = s.rewards.filter(r => liveSkillIds.has(r.skillId));
          return rewards.length === s.rewards.length ? s : {...s, rewards};
        });
        data.goals = data.goals.map(g =>
          (g.coreId && !coreIds.has(g.coreId)) ? {...g, coreId: null} : g);
      }

      commit();
      return store.getState();
    },

    // ── 備份匯出 / 匯入 ─────────────────────────────────────────────────────
    toJSON(){return store.getState();},

    // v2 直接吃；認得出 v1 就走同一條遷移路徑（§7.4）
    replaceAll(raw){
      const looksV1 = raw && typeof raw === "object" && !raw.profile
        && (Array.isArray(raw.subSkills) || typeof raw.charName === "string");
      const out = looksV1
        ? migrateV1({pwa: raw, goals: {goals: raw.goals, steps: raw.steps}})
        : sanitize(raw);
      data = out.data;
      report = out.report;
      migrated = looksV1;
      fresh = false;
      commit();
      return store.getState();
    },
  };

  return store;
}
