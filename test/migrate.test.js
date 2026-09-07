import {test} from "node:test";
import assert from "node:assert/strict";
import {migrateV1, reportTotal} from "../src/migrate.js";
import * as m from "../src/model.js";

// 一份「正常的舊資料」：欄位都是 legacy UI 實際會寫出來的形狀，不是理想化的樣本。
function legacyPwa(over = {}){
  return {
    charName: "阿維",
    subSkills: [
      {id: 1, coreId: "body", name: "重訓", type: "active", xp: 80, icon: "🏋️",
       desc: "每週規律訓練", notes: [], source: ""},
      {id: 2, coreId: "learn", name: "快速閱讀", type: "active", xp: 50, icon: "📚",
       desc: "", notes: [], source: "《原子習慣》"},
    ],
    quests: [
      // saveQuest 建立的一般任務：沒有 archived / archivedAt，也沒有 goalId
      {id: 100, title: "報名馬拉松", type: "main", desc: "", dueDate: "2026-09-01",
       dueTime: "09:00", rewards: [{skillId: 1, xp: 60}], rewardSkillId: 1, rewardXP: 60,
       done: false, completedAt: null, completedCount: 0, lastCompletedDate: null,
       createdAt: "2026-08-01T00:00:00.000Z"},
      {id: 101, title: "每天冥想", type: "daily", desc: "", dueDate: "", dueTime: "",
       rewards: [], rewardSkillId: null, rewardXP: 50, done: false,
       streakHistory: ["2026-08-20", "2026-08-21"], completedCount: 2,
       lastCompletedDate: "2026-08-21", createdAt: "2026-08-02T00:00:00.000Z"},
    ],
    ...over,
  };
}

test("完整遷移：核心、技能、任務、角色名全部到位且數字不變", () => {
  const {data, report} = migrateV1({pwa: legacyPwa()});
  assert.equal(data.profile.charName, "阿維");
  assert.equal(data.profile.schemaVersion, 2);
  assert.equal(data.cores.length, 9, "沒存過 cores 的資料用內建預設");
  assert.deepEqual(data.skills.map(s => [s.id, s.xp]), [["sk_1", 80], ["sk_2", 50]]);
  assert.deepEqual(data.steps.map(s => [s.id, s.kind]), [["q_100", "main"], ["q_101", "daily"]]);
  assert.equal(report.skippedQuests, 0);
  assert.equal(report.skippedSkills, 0);
});

test("reward 的 skillId 隨技能 id 一起改寫，不留懸空參照", () => {
  const {data} = migrateV1({pwa: legacyPwa()});
  const q = data.steps.find(s => s.id === "q_100");
  assert.deepEqual(q.rewards, [{skillId: "sk_1", xp: 60}]);
  // 改寫後必須真的指得到技能，否則完成時發不出 XP 而且不會報錯
  assert.ok(data.skills.some(s => s.id === q.rewards[0].skillId));
});

test("只有 rewardSkillId 的舊格式也會轉成 rewards 並改寫", () => {
  const pwa = legacyPwa();
  pwa.quests[0].rewards = [];
  const {data} = migrateV1({pwa});
  assert.deepEqual(data.steps.find(s => s.id === "q_100").rewards,
                   [{skillId: "sk_1", xp: 60}]);
});

test("reward 指向不存在的技能時只丟那筆獎勵，不丟整個任務", () => {
  const pwa = legacyPwa();
  pwa.quests[0].rewards = [{skillId: 999, xp: 30}, {skillId: 1, xp: 60}];
  const {data, report} = migrateV1({pwa});
  const q = data.steps.find(s => s.id === "q_100");
  assert.ok(q, "任務本身必須留著");
  assert.deepEqual(q.rewards, [{skillId: "sk_1", xp: 60}]);
  assert.equal(report.droppedRewards, 1);
});

