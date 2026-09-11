// ── 儲存層（schema v2）───────────────────────────────────────────────────────
// 所有讀寫都收斂在這個模組。UI 只透過 store 存取資料，因此之後把 backend 換成
// IndexedDB 時不需要動到任何檢視程式碼。規格見 docs/RPG_SPEC.md §3、§7。

import * as model from "./model.js";
import {migrateV1, emptyReport, reportTotal, hasMergeNote, normalizeLegacyNotes,
        countSkillDrops, countStepDrops} from "./migrate.js";
// XP 的規則與「今天」都住在 rpg.js：store 只負責套用結果並落地（§4、§5.0）。
import {logicalToday, resolveGrants, compressXpLog, canBackfill,
        countsAsActivity, hasAttribution, requiresAttribution,
        BACKFILL_DAYS} from "./rpg.js";
import {evaluateAchievements} from "./achievements.js";
import {dailySummary, hasDailyContent, weeklySummary} from "./review.js";

// key 名稱保留不動，才讀得到既有資料。判斷 schema 的是 version 欄位，不是 key。
export const STORAGE_KEY = "skill-rpg-v2";
export const SCHEMA_VERSION = model.DATA_VERSION;
export const PLANNER_VERSION = model.PLANNER_VERSION;

// 舊 key 保留不動，作為最後的回退路徑（§7.1）
export const LEGACY_PWA_KEY = "skill-pwa-v1";
export const LEGACY_GOALS_KEY = "skill-goals-v1";
export const BACKUP_KEY = "skill-backup-v1";
// 既有 v2 解得開但含壞資料時的原樣快照。sanitize 丟掉的那幾筆也許還救得回來，
// 覆寫之後就真的沒了。
export const DAMAGED_KEY = "skill-damaged-v2";
// v2 → v3 升級前的原樣快照。升級是不可逆的，留不成就不准寫升級結果。
export const UPGRADE_BACKUP_KEY = "skill-backup-v2";

// 寫入失敗的統一型別。呼叫端只要顯示 message 就是誠實的說法，不必各自翻譯
// reason；型別本身讓 UI 分得出「沒寫進去」與「這件事本來就不該做」。
export const WRITE_FAIL_TEXT = {
  conflict: "另一個分頁已經存了新的資料。這次的變更沒有保存，也沒有覆蓋對方的資料；請重新載入頁面後再試一次。",
  degraded: "讀不到瀏覽器儲存空間，這次的變更沒有保存。",
  unsupported: "這份存檔是較新版本寫的，這次的變更沒有保存，也不會覆蓋原本的資料。",
  readonly: "目前是唯讀模式，這次的變更沒有保存。請先處理載入時回報的資料問題。",
  write: "沒有保存：瀏覽器儲存空間可能已滿。請清出空間後再試一次。",
  serialize: "沒有保存，請再試一次。",
  read: "沒有保存，請再試一次。",
};

export class WriteError extends Error {
  constructor(reason){
    super(WRITE_FAIL_TEXT[reason] || "沒有保存，請再試一次。");
    this.name = "WriteError";
    this.reason = reason;
  }
}

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
    planner: model.createPlanner({}),
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
// planner 是三層巢狀（days / stepDetails / entries），淺拷貝一樣會讓呼叫端
// 改到內部紀錄，繞過驗證。
function copyPlanner(p){
  const days = {};
  for(const [date, day] of Object.entries(p.days)){
    days[date] = {...day, focus: day.focus ? {...day.focus} : null};
  }
  const stepDetails = {};
  for(const [id, detail] of Object.entries(p.stepDetails)) stepDetails[id] = {...detail};
  return {
    version: p.version,
    config: {...p.config, goalBindings: {...p.config.goalBindings}},
    days,
    stepDetails,
    entries: p.entries.map(e => ({...e})),
  };
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

// `typeof [] === "object"`：只看 typeof 的話，一個 `config: []` 會被當成正常的
// 設定區段，匯入時安靜地把 anchor 與目標綁定換成預設值。
function isPlainObject(v){
  return !!v && typeof v === "object" && !Array.isArray(v);
}

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

  // 根 version 決定缺 planner 算不算損失：v2 沒有 planner 是正常的，v3 沒有
  // 代表這份資料被截斷了。
  const storedVersion = Number.isSafeInteger(raw.version) ? raw.version : 2;
  // 根 version 缺漏或壞掉時不能就當成 v2：那會把 planner 的完整性檢查整組關掉，
  // 一份沒有 version 但帶著 planner 的備份就能靜默清掉班表與成果。帶著 planner
  // 這件事本身就說明它是 v3 形狀的資料。
  const isV3 = storedVersion >= SCHEMA_VERSION || raw.planner !== undefined;
  if(isV3 && !isPlainObject(raw.planner)) report.missingSections += 1;
  data.planner = sanitizePlanner(raw.planner, report, {strict: isV3});

  return {data, report};
}

