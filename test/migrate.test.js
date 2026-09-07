import {test} from "node:test";
import assert from "node:assert/strict";
import {migrateV1} from "../src/migrate.js";
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
