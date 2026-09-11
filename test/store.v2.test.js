import {test} from "node:test";
import assert from "node:assert/strict";
import {createStore, STORAGE_KEY, LEGACY_PWA_KEY, LEGACY_GOALS_KEY, BACKUP_KEY,
        DAMAGED_KEY} from "../src/store.js";
import * as m from "../src/model.js";

function backend(seed = {}){
  const map = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {map.set(k, String(v));},
    raw: k => JSON.parse(map.get(k)),
    has: k => map.has(k),
  };
}

const PWA = {
  charName: "阿維",
  subSkills: [{id: 1, coreId: "body", name: "重訓", type: "active", xp: 80}],
  quests: [{id: 100, title: "報名馬拉松", type: "main", dueDate: "2026-09-01",
            rewards: [{skillId: 1, xp: 60}], done: false,
            createdAt: "2026-08-01T00:00:00.000Z"}],
};
const GOALS = {
  version: 1,
  goals: [{id: "g1", title: "跑完半馬", why: "體力", status: "active"}],
  steps: [{id: "s1", goalId: "g1", title: "買鞋", order: 0, state: "•"}],
};

test("首次載入會遷移舊資料，並且一筆都不動舊 key", () => {
  const be = backend({[LEGACY_PWA_KEY]: PWA, [LEGACY_GOALS_KEY]: GOALS});
  const store = createStore(be);
  store.load();

  assert.equal(store.migrationReport().migrated, true);
  assert.equal(be.raw(STORAGE_KEY).version, 3);
  // 舊 key 是最後的回退路徑，遷移不得刪也不得改
  assert.deepEqual(be.raw(LEGACY_PWA_KEY), PWA);
  assert.deepEqual(be.raw(LEGACY_GOALS_KEY), GOALS);
});

test("遷移前先留一份原樣快照", () => {
  const be = backend({[LEGACY_PWA_KEY]: PWA, [LEGACY_GOALS_KEY]: GOALS});
  createStore(be).load();
  const backup = be.raw(BACKUP_KEY);
  assert.deepEqual(backup[LEGACY_PWA_KEY], PWA);
  assert.deepEqual(backup[LEGACY_GOALS_KEY], GOALS);
  assert.ok(backup.savedAt, "要記錄備份時間");
});

test("已經有快照就不覆寫，避免第二次遷移把第一份蓋掉", () => {
  const be = backend({[LEGACY_PWA_KEY]: PWA, [BACKUP_KEY]: {savedAt: "早就存了"}});
  createStore(be).load();
  assert.equal(be.raw(BACKUP_KEY).savedAt, "早就存了");
});

test("第二次載入直接讀 v2，不再跑遷移", () => {
  const be = backend({[LEGACY_PWA_KEY]: PWA, [LEGACY_GOALS_KEY]: GOALS});
  createStore(be).load();
  const first = be.raw(STORAGE_KEY);

  const again = createStore(be);
  again.load();
  assert.equal(again.migrationReport().migrated, false);
  assert.deepEqual(again.getState().steps.map(s => s.id), first.steps.map(s => s.id));
});

test("完全沒有舊資料時也能開起來", () => {
  const store = createStore(backend());
  const state = store.load();
  assert.equal(store.migrationReport().migrated, false);
  assert.equal(state.cores.length, 9);
  assert.deepEqual(state.goals, []);
});

test("每個核心都會補上一個承接技能，而且不外流到 legacy 檢視", () => {
  const store = createStore(backend({[LEGACY_PWA_KEY]: PWA}));
  store.load();
  const skills = store.getState().skills;
  const general = skills.filter(s => s.builtin);
  assert.equal(general.length, 9, "9 個核心各一個");
  assert.ok(general.every(s => s.id === m.generalSkillId(s.coreId)));
  // 它是系統產生的容器，不是使用者建立的技能，畫面上不該多出來
  assert.deepEqual(store.legacyState().subSkills.map(s => s.id), ["sk_1"]);
});

test("承接技能的 XP 為 0，不會改到既有的核心等級", () => {
  const store = createStore(backend({[LEGACY_PWA_KEY]: PWA}));
  store.load();
  assert.equal(store.coreXp("body"), 80);
});

