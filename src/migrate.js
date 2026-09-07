// ── v1 → v2 遷移 ─────────────────────────────────────────────────────────────
// 規格見 docs/RPG_SPEC.md §7。純函式：不讀寫 storage，輸入兩份 legacy 原始資料，
// 輸出 v2 資料與一份回報。
//
// 遷移只跑一次，而且是不可逆的：靜默丟掉一筆資料，使用者永遠不會發現。因此這裡
// 的每一個「跳過」都要進 report，由呼叫端決定怎麼呈現。

import * as model from "./model.js";

// confirmMerge（index.html:985-992）只在合併後技能的 notes 第一則留下文字紀錄，
// 開頭固定是這個字串。這是舊資料裡唯一能辨識「曾經合併過」的訊號（§7.3）。
const MERGE_NOTE_PREFIX = "⚗ 合併自：";

const LEGACY_KIND = {main: model.STEP_KIND.MAIN,
                     side: model.STEP_KIND.SIDE,
                     daily: model.STEP_KIND.DAILY};

export function emptyReport(){
  return {
    skippedCores: 0,
    skippedSkills: 0,
    skippedQuests: 0,
    skippedGoals: 0,
    skippedSteps: 0,
    droppedRewards: 0,
    suffixedIds: 0,
    orphanSkills: 0,
    // v2 備份整段不見（例如被截斷的檔案）也是損失，只是損失的是一整區而不是幾筆
    missingSections: 0,
    // 壞掉的 XP 紀錄與成就解鎖紀錄同樣是使用者看不見的損失
    skippedXpLog: 0,
    skippedAchievements: 0,
  };
}

// 被丟掉的獎勵也是使用者看不見的損失，必須一起計入回報。整筆跳過與局部丟失
// 對使用者的意義一樣：資料進不來了。
// 孤兒技能雖然留在資料裡，但它的核心不存在，UI 沒有任何地方顯示得出來。
// 對使用者來說跟不見了沒兩樣，所以一併計入。
export function reportTotal(report){
  return report.skippedCores + report.skippedSkills + report.skippedQuests
       + report.skippedGoals + report.skippedSteps + report.droppedRewards
       + report.missingSections + report.orphanSkills
       + report.skippedXpLog + report.skippedAchievements;
}

// 前綴解決的是命名空間，不是碰撞：兩筆 quest 帶著相同數字 id 時，加了前綴仍然
// 都是 q_<n>。這裡逐筆讓開，去重只能用在真正重複的資料上（§7.2）。
function uniqueId(base, used, report){
  if(!used.has(base)){
    used.add(base);
    return base;
  }
  let n = 2;
  while(used.has(`${base}_${n}`)) n += 1;
  const id = `${base}_${n}`;
  used.add(id);
  report.suffixedIds += 1;
  return id;
}

function legacyIdPart(raw){
  // legacy id 是 Date.now() 產生的數字，但匯入的備份什麼都可能帶進來。
  return String(raw ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 48) || "x";
}

// legacy 的 note id 是 Date.now() 產生的數字，過不了 v2 的 ID_PATTERN。
// 直接把 notes 丟進 createSkill 會讓每一則都在 createNote 被擋下、被逐則的
// catch 靜默丟掉——技能留著，但使用者累積的知識筆記全部消失。
export function normalizeLegacyNotes(raw){
  const out = [];
  for(const n of Array.isArray(raw) ? raw : []){
    if(!n || typeof n !== "object") continue;
    out.push({...n, id: legacyNoteId(n.id)});
  }
  return out;
}

function legacyNoteId(raw){
  if(typeof raw === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(raw)) return raw;
  const part = legacyIdPart(raw);
  // 本來就沒有 id 的筆記交給 createNote 自己產一個
  return raw === undefined || raw === null || raw === "" ? undefined : `n_${part}`;
}

export function hasMergeNote(notes){
  return Array.isArray(notes)
      && notes.some(n => n && typeof n.text === "string" && n.text.startsWith(MERGE_NOTE_PREFIX));
}