test("同一個數字 id 出現兩次時兩筆都留著，各自拿到唯一 id", () => {
  const pwa = legacyPwa();
  pwa.subSkills.push({id: 1, coreId: "time", name: "番茄鐘", type: "active", xp: 90});
  const {data, report} = migrateV1({pwa});
  assert.deepEqual(data.skills.map(s => s.id), ["sk_1", "sk_2", "sk_1_2"]);
  assert.equal(report.suffixedIds, 1);
});

test("舊 id 重複時 reward 指向第一筆，與 legacy find() 的語意一致", () => {
  const pwa = legacyPwa();
  pwa.subSkills.push({id: 1, coreId: "time", name: "番茄鐘", type: "active", xp: 90});
  const {data} = migrateV1({pwa});
  // 使用者在舊版看到的一直是第一筆，改指向後綴筆會把 XP 發到他沒看過的技能上
  assert.deepEqual(data.steps.find(s => s.id === "q_100").rewards,
                   [{skillId: "sk_1", xp: 60}]);
});

test("已完成又已封存的任務，兩種資訊都留下來", () => {
  const pwa = legacyPwa();
  pwa.quests[0].done = true;
  pwa.quests[0].archived = true;
  pwa.quests[0].archivedAt = "2026-08-30T10:00:00.000Z";
  const {data} = migrateV1({pwa});
  const q = data.steps.find(s => s.id === "q_100");
  assert.equal(q.state, m.STEP_STATE.DONE, "完成不能被封存蓋掉");
  assert.equal(q.archived, true, "封存也不能被完成蓋掉");
  assert.equal(q.archivedAt, "2026-08-30T10:00:00.000Z");
});

test("從未封存的任務補上中性值，不會因為缺欄位被跳過", () => {
  const {data, report} = migrateV1({pwa: legacyPwa()});
  const q = data.steps.find(s => s.id === "q_100");
  assert.equal(q.archived, false);
  assert.equal(q.archivedAt, null);
  assert.equal(report.skippedQuests, 0);
});

test("legacy main quest 沒有 goalId，遷移後仍然留著", () => {
  const {data} = migrateV1({pwa: legacyPwa()});
  const q = data.steps.find(s => s.id === "q_100");
  assert.equal(q.kind, "main");
  assert.equal(q.goalId, null);
});

test("缺欄位一律補中性值，時間點補 null 而不是遷移時間", () => {
  const pwa = {charName: "阿維", subSkills: [{id: 5, coreId: "body", name: "散步"}],
               quests: [{id: 9, title: "隨手記", type: "side"}]};
  const {data} = migrateV1({pwa});
  const sk = data.skills[0];
  assert.deepEqual([sk.desc, sk.icon, sk.source, sk.xp, sk.notes], ["", "", "", 0, []]);
  assert.equal(sk.createdAt, null, "沒有來源就不編造建立時間");
  assert.equal(sk.builtin, false);
  const q = data.steps[0];
  assert.equal(q.createdAt, null);
  assert.equal(q.completedAt, null);
  assert.equal(q.deferCount, 0);
  assert.deepEqual(q.rewards, []);
  assert.equal(q.xp, m.KIND_DEFAULT_XP.side);
});

test("cores 補上 order 與 builtin，內建與自訂分得出來", () => {
  const pwa = legacyPwa({cores: [
    {id: "body", name: "身體管理", title: "John Wick", icon: "🔫", color: "#ef4444"},
    {id: "core_777", name: "自訂", title: "我的", icon: "⭐", color: "#fff"},
  ]});
  const {data} = migrateV1({pwa});
  assert.deepEqual(data.cores.map(c => [c.id, c.order, c.builtin]),
                   [["body", 0, true], ["core_777", 1, false]]);
});

test("使用者刪掉的內建核心不會被補回來", () => {
  const pwa = legacyPwa({cores: [
    {id: "body", name: "身體管理"}, {id: "learn", name: "學習能力"},
  ]});
  const {data} = migrateV1({pwa});
  assert.deepEqual(data.cores.map(c => c.id), ["body", "learn"]);
});