// ── 高水位 ───────────────────────────────────────────────────────────────────
test("inboxPeak 記的是待處理數，處理完之後不會退回去", () => {
  const store = createStore(backend());
  store.load();
  for(const t of ["a", "b", "c"]) store.addStep({title: t});
  assert.equal(store.getState().meta.inboxPeak, 3);

  const ids = store.inboxSteps().map(s => s.id);
  // 收件匣完成時才指定歸屬（§4.3）
  store.completeStep(ids[0], {coreId: "body"});
  store.noteStep(ids[1]);
  store.dropStep(ids[2]);
  assert.equal(store.inboxPending().length, 0, "畫面上已經清空");
  assert.equal(store.getState().meta.inboxPeak, 3, "高水位是歷史，不能跟著退");
});

test("已完成的收件匣項目不會把高水位灌高", () => {
  const be = backend({[STORAGE_KEY]: {
    version: 2, cores: [], skills: [], goals: [],
    steps: [{id: "s1", goalId: null, kind: "inbox", title: "早就做完了",
             order: 0, state: "×"}],
  }});
  const store = createStore(be);
  store.load();
  assert.equal(store.getState().meta.inboxPeak, 0);
});

// ── legacy 投影 ──────────────────────────────────────────────────────────────
test("legacy 投影往返之後任務內容不變", () => {
  const store = createStore(backend({[LEGACY_PWA_KEY]: PWA, [LEGACY_GOALS_KEY]: GOALS}));
  store.load();
  const before = store.legacyState();
  store.saveLegacyState(before);
  assert.deepEqual(store.legacyState(), before);
});

test("legacy 存檔只動角色與技能，不碰步驟", () => {
  const store = createStore(backend({[LEGACY_PWA_KEY]: PWA, [LEGACY_GOALS_KEY]: GOALS}));
  store.load();
  const before = store.getState().steps;
  const state = store.legacyState();
  assert.equal(state.quests, undefined, "任務已經統一走 steps，不再投影成 quest");

  state.charName = "改過的名字";
  store.saveLegacyState(state);

  assert.equal(store.getState().profile.charName, "改過的名字");
  assert.deepEqual(store.getState().steps, before, "步驟一個字都不該被動到");
});

test("legacy 存檔不會把順延狀態抹平成待辦", () => {
  const store = createStore(backend({[LEGACY_PWA_KEY]: PWA}));
  store.load();
  store.deferStep("q_100");
  // 任務頁只知道 done 或不 done，存一次不該把別的狀態洗掉
  store.saveLegacyState(store.legacyState());
  const step = store.getState().steps.find(s => s.id === "q_100");
  assert.equal(step.state, m.STEP_STATE.DEFERRED);
  assert.equal(step.deferCount, 1);
});

test("新建立的技能與步驟拿到合法 id", () => {
  const store = createStore(backend());
  store.load();
  const state = store.legacyState();
  state.subSkills.push({id: "sk_9001", coreId: "body", name: "游泳", type: "active", xp: 0});
  store.saveLegacyState(state);
  assert.ok(store.getState().skills.some(s => s.id === "sk_9001"));

  const step = store.addStep({kind: "side", title: "報名泳訓",
                              rewards: [{skillId: "sk_9001", xp: 20}]});
  assert.ok(store.getState().steps.some(s => s.id === step.id));
});

test("刪除核心是一筆交易：技能、承接技能、reward、goal 綁定一起清掉", () => {
  const store = createStore(backend({[LEGACY_PWA_KEY]: PWA, [LEGACY_GOALS_KEY]: GOALS}));
  store.load();
  store.updateGoal("g1", {coreId: "body"});
  assert.deepEqual(store.getState().steps.find(s => s.id === "q_100").rewards,
                   [{skillId: "sk_1", xp: 60}]);

  const state = store.legacyState();
  state.cores = state.cores.filter(c => c.id !== "body");
  state.subSkills = state.subSkills.filter(s => s.coreId !== "body");
  store.saveLegacyState(state);

  const after = store.getState();
  assert.ok(!after.cores.some(c => c.id === "body"));
  assert.ok(!after.skills.some(c => c.coreId === "body"), "承接技能也要跟著走");
  assert.deepEqual(after.steps.find(s => s.id === "q_100").rewards, [],
                   "指向已刪技能的獎勵不能留成懸空參照");
  assert.equal(after.goals.find(g => g.id === "g1").coreId, null);
});