// ── cores ────────────────────────────────────────────────────────────────────
// 使用者刪掉的內建核心不補回來：那是推翻他已經做過的決定（§3.2）。
// 回傳 {cores, refMap}。舊 id 重複時逐筆讓開而不是丟掉第二筆：那筆有自己的
// 名稱與圖示，去重會讓它連同底下技能的歸屬一起消失，而且不計入任何損失。
// refMap 與 skill / quest 同樣採 first-match，對應 legacy find() 的語意（§7.2）。
function migrateCores(raw, report){
  // 空陣列代表使用者把核心全刪了，那是他做過的決定；只有欄位根本不存在
  // （或不是陣列）才回到內建預設。
  const source = Array.isArray(raw) ? raw : model.BUILTIN_CORES;
  const cores = [];
  const refMap = new Map();
  const used = new Set();
  source.forEach((c, i) => {
    const oldKey = String(c?.id ?? "");
    // 本來就沒有 id 的核心交給 createCore 擋下來，不在這裡替它發明一個。
    const id = oldKey === "" ? "" : uniqueId(oldKey, used, report);
    try{
      const core = model.createCore({...c, ...(id ? {id} : {}), order: i});
      cores.push(core);
      if(oldKey !== "" && !refMap.has(oldKey)) refMap.set(oldKey, core.id);
    }catch{
      if(id) used.delete(id);
      report.skippedCores += 1;
    }
  });
  return {cores, refMap};
}

// ── skills ───────────────────────────────────────────────────────────────────
// 回傳 {skills, refMap}。refMap 是「舊 id → 該型別第一筆的新 id」，reward 一律
// 查這一份：reward 只帶舊數字 id，沒有出現序可用，而 legacy 的 find() 語意本來
// 就是「指向第一筆」（§7.2）。
function migrateSkills(raw, coreIds, coreRefMap, report){
  const skills = [];
  const refMap = new Map();
  const used = new Set();
  for(const s of Array.isArray(raw) ? raw : []){
    if(!s || typeof s !== "object"){ report.skippedSkills += 1; continue; }
    const oldKey = String(s.id ?? "");
    const base = `sk_${legacyIdPart(s.id)}`;
    const id = uniqueId(base, used, report);
    try{
      const skill = model.createSkill({
        ...s,
        id,
        // 核心 id 重複時後綴筆是新 id，技能仍指向第一筆（舊版 find() 的行為）
        coreId: coreRefMap.get(String(s.coreId ?? "")) ?? s.coreId,
        notes: normalizeLegacyNotes(s.notes),
        mergedFrom: hasMergeNote(s.notes) ? [] : null,
        builtin: false,
        createdAt: null,
      });
      if(!coreIds.has(skill.coreId)) report.orphanSkills += 1;
      skills.push(skill);
      if(oldKey !== "" && !refMap.has(oldKey)) refMap.set(oldKey, skill.id);
    }catch{
      used.delete(id);
      report.skippedSkills += 1;
    }
  }
  return {skills, refMap};
}

function remapRewards(quest, refMap, report){
  const raw = Array.isArray(quest.rewards) && quest.rewards.length
    ? quest.rewards
    : (quest.rewardSkillId != null
        ? [{skillId: quest.rewardSkillId, xp: quest.rewardXP}]
        : []);
  const out = [];
  for(const r of raw){
    if(!r || typeof r !== "object"){ report.droppedRewards += 1; continue; }
    const mapped = refMap.get(String(r.skillId ?? ""));
    // 查不到對應技能就丟掉這筆獎勵，不是丟掉整個步驟。
    if(!mapped){ report.droppedRewards += 1; continue; }
    const xp = Number.isSafeInteger(r.xp) && r.xp > 0 ? r.xp : 50;
    out.push({skillId: mapped, xp});
  }
  return out;
}

// ── quests → steps ───────────────────────────────────────────────────────────
function migrateQuests(raw, refMap, used, report){
  const list = (Array.isArray(raw) ? raw : [])
    .map((q, i) => ({q, i}))
    .filter(({q}) => {
      if(q && typeof q === "object") return true;
      report.skippedQuests += 1;
      return false;
    })
    .sort((a, b) => {
      const ka = String(a.q.createdAt ?? "");
      const kb = String(b.q.createdAt ?? "");
      if(ka !== kb) return ka < kb ? -1 : 1;
      return a.i - b.i;
    });

  const steps = [];
  list.forEach(({q}, order) => {
    const id = uniqueId(`q_${legacyIdPart(q.id)}`, used, report);
    try{
      steps.push(model.createStep({
        id,
        // legacy quest 沒有目標概念，所以連 main 的 goalId 都是 null（§3.5）
        goalId: null,
        kind: LEGACY_KIND[q.type] || model.STEP_KIND.SIDE,
        title: q.title,
        desc: q.desc,
        due: q.dueDate || null,
        dueTime: q.dueTime || null,
        order,
        state: q.done === true ? model.STEP_STATE.DONE : model.STEP_STATE.TODO,
        rewards: remapRewards(q, refMap, report),
        streakHistory: q.streakHistory,
        completedCount: q.completedCount,
        lastCompletedDate: q.lastCompletedDate || null,
        // saveQuest 只在封存時才寫這兩個欄位，缺漏一律補中性值，
        // 否則絕大多數從未封存的 quest 會在嚴格驗證下整批被跳過（§7.3）。
        archived: q.archived === true,
        archivedAt: q.archived === true ? (q.archivedAt || null) : null,
        createdAt: q.createdAt || null,
        completedAt: q.completedAt || null,
      }));
    }catch{
      used.delete(id);
      report.skippedQuests += 1;
    }
  });
  return steps;
}