test("notes 裡的舊合併紀錄會被認出來，mergedFrom 用空陣列標記", () => {
  const pwa = legacyPwa();
  pwa.subSkills[0].notes = [{id: 1, text: "⚗ 合併自：\n・重訓（EXP 80）", date: "2026/8/1"}];
  const {data} = migrateV1({pwa});
  assert.deepEqual(data.skills[0].mergedFrom, [], "曾經合併過");
  assert.equal(data.skills[1].mergedFrom, null, "從未合併");
});

test("activeDays 由 daily 的 streakHistory 回填，不是清成空的", () => {
  const pwa = legacyPwa();
  pwa.quests.push({id: 102, title: "每天走路", type: "daily",
                   streakHistory: ["2026-08-21", "2026-08-22"]});
  const {data} = migrateV1({pwa});
  // 聯集、去重、升序：證據還在資料裡，不該讓連續天數歸零
  assert.deepEqual(data.meta.activeDays, ["2026-08-20", "2026-08-21", "2026-08-22"]);
});

test("壞資料只跳過那一筆，並且計入回報而不是靜默吞掉", () => {
  const pwa = legacyPwa();
  pwa.subSkills.push({id: 3, coreId: "body", name: "   "});   // 空標題
  pwa.quests.push({id: 103, title: "", type: "side"});        // 空標題
  pwa.quests.push(null);
  const {data, report} = migrateV1({pwa});
  assert.equal(data.skills.length, 2);
  assert.equal(report.skippedSkills, 1);
  assert.equal(report.skippedQuests, 2);
});

test("Goal / Step 層：有目標的是主線，沒目標的進收件匣", () => {
  const goals = {
    goals: [{id: "g1", title: "跑完半馬", why: "", status: "active"}],
    steps: [
      {id: "s1", goalId: "g1", title: "報名", order: 0, state: "•"},
      {id: "s2", goalId: null, title: "隨手記", order: 0, state: "•"},
    ],
  };
  const {data} = migrateV1({pwa: legacyPwa(), goals});
  const byId = Object.fromEntries(data.steps.map(s => [s.id, s]));
  assert.equal(byId.s1.kind, "main");
  assert.equal(byId.s2.kind, "inbox");
  assert.equal(data.goals[0].coreId, null);
});

test("quest 與 Goal/Step 的 id 不會互相蓋掉", () => {
  const goals = {goals: [], steps: [{id: "q_100", goalId: null, title: "撞名", order: 0}]};
  const {data} = migrateV1({pwa: legacyPwa(), goals});
  const ids = data.steps.map(s => s.id);
  assert.equal(new Set(ids).size, ids.length, "id 必須全部唯一");
  assert.equal(data.steps.length, 3, "沒有任何一筆被去重吃掉");
});

test("遷移不追溯造 xpLog，既有 XP 留在技能上當起始值", () => {
  const {data} = migrateV1({pwa: legacyPwa()});
  assert.deepEqual(data.xpLog, []);
  assert.deepEqual(data.achievements, []);
  assert.equal(m.coreXp(data.skills, "body"), 80);
});

test("legacy 筆記不會在遷移時整批消失", () => {
  const pwa = legacyPwa();
  // 舊 UI 的 note id 是 Date.now() 產生的數字，過不了 v2 的 id 規則
  pwa.subSkills[0].notes = [
    {id: 1756000000000, text: "深蹲要先練髖鉸鏈", date: "2026/8/1"},
    {id: 1756000000001, text: "組間休息 90 秒", date: "2026/8/2"},
  ];
  const {data} = migrateV1({pwa});
  const notes = data.skills[0].notes;
  assert.equal(notes.length, 2, "筆記是使用者累積的知識，一則都不能掉");
  assert.deepEqual(notes.map(n => n.text), ["深蹲要先練髖鉸鏈", "組間休息 90 秒"]);
  assert.deepEqual(notes.map(n => n.id), ["n_1756000000000", "n_1756000000001"]);
  assert.deepEqual(notes.map(n => n.date), ["2026/8/1", "2026/8/2"]);
});