// ── 匯出 / 匯入 ──────────────────────────────────────────────────────────────
test("匯入 v2 備份直接吃", () => {
  const src = createStore(backend({[LEGACY_PWA_KEY]: PWA}));
  src.load();
  const dump = src.toJSON();

  const store = createStore(backend());
  store.load();
  store.replaceAll(dump);
  assert.equal(store.getState().profile.charName, "阿維");
  assert.ok(store.getState().steps.some(s => s.id === "q_100"));
});

test("匯入 v1 備份走同一條遷移路徑", () => {
  const store = createStore(backend());
  store.load();
  store.replaceAll({...PWA, goals: GOALS.goals, steps: GOALS.steps});
  const state = store.getState();
  assert.equal(state.profile.charName, "阿維");
  assert.deepEqual(state.skills.filter(s => !s.builtin).map(s => s.id), ["sk_1"]);
  assert.ok(state.goals.some(g => g.id === "g1"));
});

test("全新安裝與「使用者清空了資料」分得出來", () => {
  const be = backend();
  const first = createStore(be);
  first.load();
  assert.equal(first.migrationReport().fresh, true, "第一次開就是全新安裝");

  // 再開一次時 v2 已經存在，即使裡面沒有技能也不算全新
  const again = createStore(be);
  again.load();
  assert.equal(again.migrationReport().fresh, false);
});

test("有舊資料可遷移時不算全新安裝", () => {
  const store = createStore(backend({[LEGACY_PWA_KEY]: PWA}));
  store.load();
  const r = store.migrationReport();
  assert.equal(r.migrated, true);
  assert.equal(r.fresh, false);
});

test("匯入舊版備份時 goalsData 信封裡的目標與步驟不會被丟掉", () => {
  // 舊版 exportData 是 {...state, goalsData:{...}}，不是攤平在頂層
  const backup = {...PWA, goalsData: {version: 1, goals: GOALS.goals, steps: GOALS.steps}};
  const store = createStore(backend());
  store.load();
  store.replaceAll(backup);
  const state = store.getState();
  assert.ok(state.goals.some(g => g.id === "g1"), "目標不能靜默消失");
  assert.ok(state.steps.some(s => s.id === "s1"), "步驟不能靜默消失");
});

test("刪掉最後一個核心之後，它不會在重新載入時復活", () => {
  const be = backend({[LEGACY_PWA_KEY]: PWA});
  const store = createStore(be);
  store.load();

  const state = store.legacyState();
  state.cores = [];
  state.subSkills = [];
  store.saveLegacyState(state);
  assert.deepEqual(store.getState().cores, []);
  assert.deepEqual(store.getState().skills, [], "承接技能也不該留下");

  const again = createStore(be);
  again.load();
  assert.deepEqual(again.getState().cores, []);
});

test("legacy 筆記經過投影往返之後不會消失", () => {
  const pwa = {...PWA, subSkills: [{...PWA.subSkills[0],
    notes: [{id: 1756000000000, text: "深蹲要先練髖鉸鏈", date: "2026/8/1"}]}]};
  const store = createStore(backend({[LEGACY_PWA_KEY]: pwa}));
  store.load();
  assert.equal(store.legacyState().subSkills[0].notes.length, 1);
  store.saveLegacyState(store.legacyState());
  assert.equal(store.legacyState().subSkills[0].notes[0].text, "深蹲要先練髖鉸鏈");
});

test("backend 讀取失敗時仍然開得起來，不會讓 install 中斷", () => {
  // 受限的隱私 / 儲存環境裡 localStorage 存在，但 getItem 會丟例外。
  // 讓它往上冒會使 window.Goals 掛不上去，整個 app 停在載入中的提示。
  const store = createStore({
    getItem: () => {throw new Error("SecurityError");},
    setItem: () => {},
  });
  const state = store.load();
  assert.equal(state.cores.length, 9);
  assert.deepEqual(state.goals, []);
  assert.equal(store.migrationReport().migrated, false);
});