// ── Goal / Step 層 ───────────────────────────────────────────────────────────
// 回傳 {goals, refMap}。goal id 撞在一起時比照 skill / quest / step 逐筆讓開，
// 不能靜默丟掉第二筆——它有自己的標題與狀態。step 的 goalId 只帶舊 id，
// 因此另外維護「舊 id → 第一筆的新 id」的引用表，與 reward 的規則一致。
function migrateGoals(raw, report){
  const goals = [];
  const refMap = new Map();
  const used = new Set();
  for(const g of Array.isArray(raw) ? raw : []){
    if(!g || typeof g !== "object"){ report.skippedGoals += 1; continue; }
    const oldKey = String(g.id ?? "");
    const id = uniqueId(`${legacyIdPart(g.id) || "g"}`, used, report);
    try{
      goals.push(model.createGoal({...g, id, coreId: null}));
      if(oldKey !== "" && !refMap.has(oldKey)) refMap.set(oldKey, id);
    }catch{
      used.delete(id);
      report.skippedGoals += 1;
    }
  }
  return {goals, refMap};
}

function migrateGoalSteps(raw, goalRefMap, used, report){
  const steps = [];
  for(const s of Array.isArray(raw) ? raw : []){
    if(!s || typeof s !== "object"){ report.skippedSteps += 1; continue; }
    // 指向不存在目標的 step 退回收件匣，而不是直接丟棄。
    // 舊 goalId 一律查引用表，id 讓開之後才不會指到別人的目標。
    const goalId = s.goalId != null ? (goalRefMap.get(String(s.goalId)) ?? null) : null;
    const id = uniqueId(`${legacyIdPart(s.id) || "s"}`, used, report);
    try{
      steps.push(model.createStep({
        ...s,
        id,
        goalId,
        kind: goalId === null ? model.STEP_KIND.INBOX : model.STEP_KIND.MAIN,
        rewards: [],
        archived: false,
        archivedAt: null,
        createdAt: null,
        completedAt: null,
      }));
    }catch{
      used.delete(id);
      report.skippedSteps += 1;
    }
  }
  return steps;
}

// ── 入口 ─────────────────────────────────────────────────────────────────────
export function migrateV1({pwa = null, goals = null, now = new Date()} = {}){
  const report = emptyReport();
  const src = pwa && typeof pwa === "object" ? pwa : {};
  const gsrc = goals && typeof goals === "object" ? goals : {};

  const {cores, refMap: coreRefMap} = migrateCores(src.cores, report);
  const coreIds = new Set(cores.map(c => c.id));
  const {skills, refMap} = migrateSkills(src.subSkills, coreIds, coreRefMap, report);

  const usedStepIds = new Set();
  const questSteps = migrateQuests(src.quests, refMap, usedStepIds, report);

  const {goals: goalList, refMap: goalRefMap} = migrateGoals(gsrc.goals, report);
  const goalSteps = migrateGoalSteps(gsrc.steps, goalRefMap, usedStepIds, report);

  const steps = [...questSteps, ...goalSteps];

  // activeDays 要回填而不是清空：daily 的 streakHistory 是真實發生過的活動日期，
  // 清成空陣列會讓連續打卡中的使用者遷移後立刻歸零（§7.3）。
  const activeDays = new Set();
  for(const s of steps){
    if(s.kind === model.STEP_KIND.DAILY) for(const d of s.streakHistory) activeDays.add(d);
  }

  const data = {
    version: 2,
    profile: model.createProfile({
      charName: typeof src.charName === "string" ? src.charName : undefined,
      createdAt: now.toISOString(),
      unassignedXP: 0,
    }),
    cores,
    skills,
    goals: goalList,
    steps,
    // 遷移不追溯造紀錄：歷史逐筆資料已經不存在，硬造出來就是假資料（§7.2）。
    xpLog: [],
    achievements: [],
    meta: model.createMeta({activeDays: [...activeDays]}),
  };

  return {data, report};
}
