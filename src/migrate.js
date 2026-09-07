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
  };
}

export function reportTotal(report){
  return report.skippedCores + report.skippedSkills + report.skippedQuests
       + report.skippedGoals + report.skippedSteps;
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

export function hasMergeNote(notes){
  return Array.isArray(notes)
      && notes.some(n => n && typeof n.text === "string" && n.text.startsWith(MERGE_NOTE_PREFIX));
}

// ── cores ────────────────────────────────────────────────────────────────────
// 使用者刪掉的內建核心不補回來：那是推翻他已經做過的決定（§3.2）。
function migrateCores(raw, report){
  const source = Array.isArray(raw) && raw.length ? raw : model.BUILTIN_CORES;
  const cores = [];
  const used = new Set();
  source.forEach((c, i) => {
    try{
      const core = model.createCore({...c, order: i});
      if(used.has(core.id)) return;
      used.add(core.id);
      cores.push(core);
    }catch{ report.skippedCores += 1; }
  });
  return cores;
}

// ── skills ───────────────────────────────────────────────────────────────────
// 回傳 {skills, refMap}。refMap 是「舊 id → 該型別第一筆的新 id」，reward 一律
// 查這一份：reward 只帶舊數字 id，沒有出現序可用，而 legacy 的 find() 語意本來
// 就是「指向第一筆」（§7.2）。
function migrateSkills(raw, coreIds, report){
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
        notes: s.notes,
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
function migrateGoals(raw, report){
  const goals = [];
  const used = new Set();
  for(const g of Array.isArray(raw) ? raw : []){
    try{
      const goal = model.createGoal({...g, coreId: null});
      if(used.has(goal.id)) continue;
      used.add(goal.id);
      goals.push(goal);
    }catch{ report.skippedGoals += 1; }
  }
  return goals;
}

function migrateGoalSteps(raw, goalIds, used, report){
  const steps = [];
  for(const s of Array.isArray(raw) ? raw : []){
    if(!s || typeof s !== "object"){ report.skippedSteps += 1; continue; }
    // 指向不存在目標的 step 退回收件匣，而不是直接丟棄
    const goalId = s.goalId != null && goalIds.has(s.goalId) ? s.goalId : null;
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

  const cores = migrateCores(src.cores, report);
  const coreIds = new Set(cores.map(c => c.id));
  const {skills, refMap} = migrateSkills(src.subSkills, coreIds, report);

  const usedStepIds = new Set();
  const questSteps = migrateQuests(src.quests, refMap, usedStepIds, report);

  const goalList = migrateGoals(gsrc.goals, report);
  const goalIds = new Set(goalList.map(g => g.id));
  const goalSteps = migrateGoalSteps(gsrc.steps, goalIds, usedStepIds, report);

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