test("inspect 只試算不落地，數字與實際匯入一致", () => {
  const store = createStore(backend({[LEGACY_PWA_KEY]: PWA}));
  store.load();
  const before = store.getState().profile.charName;

  const dirty = {charName: "別人", subSkills: [
    {id: 1, coreId: "body", name: "重訓", xp: 10},
    {id: 2, coreId: "body", name: "   "},        // 空標題，會被跳過
  ]};
  const preview = store.inspect(dirty);
  assert.equal(preview.total, 1);
  assert.equal(store.getState().profile.charName, before, "試算不能改到任何資料");

  const after = store.replaceAll(dirty);
  assert.equal(after.profile.charName, "別人");
  assert.equal(store.migrationReport().total, preview.total, "試算與實際必須一致");
});

test("乾淨的備份試算為 0，不會多問一次", () => {
  const src = createStore(backend({[LEGACY_PWA_KEY]: PWA}));
  src.load();
  const store = createStore(backend());
  store.load();
  assert.equal(store.inspect(src.toJSON()).total, 0);
});

test("讀不到儲存時不會把預設值寫回去蓋掉使用者的資料", () => {
  // getItem 丟例外但 setItem 正常：把例外當成「沒有資料」再 commit，
  // 等於用一份空白預設覆蓋掉其實還在的資料。
  const written = [];
  const store = createStore({
    getItem: () => {throw new Error("SecurityError");},
    setItem: (k, v) => {written.push(k);},
  });
  const state = store.load();
  assert.equal(store.migrationReport().degraded, true);
  assert.deepEqual(written, [], "一個字都不能寫");
  assert.equal(state.cores.length, 9, "記憶體裡仍要有可用的空白狀態");
});

test("唯讀模式下之後的編輯也不會落地", () => {
  const written = [];
  const store = createStore({
    getItem: () => {throw new Error("SecurityError");},
    setItem: k => {written.push(k);},
  });
  store.load();
  assert.throws(() => store.addGoal({title: "這次不該被寫進去"}),
                {name: "WriteError", reason: "degraded"});
  assert.throws(() => store.addStep({title: "隨手記"}),
                {name: "WriteError", reason: "degraded"});
  assert.deepEqual(written, []);
  assert.equal(store.getState().goals.length, 0);
});

test("被截斷的 v2 備份會被算成損失，不會靜默清掉現有資料", () => {
  const store = createStore(backend({[LEGACY_PWA_KEY]: PWA, [LEGACY_GOALS_KEY]: GOALS}));
  store.load();
  // 只剩 cores 與 skills 的備份仍會通過 index.html 的格式檢查
  const truncated = {version: 2, cores: [], skills: []};
  const preview = store.inspect(truncated);
  // profile / goals / steps / xpLog / achievements / meta 共六段不見
  assert.equal(preview.missingSections, 6);
  assert.ok(preview.total >= 6, "試算不能回報 0，否則不會跳確認就把目標清光");
});

test("完整的 v2 備份不會被誤判成有缺", () => {
  const src = createStore(backend({[LEGACY_PWA_KEY]: PWA}));
  src.load();
  const store = createStore(backend());
  store.load();
  const preview = store.inspect(src.toJSON());
  assert.equal(preview.missingSections, 0);
  assert.equal(preview.total, 0);
});

test("舊 key 讀不到時也要停手，不能寫出一份預設的 v2 蓋掉遷移機會", () => {
  // v2 還不存在（讀得到、是空的），但舊 key 讀取失敗。當成「沒有舊資料」
  // 會寫出預設 v2，之後每次開啟都直接讀它，再也不會回頭看那個其實還在的舊 key。
  const written = [];
  const store = createStore({
    getItem: k => {
      if(k === LEGACY_PWA_KEY) throw new Error("SecurityError");
      return null;
    },
    setItem: k => {written.push(k);},
  });
  store.load();
  assert.equal(store.migrationReport().degraded, true);
  assert.deepEqual(written, []);
});

test("備份快照讀不到時寧可不寫，也不蓋掉可能還在的原始備份", () => {
  const written = [];
  const store = createStore({
    getItem: k => {
      if(k === BACKUP_KEY) throw new Error("SecurityError");
      if(k === LEGACY_PWA_KEY) return JSON.stringify(PWA);
      return null;
    },
    setItem: k => {written.push(k);},
  });
  store.load();
  // 遷移本身照跑（兩個舊 key 都讀得到），但不覆寫快照
  assert.equal(store.migrationReport().migrated, true);
  assert.ok(!written.includes(BACKUP_KEY), "不確定有沒有舊快照時就不要動它");
});

