// ── 儲存層（schema v2）───────────────────────────────────────────────────────
// 所有讀寫都收斂在這個模組。UI 只透過 store 存取資料，因此之後把 backend 換成
// IndexedDB 時不需要動到任何檢視程式碼。規格見 docs/RPG_SPEC.md §3、§7。

import * as model from "./model.js";
import {migrateV1, emptyReport, reportTotal, hasMergeNote, normalizeLegacyNotes,
        countSkillDrops, countStepDrops} from "./migrate.js";
// XP 的規則與「今天」都住在 rpg.js：store 只負責套用結果並落地（§4、§5.0）。
import {logicalToday, resolveGrants, compressXpLog, canBackfill,
        countsAsActivity, BACKFILL_DAYS} from "./rpg.js";

export const STORAGE_KEY = "skill-rpg-v2";
export const SCHEMA_VERSION = 2;

// 舊 key 保留不動，作為最後的回退路徑（§7.1）
export const LEGACY_PWA_KEY = "skill-pwa-v1";
export const LEGACY_GOALS_KEY = "skill-goals-v1";
export const BACKUP_KEY = "skill-backup-v1";
// 既有 v2 解得開但含壞資料時的原樣快照。sanitize 丟掉的那幾筆也許還救得回來，
// 覆寫之後就真的沒了。
export const DAMAGED_KEY = "skill-damaged-v2";

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

// 「沒有這個 key」與「有值但解不開」是兩件事。都回傳 null 的話，一份被截斷的
// v2 會被當成不存在，接著 commit() 用預設值或遷移結果蓋掉它——那份殘缺的 JSON
// 也許還能手動救回來，覆蓋之後就真的沒了。
function decode(text){
  if(text === null || text === undefined || text === "") return {ok: true, value: null};
  try{ return {ok: true, value: JSON.parse(text)}; }
  catch{ return {ok: false, value: null}; }
}

// backend.getItem 本身可能丟例外（受限的隱私 / 儲存環境）。讓它往上冒會使
// install() 在掛上 window.Goals 之前就中斷，整個 app 停在載入中的提示畫面。
//
// 但「讀不到」和「沒有資料」必須分得出來：把例外一律當成 null，load() 會以為
// 什麼都沒有，接著把預設值寫回去，直接蓋掉讀不到但其實還在的資料。
function read(backend, key){
  try{ return {ok: true, text: backend.getItem(key)}; }
  catch{ return {ok: false, text: null}; }
}

// 壞掉的單筆資料就丟掉，不讓整包資料因為一筆髒資料而全滅。
// 但跳過的筆數要能回報出去——靜默的資料遺失是察覺不到的（§7.1）。
// v2 應該有的區段。整段缺席時 sanitize 會安靜地補上預設值或空陣列，
// 匯入一份被截斷的備份就會把現有的目標與步驟清掉還回報成功，所以要計入損失。
const V2_ARRAYS = ["cores", "skills", "goals", "steps", "xpLog", "achievements"];
const V2_OBJECTS = ["profile", "meta"];