test("沒有 id 的筆記會拿到一個新 id，而不是被丟掉", () => {
  const pwa = legacyPwa();
  pwa.subSkills[0].notes = [{text: "沒有 id 的舊筆記"}];
  const {data} = migrateV1({pwa});
  assert.equal(data.skills[0].notes.length, 1);
  assert.ok(data.skills[0].notes[0].id);
});

test("cores 是空陣列代表核心被刪光了，不是沒存過", () => {
  const {data} = migrateV1({pwa: legacyPwa({cores: []})});
  assert.deepEqual(data.cores, [], "不能把九個內建核心長回來");
});

test("cores 欄位不存在時才回到內建預設", () => {
  const pwa = legacyPwa();
  delete pwa.cores;
  assert.equal(migrateV1({pwa}).data.cores.length, 9);
});

test("被丟掉的獎勵會計入回報總數", () => {
  const pwa = legacyPwa();
  pwa.quests[0].rewards = [{skillId: 999, xp: 30}];
  const {report} = migrateV1({pwa});
  assert.equal(report.droppedRewards, 1);
  // 只丟了獎勵、沒有整筆跳過時，總數不能是 0，否則畫面會說「一切正常」
  assert.equal(reportTotal(report), 1);
});

test("重複的 goal id 兩筆都留著，各自拿到唯一 id", () => {
  const goals = {
    goals: [
      {id: "g_dup", title: "跑完半馬", why: "體力", status: "active"},
      {id: "g_dup", title: "學會游泳", why: "", status: "active"},
    ],
    steps: [],
  };
  const {data, report} = migrateV1({pwa: legacyPwa(), goals});
  assert.deepEqual(data.goals.map(g => [g.id, g.title]),
                   [["g_dup", "跑完半馬"], ["g_dup_2", "學會游泳"]]);
  assert.equal(report.suffixedIds, 1);
  assert.equal(report.skippedGoals, 0, "第二筆不是壞資料，不能算成跳過");
});

test("goal id 讓開之後，step 的 goalId 依 first-match 指向第一筆", () => {
  const goals = {
    goals: [
      {id: "g_dup", title: "跑完半馬", why: "", status: "active"},
      {id: "g_dup", title: "學會游泳", why: "", status: "active"},
    ],
    steps: [{id: "s1", goalId: "g_dup", title: "買鞋", order: 0, state: "•"}],
  };
  const {data} = migrateV1({pwa: legacyPwa(), goals});
  const step = data.steps.find(s => s.id === "s1");
  // 使用者在舊版看到的一直是第一筆，改指向後綴筆會把步驟搬到他沒看過的目標底下
  assert.equal(step.goalId, "g_dup");
  assert.equal(step.kind, "main");
});

test("指向不存在目標的步驟仍退回收件匣", () => {
  const goals = {goals: [], steps: [{id: "s1", goalId: "ghost", title: "孤兒", order: 0}]};
  const {data} = migrateV1({pwa: legacyPwa(), goals});
  const step = data.steps.find(s => s.id === "s1");
  assert.equal(step.goalId, null);
  assert.equal(step.kind, "inbox");
});

test("重複的 legacy 核心 id 兩筆都留下，技能仍指向第一筆", () => {
  const out = migrateV1({pwa: {
    cores: [{id: "body", name: "身體"}, {id: "body", name: "另一個身體"}],
    subSkills: [{id: 1, coreId: "body", name: "重訓", type: "active", xp: 10}],
  }});
  assert.deepEqual(out.data.cores.map(c => c.id), ["body", "body_2"]);
  assert.deepEqual(out.data.cores.map(c => c.name), ["身體", "另一個身體"]);
  assert.equal(out.data.skills[0].coreId, "body", "first-match，與 legacy find() 一致");
  assert.equal(out.report.skippedCores, 0, "沒有任何一筆被去重吃掉");
  assert.equal(out.report.suffixedIds >= 1, true);
});