test("孤兒技能計入損失，不會回報成一切正常", () => {
  const store = createStore(backend());
  store.load();
  // coreId 指向不存在的核心：技能留著，但 UI 沒有任何地方顯示得出來
  const preview = store.inspect({
    charName: "x",
    subSkills: [{id: 1, coreId: "ghost", name: "孤兒技能", xp: 10}],
  });
  assert.equal(preview.orphanSkills, 1);
  assert.ok(preview.total >= 1, "看不到的資料不能被當成沒問題");
});

test("v2 內容解不開時停手，不用預設值蓋掉可能還救得回來的資料", () => {
  const written = [];
  const store = createStore({
    getItem: k => (k === STORAGE_KEY ? '{"version":2,"cores":[' : null),
    setItem: k => {written.push(k);},
  });
  store.load();
  assert.equal(store.migrationReport().degraded, true);
  assert.deepEqual(written, [], "殘缺的 JSON 也許還能手動救，覆蓋之後就真的沒了");
});

test("舊資料解不開時也不遷移", () => {
  const written = [];
  const store = createStore({
    getItem: k => (k === LEGACY_PWA_KEY ? "{壞掉的 JSON" : null),
    setItem: k => {written.push(k);},
  });
  store.load();
  assert.equal(store.migrationReport().degraded, true);
  assert.deepEqual(written, []);
});

test("壞掉的 XP 紀錄與成就紀錄會計入損失，不會被靜默丟掉", () => {
  const store = createStore(backend());
  store.load();
  const preview = store.inspect({
    version: 2,
    profile: {charName: "x"}, cores: [], skills: [], goals: [], steps: [],
    xpLog: [{id: "x1", date: "不是日期", skillId: null, xp: 5, source: "step"}],
    achievements: [{id: "first_step", unlockedAt: "不是時間"}],
    meta: {},
  });
  assert.equal(preview.skippedXpLog, 1);
  assert.equal(preview.skippedAchievements, 1);
  assert.equal(preview.total, 2, "匯入前的確認必須看得到這兩筆");
});

test("既有 v2 含壞資料時，覆寫前先留一份原樣快照", () => {
  const damaged = {
    version: 2,
    profile: {}, cores: [], skills: [], goals: [], steps: [],
    xpLog: [{id: "x1", date: "不是日期", skillId: null, xp: 5, source: "step"}],
    achievements: [], meta: {},
  };
  const be = backend({[STORAGE_KEY]: damaged});
  const store = createStore(be);
  store.load();

  const r = store.migrationReport();
  assert.equal(r.migrated, false);
  assert.equal(r.total, 1, "一般載入丟掉的紀錄同樣要回報");
  // 落地的是丟過的版本，但原始那份還在，還救得回來
  assert.equal(be.raw(STORAGE_KEY).xpLog.length, 0);
  assert.deepEqual(be.raw(DAMAGED_KEY), damaged);
});

test("原樣快照已存在時不覆寫，也不會每次開啟都重寫一次", () => {
  const older = {version: 2, note: "先前那份"};
  const be = backend({
    [STORAGE_KEY]: {version: 2, profile: {}, cores: [], skills: [], goals: [],
                    steps: [], xpLog: [{id: "x1", date: "壞", skillId: null, xp: 1, source: "step"}],
                    achievements: [], meta: {}},
    [DAMAGED_KEY]: older,
  });
  createStore(be).load();
  assert.deepEqual(be.raw(DAMAGED_KEY), older);
});

test("乾淨的 v2 不會留下快照", () => {
  const be = backend({[STORAGE_KEY]: {
    version: 2, profile: {}, cores: [], skills: [], goals: [], steps: [],
    xpLog: [], achievements: [], meta: {},
  }});
  createStore(be).load();
  assert.equal(be.has(DAMAGED_KEY), false);
});

test("壞掉的 profile / meta 會計入損失，不會安靜地換成預設值", () => {
  const store = createStore(backend());
  store.load();
  const preview = store.inspect({
    version: 2,
    profile: {charName: "阿維", createdAt: "不是時間", unassignedXP: 30},
    cores: [], skills: [], goals: [], steps: [], xpLog: [], achievements: [],
    meta: {lastDailySummaryDate: "不是日期", inboxPeak: 12},
  });
  assert.equal(preview.total >= 2, true, "兩個區段被換掉都要看得見");
});