function sanitize(raw){
  const data = emptyData();
  const report = emptyReport();
  if(!raw || typeof raw !== "object") return {data, report};

  for(const k of V2_ARRAYS) if(!Array.isArray(raw[k])) report.missingSections += 1;
  for(const k of V2_OBJECTS){
    if(!raw[k] || typeof raw[k] !== "object") report.missingSections += 1;
  }

  // 還原失敗時整個區段被預設值取代：一個壞掉的 createdAt 會連角色名稱與
  // 未歸屬 XP 一起換掉。跟區段缺席一樣是整區的損失，同樣要計入。
  try{ data.profile = model.createProfile(raw.profile || {}); }
  catch{ report.missingSections += 1; }
  try{ data.meta = model.createMeta(raw.meta || {}); }
  catch{ report.missingSections += 1; }

  // 存過的 cores 一律照收，即使是空陣列——那代表使用者把核心全刪了。
  // 用長度當守衛會讓已刪的核心在下次載入時整批復活。跳過的壞資料進 report。
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
    data.cores = cores.sort((a, b) => a.order - b.order);
  }
  const coreIds = new Set(data.cores.map(c => c.id));

  data.skills = [];
  const skillIds = new Set();
  for(const s of Array.isArray(raw.skills) ? raw.skills : []){
    try{
      const skill = model.createSkill(s);
      if(skillIds.has(skill.id)) continue;
      countSkillDrops(s, skill, report);
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
      countStepDrops(s, step, report);
      // 指向不存在目標的 step 退回無目標。main 的 goalId 允許為 null，
      // 所以不需要改 kind，也不會被驗證擋掉（§3.5）。
      if(step.goalId !== null && !goalIds.has(step.goalId)) step.goalId = null;
      stepIds.add(step.id);
      data.steps.push(step);
    }catch{ report.skippedSteps += 1; }
  }

  for(const e of Array.isArray(raw.xpLog) ? raw.xpLog : []){
    try{ data.xpLog.push(model.createXpEntry(e)); }
    catch{ report.skippedXpLog += 1; }
  }
  const unlocked = new Set();
  for(const a of Array.isArray(raw.achievements) ? raw.achievements : []){
    try{
      const ach = model.createAchievement(a);
      if(unlocked.has(ach.id)) continue;
      unlocked.add(ach.id);
      data.achievements.push(ach);
    }catch{ report.skippedAchievements += 1; }
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

function toLegacySkill(s){
  return {
    id: s.id, coreId: s.coreId, name: s.name, type: s.type,
    xp: s.xp, icon: s.icon, desc: s.desc, source: s.source,
    notes: s.notes.map(n => ({...n})),
  };
}

// 匯入的轉換。inspect() 與 replaceAll() 共用，才不會出現「試算說沒問題、
// 實際匯入卻掉資料」這種兩套邏輯各自演化的情況。
function convert(raw){
  const looksV1 = raw && typeof raw === "object" && !raw.profile
    && (Array.isArray(raw.subSkills) || typeof raw.charName === "string");
  // 舊版匯出把 Goal/Step 放在 goalsData 信封裡，不是攤平在頂層。只讀頂層的話
  // 這類備份會靜默丟掉所有目標與步驟，還回報匯入成功。
  const env = looksV1 && raw.goalsData && typeof raw.goalsData === "object"
    ? raw.goalsData : raw;
  const out = looksV1
    ? migrateV1({pwa: raw, goals: {goals: env.goals, steps: env.steps}})
    : sanitize(raw);
  return {...out, looksV1};
}

const KIND_FROM_LEGACY = {main: model.STEP_KIND.MAIN,
                          side: model.STEP_KIND.SIDE,
                          daily: model.STEP_KIND.DAILY};

export function createStore(backend = defaultBackend()){
  let data = emptyData();
  let report = emptyReport();
  let migrated = false;
  let fresh = false;
  // 覆寫會毀掉還救得回來的資料時，這次開啟就完全不寫（可用，但唯讀）。
  let holdWrites = false;
  // 儲存讀不到時進入唯讀模式：資料只留在記憶體，一律不寫回去。
  let degraded = false;

  function persist(){
    // 兩種情況一律不寫：讀不到儲存（記憶體狀態不是使用者真正的資料），以及
    // 這次載入丟掉了東西而原樣快照沒留成（現有的 v2 是那幾筆僅存的一份）。
    if(holdWrites) return;
    try{
      backend.setItem(STORAGE_KEY, JSON.stringify(data));
    }catch{ /* 配額滿或無法寫入時保持記憶體狀態，不讓 UI 崩掉 */ }
    // 刻意不回傳 data：內部紀錄一律不外流，避免呼叫端繞過驗證改到內部狀態。
  }

  function commit(){
    ensureGeneralSkills(data);
    const today = logicalToday();
    updatePeaks(data, today);
    // 上限在 store 層強制執行，不能只靠 UI（§3.6）
    data.xpLog = compressXpLog(data.xpLog, today);
    persist();
  }

  // 讀不到儲存時的共同出口：記憶體裡給一份可用的空白狀態，但一個字都不寫。
  function enterDegraded(){
    data = emptyData();
    report = emptyReport();
    migrated = false;
    fresh = false;
    degraded = true;
    holdWrites = true;
    ensureGeneralSkills(data);
    return store.getState();
  }

  // ── XP（§4）────────────────────────────────────────────────────────────
  // 活動日只收 step 與 manual：merge 只是搬移既有 XP，rollup 的 date 是月初而
  // 不是真的有活動的那天，併進去會憑空多出一批假的活動日（§5.2）。
  function addActiveDay(date){
    if(data.meta.activeDays.includes(date)) return;
    data.meta.activeDays = [...data.meta.activeDays, date].sort();
  }

  function addXpEntry({date, skillId = null, xp, source, refId = null}){
    const entry = model.createXpEntry({date, skillId, xp, source, refId});
    data.xpLog = [...data.xpLog, entry];
    if(countsAsActivity(entry.source)) addActiveDay(entry.date);
    return entry;
  }

  function bumpSkill(skillId, delta){
    data.skills = data.skills.map(s =>
      (s.id === skillId ? {...s, xp: Math.max(0, s.xp + delta)} : s));
  }

  // 一筆發放：有歸屬就加到技能，沒有就進 unassignedXP 並留下 skillId 為 null 的
  // 紀錄（§4.3.1）。不猜一個核心塞進去，也不靜默丟掉。
  function grant({skillId, xp}, {date, source, refId = null}){
    if(skillId) bumpSkill(skillId, xp);
    else data.profile = {...data.profile,
                         unassignedXP: Math.max(0, data.profile.unassignedXP + xp)};
    return addXpEntry({date, skillId, xp, source, refId});
  }

  function grantForStep(step, date){
    for(const g of resolveGrants(step, {goals: data.goals, skills: data.skills})){
      grant(g, {date, source: model.XP_SOURCE.STEP, refId: step.id});
    }
  }

  // 每日任務的一次打卡：完成與補登共用同一條路徑，差別只在日期（§5.1）。
  function markDaily(i, day){
    const step = data.steps[i];
    // 同一天重複完成不重複加入，也不重複給 XP
    if(step.streakHistory.includes(day)) return copyStep(step);
    const next = model.createStep({
      ...step,
      streakHistory: [...step.streakHistory, day],
      completedCount: step.completedCount + 1,
      lastCompletedDate: !step.lastCompletedDate || day > step.lastCompletedDate
        ? day : step.lastCompletedDate,
      // 遷移進來的 daily 可能停在 DONE（legacy 的 done: true）。每日任務不進
      // DONE，隔天自然又是待辦。
      state: step.state === model.STEP_STATE.DONE ? model.STEP_STATE.TODO : step.state,
    });
    grantForStep(next, day);
    return replaceStep(i, next);
  }

  function findSkill(id){
    const i = data.skills.findIndex(s => s.id === id);
    if(i < 0) throw new Error(`找不到 skill：${id}`);
    return i;
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
      const primary = read(backend, STORAGE_KEY);
      if(!primary.ok) return enterDegraded();
      const decoded = decode(primary.text);
      // 有值但解不開時同樣停手：那份資料還在，只是這次讀不懂。
      if(!decoded.ok) return enterDegraded();
      const existing = decoded.value;
      if(existing){
        const out = sanitize(existing);
        data = out.data;
        report = out.report;
        migrated = false;
        fresh = false;
        // 這次載入丟掉了東西，而接下來的 commit() 會用丟過的版本覆寫唯一一份
        // v2。先把原樣留一份，確定留成了才准覆寫：配額滿或既有快照讀不到時
        // 硬寫下去，被丟掉的那幾筆就永遠沒了，UI 卻還顯示「已另存備份」。
        if(reportTotal(report) > 0){
          const damagedRead = read(backend, DAMAGED_KEY);
          let saved = damagedRead.ok && damagedRead.text === primary.text;
          if(damagedRead.ok && !damagedRead.text){
            try{
              backend.setItem(DAMAGED_KEY, primary.text);
              saved = true;
            }catch{ /* 配額滿等寫入失敗 */ }
          }
          // 既有快照是更早的另一份時同樣不動：覆蓋它等於用舊損失換新損失。
          holdWrites = !saved;
        }
      }else{
        const pwaRead = read(backend, LEGACY_PWA_KEY);
        const goalsRead = read(backend, LEGACY_GOALS_KEY);
        // 舊 key 讀不到也一樣要停手。當成「沒有舊資料」會寫出一份預設的 v2，
        // 之後每次開啟都直接讀 v2、再也不會回頭看那個其實還在的舊 key。
        if(!pwaRead.ok || !goalsRead.ok) return enterDegraded();
        const pwaDecoded = decode(pwaRead.text);
        const goalsDecoded = decode(goalsRead.text);
        // 舊資料解不開時也不要遷移：寫出一份殘缺的 v2，之後就再也不會回頭讀它。
        if(!pwaDecoded.ok || !goalsDecoded.ok) return enterDegraded();
        const pwa = pwaDecoded.value;
        const goals = goalsDecoded.value;
        const out = migrateV1({pwa, goals});
        data = out.data;
        report = out.report;
        migrated = !!(pwa || goals);
        // 「該給預設技能嗎」問的是技能資料存不存在，不是有沒有遷移。只用過
        // 目標頁的使用者有 skill-goals-v1 但沒有 skill-pwa-v1，舊版一直是拿
        // 記憶體裡的預設技能給他看；用 !migrated 判斷會讓他升級後技能全空。
        //
        // 但「使用者把技能刪光了」仍然要跟「從來沒有過技能資料」分得出來，
        // 所以看的是 skill-pwa-v1 這份資料在不在，而不是技能陣列是不是空的。
        fresh = !(pwa && typeof pwa === "object");
        // 轉換前先留一份原樣快照，已存在則不覆寫。讀不到既有快照時寧可不寫——
        // 蓋掉一份可能還在的原始備份，比少留一份新的嚴重。
        const backupRead = read(backend, BACKUP_KEY);
        if(migrated && backupRead.ok && !backupRead.text){
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
      return {...report, total: reportTotal(report), migrated, fresh, degraded,
              readOnly: degraded || holdWrites};
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

    // 完成即發放 XP（§4.2）。每日任務不進 DONE，改記 streak（§5.1）。
    completeStep(id){
      const i = findStep(id);
      const step = data.steps[i];
      const today = logicalToday();
      if(step.kind === model.STEP_KIND.DAILY) return markDaily(i, today);
      // 已經完成的不重複發放：重按一次不該再給一份 XP。
      if(step.state === model.STEP_STATE.DONE) return copyStep(step);
      const next = {...model.completeStep(step),
                    completedAt: new Date().toISOString()};
      grantForStep(next, today);
      return replaceStep(i, next);
    },

    // 補登：把過去 3 天內的日期補進 streakHistory，XP 記在被補登的那一天（§5.1）
    backfillDaily(id, date){
      const i = findStep(id);
      const step = data.steps[i];
      if(step.kind !== model.STEP_KIND.DAILY) throw new Error("只有每日任務可以補登");
      const day = model.normalizeDue(date);
      if(!day || !canBackfill(day, logicalToday())){
        throw new Error(`只能補登過去 ${BACKFILL_DAYS} 天內的日期`);
      }
      return markDaily(i, day);
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

    // ── 手動調整（§4.4）─────────────────────────────────────────────────────
    // 加分按鈕與直接輸入 XP 值都走這條路徑，變動一律留下 manual 紀錄。
    // 技能 XP 不得低於 0：扣減量超過現有 XP 時只扣到 0，並以實際變動量記錄，
    // 這樣 xpLog 的加總永遠等於目前 XP。
    adjustSkillXp(skillId, delta){
      const i = findSkill(skillId);
      if(!Number.isSafeInteger(delta)) throw new Error("XP 變動量必須是整數");
      const before = data.skills[i].xp;
      const actual = Math.max(0, before + delta) - before;
      // 什麼都沒變就不留紀錄，否則會在 activeDays 裡多出一個沒有活動的日子。
      if(actual !== 0){
        bumpSkill(skillId, actual);
        addXpEntry({date: logicalToday(), skillId, xp: actual,
                    source: model.XP_SOURCE.MANUAL});
      }
      commit();
      return copySkill(data.skills[findSkill(skillId)]);
    },

    // 直接輸入目標值：寫入的是差額，不是新值本身。
    setSkillXp(skillId, value){
      const i = findSkill(skillId);
      if(!Number.isSafeInteger(value) || value < 0){
        throw new Error("技能 XP 必須是非負整數");
      }
      return store.adjustSkillXp(skillId, value - data.skills[i].xp);
    },

    // 事後指定核心（§4.3.1）：更新那筆紀錄的 skillId，不新增一筆，
    // 否則同一次完成會被算兩次。
    assignXpEntry(entryId, coreId){
      const i = data.xpLog.findIndex(e => e.id === entryId);
      if(i < 0) throw new Error(`找不到 xpLog：${entryId}`);
      const entry = data.xpLog[i];
      if(entry.skillId) throw new Error("這筆 XP 已經歸屬過了");
      if(!data.cores.some(c => c.id === coreId)) throw new Error(`找不到 core：${coreId}`);
      const skillId = model.generalSkillId(coreId);
      findSkill(skillId);
      bumpSkill(skillId, entry.xp);
      data.profile = {...data.profile,
                      unassignedXP: Math.max(0, data.profile.unassignedXP - entry.xp)};
      data.xpLog = data.xpLog.map((e, n) => (n === i ? {...e, skillId} : e));
      commit();
      return copy(data.xpLog[i]);
    },

    // ── 合併技能（§4.5）─────────────────────────────────────────────────────
    // 來源技能的 XP 相加轉入新技能，總 XP 不變。紀錄金額必須是 0：合併只是搬移
    // 既有 XP，寫進實際金額會讓當天的成果數字整批膨脹。
    mergeSkills({sourceIds = [], coreId, name, icon = "", desc = "", source = "",
                 type = model.SKILL_TYPE.ACTIVE, notes = []} = {}){
      const ids = [...new Set(sourceIds)];
      const sources = ids.map(id => data.skills[findSkill(id)]);
      if(sources.length < 2) throw new Error("合併至少需要兩個技能");
      // 承接技能是系統產生的容器，隨核心存在，不能被合併掉。
      if(sources.some(s => s.builtin)) throw new Error("承接技能不能參與合併");
      const merged = model.createSkill({
        coreId, name, icon, desc, source, type, notes,
        xp: sources.reduce((a, s) => a + s.xp, 0),
        mergedFrom: ids,
        createdAt: new Date().toISOString(),
      });
      const gone = new Set(ids);
      data.skills = [...data.skills.filter(s => !gone.has(s.id)), merged];
      // 指向來源技能的獎勵改指新技能。留著會變成懸空參照，之後完成那個步驟時
      // XP 會被判成未歸屬（§3.2 末段），等於合併把歸屬弄丟了。
      data.steps = data.steps.map(s => {
        if(!s.rewards.some(r => gone.has(r.skillId))) return s;
        const seen = new Set();
        const rewards = [];
        for(const r of s.rewards){
          const skillId = gone.has(r.skillId) ? merged.id : r.skillId;
          // 同一個步驟同時獎勵兩個被合併的技能時，合併後會變成同一個 skillId：
          // 併成一筆，不然那個步驟會平白多發一次。
          if(seen.has(skillId)){
            const at = rewards.find(x => x.skillId === skillId);
            at.xp += r.xp;
            continue;
          }
          seen.add(skillId);
          rewards.push({skillId, xp: r.xp});
        }
        return {...s, rewards};
      });
      addXpEntry({date: logicalToday(), skillId: merged.id, xp: 0,
                  source: model.XP_SOURCE.MERGE, refId: merged.id});
      commit();
      return copySkill(merged);
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
      // 空陣列代表使用者把最後一個核心也刪了。用長度當守衛會讓那個核心
      // 在下次載入時復活，所以只要是陣列就照收。
      if(Array.isArray(state.cores)){
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
        data.cores = cores;
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
            notes: normalizeLegacyNotes(raw.notes),
            builtin: false,
            // XP 只由 XP 引擎改（§4）：既有技能一律沿用 store 裡的值，不吃 legacy
            // 快照帶回來的數字。快照是載入當下的複本，中間若有任何一次發放，
            // 拿它回寫就會把那些 XP 靜默還原，只留下 xpLog 那幾筆。
            // 新技能沒有前一版可沿用（例如全新安裝的預設技能），才用帶進來的值。
            xp: prev ? prev.xp : raw.xp,
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

    // 試算一份備份會轉出什麼，但不落地。匯入是破壞性的：現有資料被蓋掉之後
    // 才告訴使用者「有 N 筆沒進來」已經來不及了。
    inspect(raw){
      const out = convert(raw);
      return {...out.report, total: reportTotal(out.report), migrated: out.looksV1};
    },

    // v2 直接吃；認得出 v1 就走同一條遷移路徑（§7.4）
    replaceAll(raw){
      const out = convert(raw);
      data = out.data;
      report = out.report;
      migrated = out.looksV1;
      fresh = false;
      commit();
      return store.getState();
    },
  };

  return store;
}
