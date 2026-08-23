// ── 儲存層 ───────────────────────────────────────────────────────────────────
// Goal / Step 的讀寫全部收斂在這個模組。UI 只透過 store 的方法存取資料，
// 因此之後把 backend 換成 IndexedDB 時不需要動到任何檢視程式碼。

import * as model from "./model.js";

export const STORAGE_KEY = "skill-goals-v1";
export const SCHEMA_VERSION = 1;

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

function emptyData(){return {version: SCHEMA_VERSION, goals: [], steps: []};}

// Goal / Step 都是扁平的純值物件，逐筆展開就足以切斷與內部資料的參照。
// 只複製陣列不夠：呼叫端仍可透過 snapshot 改到內部紀錄，繞過驗證。
const copy = rec => (rec ? {...rec} : rec);
const copyAll = list => list.map(copy);

// 壞掉的單筆資料就丟掉，不讓整包資料因為一筆髒資料而全滅。
function sanitize(raw){
  const data = emptyData();
  if(!raw || typeof raw !== "object") return data;
  const goalIds = new Set();
  for(const g of Array.isArray(raw.goals) ? raw.goals : []){
    try{
      const goal = model.createGoal(g);
      if(goalIds.has(goal.id)) continue;
      goalIds.add(goal.id);
      data.goals.push(goal);
    }catch{ /* 跳過無法還原的目標 */ }
  }
  const stepIds = new Set();
  for(const s of Array.isArray(raw.steps) ? raw.steps : []){
    try{
      const step = model.createStep(s);
      if(stepIds.has(step.id)) continue;
      // 指向不存在目標的 step 退回收件匣，而不是直接丟棄
      if(step.goalId !== null && !goalIds.has(step.goalId)) step.goalId = null;
      stepIds.add(step.id);
      data.steps.push(step);
    }catch{ /* 跳過無法還原的步驟 */ }
  }
  return data;
}

export function createStore(backend = defaultBackend()){
  let data = emptyData();

  function persist(){
    try{
      backend.setItem(STORAGE_KEY, JSON.stringify(data));
    }catch{ /* 配額滿或無法寫入時保持記憶體狀態，不讓 UI 崩掉 */ }
    return data;
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
    persist();
    return copy(step);
  }

  const store = {
    load(){
      let raw = null;
      try{
        const text = backend.getItem(STORAGE_KEY);
        raw = text ? JSON.parse(text) : null;
      }catch{ /* 讀不到或不是合法 JSON，視同空資料 */ }
      data = sanitize(raw);
      return store.getState();
    },

    // 對外一律回傳複本，避免呼叫端繞過 store 直接改到內部陣列
    getState(){
      return {version: data.version, goals: copyAll(data.goals), steps: copyAll(data.steps)};
    },

    save(){return persist();},

    // ── Goal ────────────────────────────────────────────────────────────────
    addGoal({title, why = ""} = {}){
      const goal = model.createGoal({title, why});
      data.goals = [...data.goals, goal];
      persist();
      return copy(goal);
    },

    updateGoal(id, patch = {}){
      const i = findGoal(id);
      const goal = model.createGoal({...data.goals[i], ...patch, id});
      data.goals = data.goals.map((g, n) => (n === i ? goal : g));
      persist();
      return copy(goal);
    },

    setGoalStatus(id, status){return store.updateGoal(id, {status});},

    // ── Step ────────────────────────────────────────────────────────────────
    addStep({goalId = null, title, due = null} = {}){
      if(goalId !== null) findGoal(goalId);
      const step = model.createStep({
        goalId, title, due,
        order: model.nextOrder(data.steps, goalId),
      });
      data.steps = [...data.steps, step];
      persist();
      return copy(step);
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

    scheduleStep(id, due){
      const i = findStep(id);
      return replaceStep(i, model.scheduleStep(data.steps[i], due));
    },

    // 收件匣項目歸入目標時排到該目標最後，不插隊搶走現有的下一步
    assignStep(id, goalId){
      const i = findStep(id);
      if(goalId !== null) findGoal(goalId);
      return replaceStep(i, {
        ...data.steps[i],
        goalId,
        order: model.nextOrder(data.steps.filter(s => s.id !== id), goalId),
      });
    },

    // ── 推導（轉呼叫 model，讓檢視只需要依賴 store）────────────────────────
    nextStep(goalId){return copy(model.nextStep(data.steps, goalId));},
    goalSteps(goalId){return copyAll(model.goalSteps(data.steps, goalId));},
    goalProgress(goalId){return model.goalProgress(data.steps, goalId);},
    inboxSteps(){return copyAll(model.inboxSteps(data.steps));},
    todayList(){
      return model.todayList(data.goals, data.steps)
        .map(({goal, step}) => ({goal: copy(goal), step: copy(step)}));
    },

    // ── 備份匯出 / 匯入 ─────────────────────────────────────────────────────
    toJSON(){return store.getState();},

    replaceAll(raw){
      data = sanitize(raw);
      persist();
      return store.getState();
    },
  };

  return store;
}