test("只用過目標頁的使用者升級後仍拿得到預設技能", () => {
  // skill-goals-v1 有資料、skill-pwa-v1 從來沒存過：舊版一直是給他記憶體裡的
  // 預設技能，升級後不能變成一片空白
  const store = createStore(backend({[LEGACY_GOALS_KEY]: GOALS}));
  store.load();
  const r = store.migrationReport();
  assert.equal(r.migrated, true, "目標資料確實遷移了");
  assert.equal(r.fresh, true, "但技能資料從未存在，仍要給預設技能");
});

test("技能筆記被模型濾掉時算損失，會留快照也會回報", () => {
  const damaged = {
    version: 2,
    profile: {}, cores: [{id: "body", name: "身體", order: 0}],
    skills: [{id: "sk_1", coreId: "body", name: "重訓", type: "active", xp: 10,
              notes: [{id: 1730000000000, text: "舊格式筆記"}]}],
    goals: [], steps: [], xpLog: [], achievements: [], meta: {},
  };
  const be = backend({[STORAGE_KEY]: damaged});
  const store = createStore(be);
  store.load();

  const r = store.migrationReport();
  assert.equal(r.droppedNotes, 1);
  assert.equal(r.total, 1, "整筆技能留下來了，但筆記不見了也是損失");
  assert.deepEqual(be.raw(DAMAGED_KEY), damaged, "覆寫前先留原樣");
});

test("每日任務的打卡日期被濾掉時算損失，重複日期不算", () => {
  const store = createStore(backend());
  store.load();
  const preview = store.inspect({
    version: 2,
    profile: {}, cores: [], skills: [], goals: [],
    steps: [{id: "s_1", goalId: null, kind: "daily", title: "冥想", order: 0,
             state: "•", streakHistory: ["2026-08-20", "2026-08-20", "不是日期"]}],
    xpLog: [], achievements: [], meta: {},
  });
  assert.equal(preview.droppedStreakDays, 1, "重複的那筆不算，壞掉的那筆才算");
  assert.equal(preview.total, 1);
});

test("原樣快照留不成時完全不寫，也不會謊稱已備份", () => {
  const damaged = {
    version: 2, profile: {}, cores: [], skills: [], goals: [], steps: [],
    xpLog: [{id: "x1", date: "壞", skillId: null, xp: 1, source: "step"}],
    achievements: [], meta: {},
  };
  const raw = JSON.stringify(damaged);
  const map = new Map([[STORAGE_KEY, raw]]);
  const be = {
    getItem: k => (map.has(k) ? map.get(k) : null),
    // 配額滿：新 key 寫不進去，覆寫既有 key 卻還是會成功
    setItem: (k, v) => {
      if(!map.has(k)) throw new Error("QuotaExceededError");
      map.set(k, String(v));
    },
  };
  const store = createStore(be);
  store.load();

  assert.equal(store.migrationReport().readOnly, true);
  assert.equal(map.get(STORAGE_KEY), raw, "壞掉的那份還在，沒有被丟過的版本蓋掉");

  // 之後的編輯也不落地，而且會明講沒有保存
  assert.throws(() => store.addGoal({title: "新目標"}),
                {name: "WriteError", reason: "readonly"});
  assert.equal(map.get(STORAGE_KEY), raw);
  assert.equal(store.getState().goals.length, 0);
});

test("既有快照是更早的另一份時不覆蓋，也不覆寫現有 v2", () => {
  const damaged = {
    version: 2, profile: {}, cores: [], skills: [], goals: [], steps: [],
    xpLog: [{id: "x1", date: "壞", skillId: null, xp: 1, source: "step"}],
    achievements: [], meta: {},
  };
  const be = backend({[STORAGE_KEY]: damaged, [DAMAGED_KEY]: {version: 2, note: "更早那份"}});
  const before = JSON.stringify(be.raw(STORAGE_KEY));
  const store = createStore(be);
  store.load();

  assert.equal(store.migrationReport().readOnly, true);
  assert.deepEqual(be.raw(DAMAGED_KEY), {version: 2, note: "更早那份"});
  assert.equal(JSON.stringify(be.raw(STORAGE_KEY)), before);
});