// planner 缺席是 v2 的常態，不是損失：升級時補一份空的就好。裡面的單筆壞資料
// 才進 report——跟 steps 一樣，壞的是那一筆，不是整個區段。
//
// 指向已不存在的 goal / step 的紀錄一律保留：成果是使用者寫下的事實，
// 目標被刪掉不代表那件事沒發生。畫面自己決定顯不顯示得出來。
function sanitizePlanner(raw, report, {strict = false} = {}){
  const src = raw && typeof raw === "object" ? raw : {};
  const planner = model.createPlanner({version: src.version});
  // config 壞掉只退回未設定：為了一個壞掉的 anchor 丟掉整份成果不成比例。
  // 但那是一整段設定不見了，v3 的資料要計入損失，不能靜默歸零。缺席與壞掉
  // 一樣要算：`src.config || {}` 會讓缺席的那份安靜地變成一份有效的空設定。
  let configLost = strict && !isPlainObject(src.config);
  try{ planner.config = model.createPlannerConfig(src.config || {}); }
  catch{
    planner.config = model.createPlannerConfig({});
    configLost = strict;
  }
  if(configLost) report.missingSections += 1;

  // v3 的 planner 少了一整段（被截斷的備份）跟 steps 整段不見是同一件事：
  // 補一個空容器就回報成功，會讓匯入靜默清掉整份班表與成果。
  if(strict){
    if(!isPlainObject(src.days)) report.missingSections += 1;
    if(!isPlainObject(src.stepDetails)) report.missingSections += 1;
    if(!Array.isArray(src.entries)) report.missingSections += 1;
  }

  const days = isPlainObject(src.days) ? src.days : {};
  for(const [date, value] of Object.entries(days)){
    try{
      const key = model.normalizeDue(date);
      if(!key) throw new Error("日期不得為空");
      planner.days[key] = model.createPlannerDay(value || {});
    }catch{ report.skippedPlannerDays += 1; }
  }

  const details = isPlainObject(src.stepDetails) ? src.stepDetails : {};
  for(const [id, value] of Object.entries(details)){
    try{ planner.stepDetails[id] = model.createStepDetail(value || {}); }
    catch{ report.skippedStepDetails += 1; }
  }

  const seen = new Set();
  for(const e of Array.isArray(src.entries) ? src.entries : []){
    try{
      const entry = model.createPlannerEntry(e);
      // 同一次提交只留一筆：重試共用 requestId，重播不該變成兩筆成果。
      if(seen.has(entry.requestId)) continue;
      seen.add(entry.requestId);
      planner.entries.push(entry);
    }catch{ report.skippedPlannerEntries += 1; }
  }

  return planner;
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
// index.html 的內嵌 script 仍以 {charName, cores, subSkills} 的形狀管理角色與
// 技能。任務已經統一走 steps，不再有 quest 投影（§8）。

function coerceId(raw, prefix){
  if(typeof raw === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(raw)) return raw;
  const part = String(raw ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 48);
  return part ? `${prefix}_${part}` : "";
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
// 這份資料的版本這個 App 讀不讀得懂。load()、inspect() 與 replaceAll() 共用，
// 否則「開啟時擋下、匯入時照吃」會讓同一份未來版本的備份從匯入這條路被降級
// 成 v3 並抹掉不認得的欄位。
function isUnsupportedVersion(raw){
  if(!raw || typeof raw !== "object") return false;
  const version = Number.isSafeInteger(raw.version) ? raw.version : null;
  if(version !== null && version > SCHEMA_VERSION) return true;
  const planner = raw.planner;
  if(planner && typeof planner === "object"
     && Number.isSafeInteger(planner.version) && planner.version > model.PLANNER_VERSION){
    return true;
  }
  return false;
}

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

export function createStore(backend = defaultBackend()){
  let data = emptyData();
  let report = emptyReport();
  let migrated = false;
  let fresh = false;
  // 覆寫會毀掉還救得回來的資料時，這次開啟就完全不寫（可用，但唯讀）。
  let holdWrites = false;
  // 這次 session 新解鎖、還沒被 UI 取走的成就 id
  const freshUnlocks = [];
  // 儲存讀不到時進入唯讀模式：資料只留在記憶體，一律不寫回去。
  let degraded = false;
  // 存檔版本比這個 App 認得的還新：能顯示就顯示，但絕不覆寫。
  let unsupported = false;
  // 這次 session 最後一次讀到 / 寫出的序列化內容。別的分頁寫過之後會對不上，
  // 用來擋住「拿舊快照蓋掉新資料」（§6.2）。
  let lastSerialized = null;
  // 這次載入把 v2 升成了 v3。呼叫端要讓使用者看得到。
  let upgraded = false;
  // 偵測到別的分頁寫過新資料。一旦成立就整個 session 唯讀：這份記憶體狀態
  // 是從舊快照長出來的，任何一條路徑寫下去都會吃掉對方的資料。
  let staleTab = false;

  // 寫入結果必須回得去：成果與 XP 的流程要分得出「已保存」與「沒寫進去」，
  // 不能吞掉例外之後還顯示成功（§6.2）。
  function blockedReason(){
    if(staleTab) return "conflict";
    if(!holdWrites) return null;
    return degraded ? "degraded" : unsupported ? "unsupported" : "readonly";
  }

  function persist(){
    // 四種情況一律不寫：讀不到儲存（記憶體狀態不是使用者真正的資料）、這次載入
    // 丟掉了東西而原樣快照沒留成（現有的存檔是那幾筆僅存的一份）、版本比這個
    // App 新，以及別的分頁已經寫過新資料。
    const blocked = blockedReason();
    if(blocked) return {ok: false, reason: blocked};
    let text;
    try{ text = JSON.stringify(data); }
    catch{ return {ok: false, reason: "serialize"}; }
    // 比對擺在每一條寫入路徑上，不是只有今日計畫：目標、步驟、XP、legacy 快照
    // 同樣是「整份覆寫」，任何一條用舊快照寫下去都會吃掉別的分頁剛存的東西。
    const cur = read(backend, STORAGE_KEY);
    if(!cur.ok) return {ok: false, reason: "read"};
    if(lastSerialized !== null && cur.text !== null && cur.text !== lastSerialized){
      staleTab = true;
      return {ok: false, reason: "conflict"};
    }
    try{ backend.setItem(STORAGE_KEY, text); }
    catch{ return {ok: false, reason: "write"}; }
    lastSerialized = text;
    return {ok: true};
    // 刻意不回傳 data：內部紀錄一律不外流，避免呼叫端繞過驗證改到內部狀態。
  }

  function commit(){
    ensureGeneralSkills(data);
    const today = logicalToday();
    updatePeaks(data, today);
    unlockAchievements(today);
    // 上限在 store 層強制執行，不能只靠 UI（§3.6）
    data.xpLog = compressXpLog(data.xpLog, today);
    return persist();
  }

  // 候選狀態：先在複本上套完所有變更，序列化與寫入都成功才採用（§6.2）。
  // 失敗時 data 原封不動——不能先 completeStep() 寫一次、再寫成果第二次，
  // 那會在中途失敗時留下「任務完成了但沒有成果」的半筆結算。
  function transact(apply){
    const blocked = blockedReason();
    if(blocked) return {ok: false, reason: blocked};
    const backup = data;
    const unlockBackup = freshUnlocks.slice();
    const restore = () => {
      data = backup;
      freshUnlocks.length = 0;
      freshUnlocks.push(...unlockBackup);
    };
    let working;
    try{ working = JSON.parse(JSON.stringify(data)); }
    catch{ return {ok: false, reason: "serialize"}; }
    data = working;
    let value;
    try{ value = apply(); }
    catch(err){ restore(); throw err; }
    const written = commit();
    if(!written.ok){
      restore();
      return {ok: false, reason: written.reason};
    }
    return {ok: true, value};
  }

  // 會改到資料的公開方法都走這裡。transact() 已經保證「寫得進去才採用」，
  // mutate() 再把失敗轉成 WriteError 丟出去——回傳正常值卻沒寫進去，等於讓
  // 畫面顯示一個重開就會消失的成功。
  function mutate(apply){
    const out = transact(apply);
    if(!out.ok) throw new WriteError(out.reason);
    return out.value;
  }

  // 成就只加不減（§6.2）：判定是純函式，這裡只負責把新達成的那幾筆補上時間。
  // 資料之後怎麼變都不會把已解鎖的收回去——收回等於否認使用者做過的事。
  function unlockAchievements(today){
    const has = new Set(data.achievements.map(a => a.id));
    const at = new Date().toISOString();
    for(const id of evaluateAchievements(data, today)){
      if(has.has(id)) continue;
      data.achievements = [...data.achievements, model.createAchievement({id, unlockedAt: at})];
      // UI 用這條佇列跳 toast。放在 store 是因為解鎖可能發生在任何一條寫入
      // 路徑上，檢視端沒辦法自己知道剛剛多了什麼。
      freshUnlocks.push(id);
    }
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

  // 存檔版本高於支援版本（或 planner 是未知的內部版本）：盡量解讀出來給人看，
  // 但一個字都不寫。reset 成空白等於拿舊版把新版資料清掉（§6.2）。
  function enterUnsupported(raw){
    const out = sanitize(raw);
    data = out.data;
    report = out.report;
    migrated = false;
    fresh = false;
    unsupported = true;
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

  // 歸屬是 main / side / daily 儲存前的必要條件（§4.3）。擋在這裡而不是只擋在
  // UI，是因為之後每一條寫入路徑都會經過 store。
  function requireAttribution(step){
    if(!requiresAttribution(step)) return;
    if(hasAttribution(step, data.goals)) return;
    throw new Error("要先指定 XP 歸屬：選一個技能獎勵，或讓所屬目標綁定核心");
  }

  // 指定核心時，XP 記到該核心的承接技能（§4.3）。核心不存在就不要編一個出來。
  function rewardForCore(coreId, step){
    if(!data.cores.some(c => c.id === coreId)) throw new Error(`找不到 core：${coreId}`);
    const skillId = model.generalSkillId(coreId);
    findSkill(skillId);
    const xp = Number.isSafeInteger(step.xp) && step.xp >= 0
      ? step.xp : model.KIND_DEFAULT_XP[step.kind];
    return {skillId, xp};
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
      // 打卡完就是下一次的開始：狀態回到待辦、順延計數歸零（§5.1）。遷移進來
      // 停在 DONE 的、或從順延中的任務改過來的，都在這裡收斂——留著舊狀態會讓
      // 它打不了卡，留著舊的 deferCount 會讓它一直被回顧當成「反覆順延」。
      state: model.STEP_STATE.TODO,
      deferCount: 0,
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

  // 只改狀態的那幾個轉換共用同一條路徑，省得每個都重寫一次查找。
  function applyToStep(id, fn, ...args){
    const i = findStep(id);
    return replaceStep(i, fn(data.steps[i], ...args));
  }

  // 只換掉那一筆，不落地：落地由外層的 mutate() 統一處理，否則同一次操作會
  // 寫兩次，而且中途失敗時前半段已經寫進去了。
  function replaceStep(i, step){
    data.steps = data.steps.map((s, n) => (n === i ? step : s));
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
        // 這份文字就是目前存檔的原樣。記下來才分得出「我寫的」與「別的分頁寫的」。
        lastSerialized = primary.text;
        const storedVersion = Number.isSafeInteger(existing.version) ? existing.version : 2;
        const plannerVersion = existing.planner && Number.isSafeInteger(existing.planner.version)
          ? existing.planner.version : model.PLANNER_VERSION;
        // 高於支援版本或未知的 planner 版本：保留原始資料，禁止覆蓋。
        if(storedVersion > SCHEMA_VERSION || plannerVersion > model.PLANNER_VERSION){
          return enterUnsupported(existing);
        }
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
        // v2 → v3：只補一份空的 planner 與版本標記，其餘欄位原封不動（§6.2）。
        // 升級是不可逆的，所以先把升級前的原樣留一份；留不成就不准寫升級結果。
        // 已經是 v3 就不再跑一次。
        if(storedVersion < SCHEMA_VERSION){
          const upgradeRead = read(backend, UPGRADE_BACKUP_KEY);
          // 既有快照是更早的一份升級前備份，本身就是有效的還原點，不覆寫。
          let saved = upgradeRead.ok && !!upgradeRead.text;
          if(upgradeRead.ok && !upgradeRead.text){
            try{
              backend.setItem(UPGRADE_BACKUP_KEY, primary.text);
              saved = true;
            }catch{ /* 配額滿等寫入失敗 */ }
          }
          if(saved) upgraded = true;
          else holdWrites = true;
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
              unsupported, upgraded, conflict: staleTab,
              readOnly: degraded || holdWrites || staleTab};
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
        planner: copyPlanner(data.planner),
      };
    },

    save(){
      mutate(() => {});
      return store.getState();
    },

    // ── 節奏與回顧（§5.3–5.4）───────────────────────────────────────────────
    // 今天還沒看過結算，而且昨天真的有東西可報時，回傳昨天的摘要；否則 null。
    // 「看過了」只認 meta.lastDailySummaryDate，所以同一天重開 App 只會出現一次。
    pendingDailySummary(){
      const today = logicalToday();
      if(data.meta.lastDailySummaryDate === today) return null;
      const summary = dailySummary(store.getState(), model.shiftDate(today, -1));
      return hasDailyContent(summary) ? summary : null;
    },

    // 沒有東西可報的那幾天也要記下來，不然每次開 App 都要重算一次昨天。
    markDailySummarySeen(){
      return mutate(() => {
        data.meta = {...data.meta, lastDailySummaryDate: logicalToday()};
        return data.meta.lastDailySummaryDate;
      });
    },

    weeklyReview(){return weeklySummary(store.getState(), logicalToday());},

    markWeeklyReviewSeen(){
      return mutate(() => {
        data.meta = {...data.meta, lastWeeklyReviewDate: logicalToday()};
        return data.meta.lastWeeklyReviewDate;
      });
    },

    // ── 成就（§6.2）─────────────────────────────────────────────────────────
    achievements(){return copyAll(data.achievements);},

    // 取走這次新解鎖的成就 id 並清空。取過就不會再取到第二次，避免同一則
    // toast 在每次重繪時重播。
    drainUnlocks(){
      const out = freshUnlocks.slice();
      freshUnlocks.length = 0;
      return out;
    },

    // ── Goal ────────────────────────────────────────────────────────────────
    addGoal({title, why = "", coreId = null} = {}){
      return mutate(() => {
        const goal = model.createGoal({title, why, coreId});
        data.goals = [...data.goals, goal];
        return copy(goal);
      });
    },

    updateGoal(id, patch = {}){
      return mutate(() => {
        const i = findGoal(id);
        const goal = model.createGoal({...data.goals[i], ...patch, id});
        data.goals = data.goals.map((g, n) => (n === i ? goal : g));
        return copy(goal);
      });
    },

    setGoalStatus(id, status){return store.updateGoal(id, {status});},

    // ── Step ────────────────────────────────────────────────────────────────
    addStep({goalId = null, kind, title, due = null, dueTime = null, desc = "",
             xp, rewards} = {}){
      return mutate(() => {
        if(goalId !== null) findGoal(goalId);
        const k = kind || (goalId === null ? model.STEP_KIND.INBOX : model.STEP_KIND.MAIN);
        const step = model.createStep({
          goalId, kind: k, title, due, dueTime, desc, xp, rewards,
          createdAt: new Date().toISOString(),
          order: model.nextOrder(data.steps, k === model.STEP_KIND.INBOX ? null : goalId),
        });
        requireAttribution(step);
        data.steps = [...data.steps, step];
        return copyStep(step);
      });
    },

    // 編輯。歸屬是儲存前的必要條件，改壞了同樣擋下來（§4.3）。
    updateStep(id, patch = {}){
      return mutate(() => {
      const i = findStep(id);
      const prev = data.steps[i];
      if(patch.goalId !== undefined && patch.goalId !== null) findGoal(patch.goalId);
      const step = model.createStep({...prev, ...patch, id});
      requireAttribution(step);
      // 每日任務只有「今天做了沒」，沒有完成、順延或已排程可言（§5.1）。改成
      // daily 時一律拉回待辦、順延計數歸零：留著 DONE 會變成一個打不了卡、只能
      // 封存的每日任務，留著 `>` 與舊的 deferCount 則會讓它永遠掛在回顧的
      // 「反覆順延」清單上。
      if(step.kind === model.STEP_KIND.DAILY){
        step.state = model.STEP_STATE.TODO;
        step.deferCount = 0;
      }
      return replaceStep(i, step);
      });
    },

    deleteStep(id){
      return mutate(() => {
        const i = findStep(id);
        const gone = data.steps[i];
        data.steps = data.steps.filter((s, n) => n !== i);
        return copyStep(gone);
      });
    },

    // 封存與 state 正交：只決定顯不顯示在清單裡，不改變完成或放棄（§3.5）。
    archiveStep(id, on = true){
      return mutate(() => {
        const i = findStep(id);
        return replaceStep(i, {...data.steps[i], archived: on === true,
                               archivedAt: on === true ? new Date().toISOString() : null});
      });
    },

    // 批次封存 / 清除。daily 不進 DONE（§5.1），連遷移進來還停在 DONE 的也一併
    // 排除——把它封存掉等於把一個還在跑的習慣藏起來。
    archiveDoneSteps(){
      return mutate(() => {
        const at = new Date().toISOString();
        let count = 0;
        data.steps = data.steps.map(s => {
          if(s.state !== model.STEP_STATE.DONE || s.archived) return s;
          if(s.kind === model.STEP_KIND.DAILY) return s;
          count += 1;
          return {...s, archived: true, archivedAt: at};
        });
        return count;
      });
    },

    deleteSteps(pred){
      return mutate(() => {
        const before = data.steps.length;
        data.steps = data.steps.filter(s => !pred(copyStep(s)));
        return before - data.steps.length;
      });
    },

    // 完成即發放 XP（§4.2）。每日任務不進 DONE，改記 streak（§5.1）。
    // 收件匣是唯一沒有事先歸屬的 kind，完成時才要求指定核心（§4.3），
    // 沒指定就不完成——這個摩擦只發生在真的要記分的那一刻。
    completeStep(id, {coreId = null} = {}){
      return mutate(() => {
      const i = findStep(id);
      let step = data.steps[i];
      if(step.kind === model.STEP_KIND.INBOX
         && !hasAttribution(step, data.goals)){
        if(!coreId) throw new Error("完成前要先指定這筆 XP 歸到哪個核心");
        step = {...step, rewards: [rewardForCore(coreId, step)]};
        data.steps = data.steps.map((s, n) => (n === i ? step : s));
      }
      const today = logicalToday();
      if(step.kind === model.STEP_KIND.DAILY) return markDaily(i, today);
      // 已經完成的不重複發放：重按一次不該再給一份 XP。
      if(step.state === model.STEP_STATE.DONE) return copyStep(step);
      const next = {...model.completeStep(step),
                    completedAt: new Date().toISOString()};
      grantForStep(next, today);
      return replaceStep(i, next);
      });
    },

    // 補登：把過去 3 天內的日期補進 streakHistory，XP 記在被補登的那一天（§5.1）
    backfillDaily(id, date){
      return mutate(() => {
      const i = findStep(id);
      const step = data.steps[i];
      if(step.kind !== model.STEP_KIND.DAILY) throw new Error("只有每日任務可以補登");
      const day = model.normalizeDue(date);
      if(!day || !canBackfill(day, logicalToday())){
        throw new Error(`只能補登過去 ${BACKFILL_DAYS} 天內的日期`);
      }
      return markDaily(i, day);
      });
    },

    deferStep(id){return mutate(() => applyToStep(id, model.deferStep));},

    reopenStep(id){return mutate(() => applyToStep(id, model.reopenStep));},

    noteStep(id){return mutate(() => applyToStep(id, model.noteStep));},

    dropStep(id){return mutate(() => applyToStep(id, model.dropStep));},

    scheduleStep(id, due){return mutate(() => applyToStep(id, model.scheduleStep, due));},

    // 收件匣項目歸入目標時轉成主線並排到最後，不插隊搶走現有的下一步。
    // 指派之後就不再是收件匣，因此歸屬必須當場成立：沿用該目標的 coreId，
    // 目標沒綁核心也沒有 rewards 時擋下來（§4.3）。
    assignStep(id, goalId){
      return mutate(() => {
        const i = findStep(id);
        if(goalId !== null) findGoal(goalId);
        const kind = goalId === null ? model.STEP_KIND.INBOX : model.STEP_KIND.MAIN;
        const step = model.createStep({
          ...data.steps[i],
          goalId,
          kind,
          order: model.nextOrder(data.steps.filter(s => s.id !== id), goalId),
        });
        requireAttribution(step);
        return replaceStep(i, step);
      });
    },

    // ── 手動調整（§4.4）─────────────────────────────────────────────────────
    // 加分按鈕與直接輸入 XP 值都走這條路徑，變動一律留下 manual 紀錄。
    // 技能 XP 不得低於 0：扣減量超過現有 XP 時只扣到 0，並以實際變動量記錄，
    // 這樣 xpLog 的加總永遠等於目前 XP。
    adjustSkillXp(skillId, delta){
      return mutate(() => {
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
        return copySkill(data.skills[findSkill(skillId)]);
      });
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
      return mutate(() => {
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
      return copy(data.xpLog[i]);
      });
    },

    // ── 合併技能（§4.5）─────────────────────────────────────────────────────
    // 來源技能的 XP 相加轉入新技能，總 XP 不變。紀錄金額必須是 0：合併只是搬移
    // 既有 XP，寫進實際金額會讓當天的成果數字整批膨脹。
    mergeSkills({sourceIds = [], coreId, name, icon = "", desc = "", source = "",
                 type = model.SKILL_TYPE.ACTIVE, notes = []} = {}){
      return mutate(() => {
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
      return copySkill(merged);
      });
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
      };
    },

    // 反向投影。只覆寫 legacy 認得的那部分，Goal/Step 層的資料原封不動。
    saveLegacyState(state = {}){
      return mutate(() => {
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

      // 指向已移除技能的 reward 一併清掉，不留懸空參照（§3.2）。刪除核心只是
      // 其中一種來源：單獨刪掉一個子技能同樣會讓 reward 指向不存在的技能，
      // 那個步驟完成時 XP 會靜默走未歸屬路徑，所以不能只在 coreRemoved 時清。
      data.steps = data.steps.map(s => {
        const rewards = s.rewards.filter(r => liveSkillIds.has(r.skillId));
        return rewards.length === s.rewards.length ? s : {...s, rewards};
      });
      if(coreRemoved){
        data.goals = data.goals.map(g =>
          (g.coreId && !coreIds.has(g.coreId)) ? {...g, coreId: null} : g);
      }

      return store.getState();
      });
    },

    // ── 今日計畫（planner, v3）──────────────────────────────────────────────
    // 寫入一律走 transact()：候選狀態成功寫進去才採用，失敗時 data 原封不動，
    // 呼叫端拿到 ok:false 就不能顯示「已保存」（§6.2）。
    plannerState(){return copyPlanner(data.planner);},

    // 班表 anchor 與目標綁定。已經有每日紀錄時改 anchor 會讓過去的原定班別整批
    // 位移，所以只回報影響、保留原設定，要改必須明確帶 force（§3.2）。
    setPlannerConfig(patch = {}){
      const prev = data.planner.config;
      let next;
      try{
        next = model.createPlannerConfig({
          anchorDate: patch.anchorDate !== undefined ? patch.anchorDate : prev.anchorDate,
          anchorPhase: patch.anchorPhase !== undefined ? patch.anchorPhase : prev.anchorPhase,
          goalBindings: {...prev.goalBindings, ...(patch.goalBindings || {})},
          theme: patch.theme !== undefined ? patch.theme : prev.theme,
        });
      }catch(err){ return {ok: false, reason: "invalid", message: err.message}; }
      const anchorMoved = next.anchorDate !== prev.anchorDate
        || next.anchorPhase !== prev.anchorPhase;
      const dayCount = Object.keys(data.planner.days).length;
      if(anchorMoved && dayCount > 0 && patch.force !== true){
        return {ok: false, reason: "has-days", days: dayCount};
      }
      const out = transact(() => {data.planner.config = next;});
      if(!out.ok) return out;
      return {ok: true, config: {...next, goalBindings: {...next.goalBindings}}};
    },

    // 單日的安排、實際出勤、精力、時間與模式。
    setDayPlan(date, patch = {}){
      let key, day, prev;
      try{
        key = model.normalizeDue(date);
        if(!key) throw new Error("要先指定日期");
        // 未來只能規劃：確認實際出勤等於替還沒發生的事做紀錄（§3.1）。
        if(patch.attendanceActual !== undefined && patch.attendanceActual !== null
           && key > logicalToday()){
          throw new Error("未來的日子只能規劃，不能確認實際出勤");
        }
        prev = data.planner.days[key] || model.createPlannerDay({});
        day = model.createPlannerDay({...prev, ...patch,
                                      updatedAt: new Date().toISOString()});
      }catch(err){ return {ok: false, reason: "invalid", message: err.message}; }
      const out = transact(() => {data.planner.days[key] = day;});
      if(!out.ok) return out;
      // 這次「想要的」本次時間：patch 沒帶就是原本已選的值。只調低可用時間
      // 一樣會把它夾到上限，那時候也要讓使用者看得到，不能默默改掉（§4）。
      const requested = patch.plannedMinutes !== undefined
        ? patch.plannedMinutes : prev.plannedMinutes;
      return {
        ok: true,
        day: {...day, focus: day.focus ? {...day.focus} : null},
        clamped: Number.isSafeInteger(requested) && day.plannedMinutes !== requested,
      };
    },

    // 接受今天的主線。未來不能接受：接受是「今天要做這個」的宣告（§3.1）。
    // 本次時間跟 focus 一起落地：分兩次寫的話，第二次失敗會留下一個已接受但
    // plannedMinutes 還是 null 的今天，之後改精力或班表就會默默改掉顯示的時間。
    setDayFocus(date, {goalId, stepId, plannedMinutes, changeReason} = {}){
      let key, day;
      try{
        key = model.normalizeDue(date);
        if(!key) throw new Error("要先指定日期");
        if(key > logicalToday()) throw new Error("未來的日子不能開始主線");
        const goal = data.goals.find(g => g.id === goalId);
        if(!goal) throw new Error("找不到這個目標");
        if(goal.status !== model.GOAL_STATUS.ACTIVE) throw new Error("這個目標已經不在進行中");
        const step = data.steps.find(s => s.id === stepId);
        if(!step) throw new Error("找不到這個步驟");
        if(step.goalId !== goal.id) throw new Error("這個步驟不屬於選定的目標");
        if(step.archived || !model.isActionable(step.state)){
          throw new Error("這個步驟已經不需要行動了");
        }
        const prev = data.planner.days[key] || model.createPlannerDay({});
        day = model.createPlannerDay({
          ...prev,
          // 重新開始就不再是收工：模式跟著回到 active，並恢復原本的主線（§4）。
          mode: model.DAY_MODE.ACTIVE,
          plannedMinutes: plannedMinutes === undefined ? prev.plannedMinutes : plannedMinutes,
          changeReason: changeReason === undefined ? prev.changeReason : changeReason,
          focus: {goalId, stepId, acceptedAt: new Date().toISOString()},
          updatedAt: new Date().toISOString(),
        });
      }catch(err){ return {ok: false, reason: "invalid", message: err.message}; }
      const out = transact(() => {data.planner.days[key] = day;});
      if(!out.ok) return out;
      return {ok: true, day: {...day, focus: {...day.focus}}};
    },

    clearDayFocus(date){
      let key, day;
      try{
        key = model.normalizeDue(date);
        if(!key) throw new Error("要先指定日期");
        const prev = data.planner.days[key] || model.createPlannerDay({});
        day = model.createPlannerDay({...prev, focus: null,
                                      updatedAt: new Date().toISOString()});
      }catch(err){ return {ok: false, reason: "invalid", message: err.message}; }
      const out = transact(() => {data.planner.days[key] = day;});
      if(!out.ok) return out;
      return {ok: true, day: {...day, focus: null}};
    },

    // 第一動作 / 最低入口 / 完成條件。這是使用者替既有 step 補的說明，
    // 不是另建一個 step。
    setStepDetail(stepId, patch = {}){
      let detail;
      try{
        if(!data.steps.some(s => s.id === stepId)) throw new Error("找不到這個步驟");
        const prev = data.planner.stepDetails[stepId] || model.createStepDetail({});
        detail = model.createStepDetail({...prev, ...patch});
      }catch(err){ return {ok: false, reason: "invalid", message: err.message}; }
      const out = transact(() => {data.planner.stepDetails[stepId] = detail;});
      if(!out.ok) return out;
      return {ok: true, detail: {...detail}};
    },

    // 成果提交（§5）。保存進度不改 step.state、不發 XP；完整完成沿用既有的
    // 完成路徑與獎勵，成果、step、XP、成就在同一次寫入中一起落地。
    submitOutcome({requestId = null, stepId, outcome, note = "", nextAction = "",
                   url = null, confirmed = false} = {}){
      const today = logicalToday();
      const rid = requestId || model.newId("req");
      // 同一個 requestId 重送回傳原結果，不再寫第二筆（§6.2）。
      const already = data.planner.entries.find(e => e.requestId === rid);
      if(already) return {ok: true, duplicate: true, entry: {...already}};

      let entry;
      try{
        const step = data.steps.find(s => s.id === stepId);
        if(!step) throw new Error("找不到這個步驟");
        if(step.kind === model.STEP_KIND.DAILY){
          throw new Error("日常維持任務請在任務頁打卡");
        }
        // 完整完成要當次確認，不能只靠「按過完成」這個動作本身（§5）。
        if(outcome === model.OUTCOME.COMPLETE && confirmed !== true){
          throw new Error("要先確認完成條件已達成");
        }
        entry = model.createPlannerEntry({
          requestId: rid, day: today, goalId: step.goalId, stepId, outcome,
          note, nextAction, url, createdAt: new Date().toISOString(),
        });
      }catch(err){ return {ok: false, reason: "invalid", message: err.message}; }

      const out = transact(() => {
        const i = data.steps.findIndex(s => s.id === stepId);
        const target = data.steps[i];
        let completed = false;
        let granted = [];
        // 已經是完成狀態就不再發一次獎勵，換一個 requestId 也一樣（§6.2）。
        if(outcome === model.OUTCOME.COMPLETE && target.state !== model.STEP_STATE.DONE){
          const next = {...model.completeStep(target),
                        completedAt: new Date().toISOString()};
          granted = resolveGrants(next, {goals: data.goals, skills: data.skills});
          data.steps = data.steps.map((s, n) => (n === i ? next : s));
          grantForStep(next, today);
          completed = true;
        }
        data.planner.entries = [...data.planner.entries, entry];
        return {completed, granted};
      });
      if(!out.ok) return out;
      return {ok: true, entry: {...entry}, requestId: rid,
              completed: out.value.completed, granted: out.value.granted};
    },

    // ── 備份匯出 / 匯入 ─────────────────────────────────────────────────────
    toJSON(){return store.getState();},

    // 試算一份備份會轉出什麼，但不落地。匯入是破壞性的：現有資料被蓋掉之後
    // 才告訴使用者「有 N 筆沒進來」已經來不及了。
    inspect(raw){
      if(isUnsupportedVersion(raw)){
        return {...emptyReport(), total: 0, migrated: false, unsupported: true};
      }
      const out = convert(raw);
      return {...out.report, total: reportTotal(out.report), migrated: out.looksV1,
              unsupported: false};
    },

    // v2 直接吃；認得出 v1 就走同一條遷移路徑（§7.4）。版本比這個 App 新時
    // 一律拒收：降級匯入會把不認得的欄位靜默抹掉，跟覆寫一份新版存檔一樣。
    replaceAll(raw){
      if(isUnsupportedVersion(raw)){
        throw new Error("這份備份的版本比目前的 App 新，無法匯入，也不會覆蓋現有資料");
      }
      return mutate(() => {
        const out = convert(raw);
        data = out.data;
        report = out.report;
        migrated = out.looksV1;
        fresh = false;
        return store.getState();
      });
    },
  };

  return store;
}
