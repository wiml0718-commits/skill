// 今日計畫的儲存契約：遷移、保存失敗、防重、成果與 XP 的單次寫入。
// 對照 docs/TODAY_PLAN.md 的 A07–A08、A11–A17、A19–A21。
import {test} from "node:test";
import assert from "node:assert/strict";
import {createStore, STORAGE_KEY, UPGRADE_BACKUP_KEY, SCHEMA_VERSION} from "../src/store.js";
import {logicalToday} from "../src/rpg.js";
import * as m from "../src/model.js";

function backend(seed = {}){
  const map = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {map.set(k, String(v));},
    raw: k => (map.has(k) ? JSON.parse(map.get(k)) : null),
    has: k => map.has(k),
    put: (k, v) => {map.set(k, JSON.stringify(v));},
  };
}

// 一個已經有目標與主線步驟的 store。
function seeded(be = backend()){
  const store = createStore(be);
  store.load();
  const goal = store.addGoal({title: "做出第一版", coreId: "think"});
  const step = store.addStep({goalId: goal.id, title: "寫下規格", kind: m.STEP_KIND.MAIN});
  return {store, be, goal, step};
}

const TODAY = () => logicalToday();

// ── A11 保存進度 ───────────────────────────────────────────────────────────
test("A11 保存部分進度：停止位置與下一動作留著，不改 step 狀態也不發 XP", () => {
  const {store, step} = seeded();
  const before = store.getState();
  const res = store.submitOutcome({stepId: step.id, outcome: m.OUTCOME.PROGRESS,
                                   note: "寫到第三節", nextAction: "補資料流那段"});
  assert.equal(res.ok, true);
  assert.equal(res.completed, false);
  const after = store.getState();
  assert.equal(after.planner.entries.length, 1);
  assert.equal(after.planner.entries[0].nextAction, "補資料流那段");
  assert.equal(after.steps.find(s => s.id === step.id).state, m.STEP_STATE.TODO);
  assert.deepEqual(after.xpLog, before.xpLog);
  assert.deepEqual(after.meta.activeDays, before.meta.activeDays);
});

test("記錄進度少了下一個動作就擋下來，內容不會被寫進去", () => {
  const {store, step} = seeded();
  const res = store.submitOutcome({stepId: step.id, outcome: m.OUTCOME.PROGRESS,
                                   note: "有寫東西", nextAction: "   "});
  assert.equal(res.ok, false);
  assert.equal(res.reason, "invalid");
  assert.equal(store.getState().planner.entries.length, 0);
});

// ── A12 完整完成 ───────────────────────────────────────────────────────────
test("A12 完成自訂獎勵的步驟：成果、step、XP、成就一致，獎勵不是固定 50", () => {
  const {store, goal} = seeded();
  const skill = store.getState().skills.find(s => s.id === m.generalSkillId("think"));
  const step = store.addStep({goalId: goal.id, title: "特別獎勵的一步",
                              kind: m.STEP_KIND.MAIN,
                              rewards: [{skillId: skill.id, xp: 37}]});
  const before = skill.xp;
  const res = store.submitOutcome({stepId: step.id, outcome: m.OUTCOME.COMPLETE,
                                   note: "做完了", confirmed: true});
  assert.equal(res.ok, true);
  assert.equal(res.completed, true);
  const after = store.getState();
  assert.equal(after.steps.find(s => s.id === step.id).state, m.STEP_STATE.DONE);
  assert.equal(after.skills.find(s => s.id === skill.id).xp, before + 37);
  assert.equal(after.planner.entries.length, 1);
  assert.ok(after.meta.activeDays.includes(TODAY()));
});

test("沒勾完成條件就不算完整完成", () => {
  const {store, step} = seeded();
  const res = store.submitOutcome({stepId: step.id, outcome: m.OUTCOME.COMPLETE,
                                   note: "做完了", confirmed: false});
  assert.equal(res.ok, false);
  assert.equal(store.getState().steps.find(s => s.id === step.id).state, m.STEP_STATE.TODO);
});

// ── A13 防重 ───────────────────────────────────────────────────────────────
test("A13 同一個 requestId 重送：只留一筆成果與一份獎勵", () => {
  const {store, step} = seeded();
  const rid = "req_double";
  const a = store.submitOutcome({requestId: rid, stepId: step.id,
                                 outcome: m.OUTCOME.COMPLETE, note: "一次", confirmed: true});
  const b = store.submitOutcome({requestId: rid, stepId: step.id,
                                 outcome: m.OUTCOME.COMPLETE, note: "一次", confirmed: true});
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(b.duplicate, true);
  const state = store.getState();
  assert.equal(state.planner.entries.length, 1);
  assert.equal(state.xpLog.filter(e => e.refId === step.id).length, 1);
});

test("換一個 requestId 也不能對已完成的 step 再發一次 XP", () => {
  const {store, step} = seeded();
  store.submitOutcome({requestId: "r1", stepId: step.id, outcome: m.OUTCOME.COMPLETE,
                       note: "第一次", confirmed: true});
  const xpAfterFirst = store.getState().xpLog.length;
  const again = store.submitOutcome({requestId: "r2", stepId: step.id,
                                     outcome: m.OUTCOME.COMPLETE, note: "又按一次",
                                     confirmed: true});
  assert.equal(again.ok, true);
  assert.equal(again.completed, false);
  assert.equal(store.getState().xpLog.length, xpAfterFirst);
  assert.equal(store.getState().planner.entries.length, 2, "成果紀錄留兩筆，獎勵只發一次");
});

// ── A14 寫入失敗 ───────────────────────────────────────────────────────────
test("A14 setItem 丟例外：不顯示成功、不新增完成與 XP，恢復後可重試", () => {
  const be = backend();
  const {store, step} = seeded(be);
  const before = store.getState();
  let failing = true;
  const origSet = be.setItem;
  be.setItem = (k, v) => {
    if(failing && k === STORAGE_KEY) throw new Error("quota");
    origSet(k, v);
  };
  const res = store.submitOutcome({requestId: "r_retry", stepId: step.id,
                                   outcome: m.OUTCOME.COMPLETE, note: "做完了",
                                   confirmed: true});
  assert.equal(res.ok, false);
  assert.equal(res.reason, "write");
  const during = store.getState();
  assert.equal(during.planner.entries.length, 0, "候選狀態不能留在記憶體裡");
  assert.equal(during.steps.find(s => s.id === step.id).state, m.STEP_STATE.TODO);
  assert.deepEqual(during.xpLog, before.xpLog);

  failing = false;
  const retry = store.submitOutcome({requestId: "r_retry", stepId: step.id,
                                     outcome: m.OUTCOME.COMPLETE, note: "做完了",
                                     confirmed: true});
  assert.equal(retry.ok, true);
  assert.equal(store.getState().planner.entries.length, 1);
});

test("holdWrites（載入有損失又留不成快照）時不回報保存成功", () => {
  const be = {
    getItem: k => (k === STORAGE_KEY
      ? JSON.stringify({version: 3, profile: {}, cores: [], skills: [],
                        goals: [{id: "g1", title: "有效"}], steps: [{}], xpLog: [],
                        achievements: [], meta: {}})
      : null),
    setItem: () => {throw new Error("no space");},
  };
  const store = createStore(be);
  store.load();
  assert.equal(store.migrationReport().readOnly, true);
  const res = store.setDayPlan(TODAY(), {energy: m.ENERGY.HIGH});
  assert.equal(res.ok, false);
});

// ── A15 遷移 ───────────────────────────────────────────────────────────────
test("A15 v2 → v3：補空 planner 與版本標記，既有資料原封不動且只跑一次", () => {
  const v2 = {
    version: 2,
    profile: {charName: "阿維", schemaVersion: 2, unassignedXP: 7},
    cores: [],
    skills: [{id: "sk_a", coreId: "think", name: "手工技能", type: "active", xp: 210}],
    goals: [{id: "g1", title: "既有目標", coreId: null}],
    steps: [{id: "s1", goalId: "g1", title: "既有步驟", order: 0, state: "•",
             kind: "main", xp: 88}],
    xpLog: [{id: "x1", date: "2026-01-01", skillId: null, xp: 12, source: "step"}],
    achievements: [{id: "first_step", unlockedAt: "2026-01-01T00:00:00.000Z"}],
    meta: {activeDays: ["2026-01-01"]},
  };
  const be = backend({[STORAGE_KEY]: v2});
  const store = createStore(be);
  const state = store.load();
  assert.equal(state.version, SCHEMA_VERSION);
  assert.equal(state.profile.schemaVersion, SCHEMA_VERSION);
  assert.equal(state.profile.unassignedXP, 7);
  assert.deepEqual(state.planner.days, {});
  assert.equal(state.planner.version, m.PLANNER_VERSION);
  // 核心被刪光的狀態要保留，不讓內建核心整批復活
  assert.deepEqual(state.cores, []);
  assert.equal(state.skills.find(s => s.id === "sk_a").xp, 210);
  assert.equal(state.steps[0].xp, 88);
  assert.equal(state.achievements.length, 1);
  assert.equal(store.migrationReport().upgraded, true);
  // 升級前的原樣留了一份
  assert.deepEqual(be.raw(UPGRADE_BACKUP_KEY), v2);

  // 再開一次：已經是 v3 就不再升級，也不覆寫那份快照
  const again = createStore(be);
  again.load();
  assert.equal(again.migrationReport().upgraded, false);
  assert.deepEqual(be.raw(UPGRADE_BACKUP_KEY), v2);
});

test("升級前的快照寫不進去就不寫升級結果", () => {
  const v2 = {version: 2, profile: {}, cores: [], skills: [], goals: [], steps: [],
              xpLog: [], achievements: [], meta: {}};
  const map = new Map([[STORAGE_KEY, JSON.stringify(v2)]]);
  const be = {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      if(k === UPGRADE_BACKUP_KEY) throw new Error("quota");
      map.set(k, String(v));
    },
  };
  const store = createStore(be);
  store.load();
  assert.equal(store.migrationReport().readOnly, true);
  assert.equal(JSON.parse(map.get(STORAGE_KEY)).version, 2, "原本的 v2 沒有被覆寫");
});

// ── A16 匯出 / 匯入 ────────────────────────────────────────────────────────
test("A16 v3 匯出再匯入：planner 往返不丟失；匯入 v2 只補預設", () => {
  const {store, goal, step} = seeded();
  store.setPlannerConfig({anchorDate: "2026-09-09", anchorPhase: 0,
                          goalBindings: {ai: goal.id}});
  store.setDayPlan(TODAY(), {energy: m.ENERGY.HIGH, availableMinutes: 60});
  store.setDayFocus(TODAY(), {goalId: goal.id, stepId: step.id});
  store.setStepDetail(step.id, {completionCriteria: "規格寫完並自己讀過一次"});
  store.submitOutcome({stepId: step.id, outcome: m.OUTCOME.PROGRESS,
                       note: "寫了一半", nextAction: "補資料流"});
  const dump = JSON.parse(JSON.stringify(store.toJSON()));

  const fresh = createStore(backend());
  fresh.load();
  fresh.replaceAll(dump);
  const back = fresh.getState();
  assert.deepEqual(back.planner.config, dump.planner.config);
  assert.deepEqual(back.planner.days, dump.planner.days);
  assert.deepEqual(back.planner.stepDetails, dump.planner.stepDetails);
  assert.deepEqual(back.planner.entries, dump.planner.entries);

  // v2 備份沒有 planner：補一份空的，其他資料照進來
  const v2 = {...dump, version: 2};
  delete v2.planner;
  fresh.replaceAll(v2);
  const afterV2 = fresh.getState();
  assert.deepEqual(afterV2.planner.days, {});
  assert.equal(afterV2.goals.length, dump.goals.length);
  assert.equal(fresh.inspect(v2).total, 0, "缺 planner 不算資料損失");
});

// ── A17 損毀與未來版本 ─────────────────────────────────────────────────────
test("A17 未來版本的存檔：保留原文、回報不支援，一個字都不寫", () => {
  const future = {version: SCHEMA_VERSION + 1, profile: {}, cores: [], skills: [],
                  goals: [{id: "g1", title: "新版建的目標"}], steps: [], xpLog: [],
                  achievements: [], meta: {}, planner: {version: 1}};
  const be = backend({[STORAGE_KEY]: future});
  const store = createStore(be);
  const state = store.load();
  assert.equal(store.migrationReport().unsupported, true);
  assert.equal(store.migrationReport().readOnly, true);
  assert.equal(state.goals.length, 1, "能解讀的部分仍顯示得出來，不 reset 成空白");
  assert.deepEqual(be.raw(STORAGE_KEY), future);
  assert.equal(store.setDayPlan(TODAY(), {energy: m.ENERGY.LOW}).ok, false);
});

test("未知的 planner 內部版本同樣不覆寫", () => {
  const newer = {version: SCHEMA_VERSION, profile: {}, cores: [], skills: [], goals: [],
                 steps: [], xpLog: [], achievements: [], meta: {},
                 planner: {version: m.PLANNER_VERSION + 1, days: {}, entries: []}};
  const be = backend({[STORAGE_KEY]: newer});
  const store = createStore(be);
  store.load();
  assert.equal(store.migrationReport().unsupported, true);
  assert.deepEqual(be.raw(STORAGE_KEY), newer);
});

test("planner 裡的單筆壞資料只跳過那一筆並計入回報", () => {
  const be = backend({[STORAGE_KEY]: {
    version: SCHEMA_VERSION, profile: {}, cores: [], skills: [], goals: [], steps: [],
    xpLog: [], achievements: [], meta: {},
    planner: {
      version: 1,
      config: {anchorDate: "不是日期", anchorPhase: 0},
      days: {"2026-09-10": {energy: "high"}, "壞掉的日期": {energy: "low"}},
      stepDetails: {s1: {firstAction: "打開檔案"}},
      entries: [{requestId: "r1", day: "2026-09-10", stepId: "s1", outcome: "progress",
                 note: "有寫", nextAction: "下一步"},
                {requestId: "r2", day: "2026-09-10", stepId: "s1", outcome: "亂填",
                 note: "壞的"}],
    },
  }});
  const store = createStore(be);
  const state = store.load();
  const report = store.migrationReport();
  assert.equal(report.skippedPlannerDays, 1);
  assert.equal(report.skippedPlannerEntries, 1);
  assert.equal(state.planner.days["2026-09-10"].energy, "high");
  assert.equal(state.planner.entries.length, 1);
  assert.equal(state.planner.config.anchorDate, null, "壞掉的 anchor 退回未設定");
});

// ── A20 輸入驗證 ───────────────────────────────────────────────────────────
test("A20 空白、HTML 片段與 javascript: 連結", () => {
  const {store, step} = seeded();
  assert.equal(store.submitOutcome({stepId: step.id, outcome: m.OUTCOME.PROGRESS,
                                    note: "   ", nextAction: "x"}).ok, false);

  const bad = store.submitOutcome({stepId: step.id, outcome: m.OUTCOME.PROGRESS,
                                   note: "做了事", nextAction: "下一步",
                                   url: "javascript:alert(1)"});
  assert.equal(bad.ok, false);
  assert.equal(store.getState().planner.entries.length, 0, "連結無效時整筆不寫入");

  assert.equal(store.submitOutcome({stepId: step.id, outcome: m.OUTCOME.PROGRESS,
                                    note: "做了事", nextAction: "下一步",
                                    url: "/relative/path"}).ok, false);

  // HTML 片段是合法文字，原樣保存；跳脫是渲染層的事
  const ok = store.submitOutcome({stepId: step.id, outcome: m.OUTCOME.PROGRESS,
                                  note: "<img src=x onerror=alert(1)>", nextAction: "下一步",
                                  url: "https://example.com/a"});
  assert.equal(ok.ok, true);
  assert.equal(store.getState().planner.entries[0].note, "<img src=x onerror=alert(1)>");
});

// ── A21 分頁衝突 ───────────────────────────────────────────────────────────
test("A21 其他分頁已存新狀態：偵測衝突，不以舊快照覆蓋", () => {
  const be = backend();
  const {store, step} = seeded(be);
  const mine = be.raw(STORAGE_KEY);
  // 另一個分頁寫了一份新的
  const theirs = {...mine, profile: {...mine.profile, charName: "另一個分頁"}};
  be.put(STORAGE_KEY, theirs);

  const res = store.submitOutcome({requestId: "r_conflict", stepId: step.id,
                                   outcome: m.OUTCOME.COMPLETE, note: "做完了",
                                   confirmed: true});
  assert.equal(res.ok, false);
  assert.equal(res.reason, "conflict");
  assert.equal(be.raw(STORAGE_KEY).profile.charName, "另一個分頁", "對方的資料還在");
  assert.equal(store.getState().planner.entries.length, 0);
});

// ── A07／A08 時間與收工 ────────────────────────────────────────────────────
test("A07 手動選的本次時間會留著；調低可用時間才縮到上限並回報", () => {
  const {store} = seeded();
  const today = TODAY();
  store.setDayPlan(today, {availableMinutes: 25});
  const picked = store.setDayPlan(today, {plannedMinutes: 15});
  assert.equal(picked.ok, true);
  assert.equal(picked.clamped, false);
  assert.equal(store.getState().planner.days[today].plannedMinutes, 15);

  // 改精力不會動到已選時間
  store.setDayPlan(today, {energy: m.ENERGY.LOW});
  assert.equal(store.getState().planner.days[today].plannedMinutes, 15);

  const lowered = store.setDayPlan(today, {availableMinutes: 5});
  assert.equal(lowered.ok, true);
  assert.equal(lowered.day.plannedMinutes, 5, "縮到上限");
});

test("A08 收工：存模式、保留主線，XP 與 activeDays 都不增加", () => {
  const {store, goal, step} = seeded();
  const today = TODAY();
  store.setDayFocus(today, {goalId: goal.id, stepId: step.id});
  const before = store.getState();
  const res = store.setDayPlan(today, {mode: m.DAY_MODE.RECOVERY, plannedMinutes: 0});
  assert.equal(res.ok, true);
  const after = store.getState();
  assert.equal(after.planner.days[today].mode, m.DAY_MODE.RECOVERY);
  assert.deepEqual(after.planner.days[today].focus.stepId, step.id);
  assert.equal(after.steps.find(s => s.id === step.id).state, m.STEP_STATE.TODO);
  assert.deepEqual(after.xpLog, before.xpLog);
  assert.deepEqual(after.meta.activeDays, before.meta.activeDays);

  // 重新選正數時間並開始：模式回到 active，恢復原 focus，仍然不發 XP
  store.setDayPlan(today, {plannedMinutes: 25});
  const restart = store.setDayFocus(today, {goalId: goal.id, stepId: step.id});
  assert.equal(restart.ok, true);
  assert.equal(store.getState().planner.days[today].mode, m.DAY_MODE.ACTIVE);
  assert.deepEqual(store.getState().xpLog, before.xpLog);
});

// ── A19 未來日期 ───────────────────────────────────────────────────────────
test("A19 未來只可規劃：不能確認實際出勤，也不能開始主線", () => {
  const {store, goal, step} = seeded();
  const future = m.shiftDate(TODAY(), 2);
  const planOk = store.setDayPlan(future, {attendancePlan: m.ATTENDANCE.OVERTIME});
  assert.equal(planOk.ok, true);
  const actual = store.setDayPlan(future, {attendanceActual: m.ATTENDANCE.WORK});
  assert.equal(actual.ok, false);
  assert.equal(store.getState().planner.days[future].attendanceActual, null);
  assert.equal(store.setDayFocus(future, {goalId: goal.id, stepId: step.id}).ok, false);
});

test("已經有每日紀錄時改 anchor 會被擋下並回報影響", () => {
  const {store} = seeded();
  store.setPlannerConfig({anchorDate: "2026-09-01", anchorPhase: 0});
  store.setDayPlan(TODAY(), {energy: m.ENERGY.MID});
  const blocked = store.setPlannerConfig({anchorDate: "2026-09-03", anchorPhase: 1});
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, "has-days");
  assert.equal(store.getState().planner.config.anchorDate, "2026-09-01");
  const forced = store.setPlannerConfig({anchorDate: "2026-09-03", anchorPhase: 1, force: true});
  assert.equal(forced.ok, true);
});

test("接受 focus 需要進行中的目標與該目標底下可行動的步驟", () => {
  const {store, goal, step} = seeded();
  const today = TODAY();
  assert.equal(store.setDayFocus(today, {goalId: goal.id, stepId: "沒這個"}).ok, false);
  store.setGoalStatus(goal.id, m.GOAL_STATUS.ARCHIVED);
  assert.equal(store.setDayFocus(today, {goalId: goal.id, stepId: step.id}).ok, false);
});

test("成果文字超過上限時整筆擋下，不留半筆結算", () => {
  const {store, step} = seeded();
  const before = store.getState();
  const res = store.submitOutcome({stepId: step.id, outcome: m.OUTCOME.COMPLETE,
                                   note: "x".repeat(m.PLANNER_LIMITS.note + 1),
                                   confirmed: true});
  assert.equal(res.ok, false);
  assert.equal(store.getState().planner.entries.length, 0);
  assert.equal(store.getState().steps.find(s => s.id === step.id).state,
               before.steps.find(s => s.id === step.id).state);
});

// ── Codex Review 第 1 輪的回歸測試 ─────────────────────────────────────────
test("任何一條寫入路徑都會擋下舊快照覆寫，不只今日計畫", () => {
  const be = backend();
  const {store} = seeded(be);
  const mine = be.raw(STORAGE_KEY);
  const theirs = {...mine, profile: {...mine.profile, charName: "另一個分頁"}};
  be.put(STORAGE_KEY, theirs);

  // 舊的那一頁按「新增目標」：丟出 WriteError，記憶體回復，對方的資料不動
  assert.throws(() => store.addGoal({title: "舊分頁新增的", coreId: "think"}),
                {name: "WriteError", reason: "conflict"});
  assert.equal(store.getState().goals.length, mine.goals.length,
               "沒寫進去的變更不留在記憶體裡");
  assert.equal(be.raw(STORAGE_KEY).profile.charName, "另一個分頁");
  assert.equal(be.raw(STORAGE_KEY).goals.length, mine.goals.length);
  const report = store.migrationReport();
  assert.equal(report.conflict, true);
  assert.equal(report.readOnly, true);
  // 偵測到之後整個 session 唯讀：後續寫入一律回報衝突，不會偷偷成功
  assert.equal(store.setDayPlan(TODAY(), {energy: m.ENERGY.LOW}).reason, "conflict");
});

test("匯入版本比 App 新的備份：試算回報不支援，replaceAll 直接拒收", () => {
  const {store, goal} = seeded();
  const before = store.getState();
  const future = {...JSON.parse(JSON.stringify(before)), version: SCHEMA_VERSION + 1};
  assert.equal(store.inspect(future).unsupported, true);
  assert.throws(() => store.replaceAll(future), /版本比目前的 App 新/);
  assert.equal(store.getState().goals.find(g => g.id === goal.id).title, goal.title);

  const newerPlanner = {...JSON.parse(JSON.stringify(before)),
                        planner: {...before.planner, version: m.PLANNER_VERSION + 1}};
  assert.equal(store.inspect(newerPlanner).unsupported, true);
  assert.throws(() => store.replaceAll(newerPlanner));
});

test("v3 的存檔缺 planner 算損壞；v2 缺 planner 不算", () => {
  const base = {profile: {}, cores: [], skills: [], goals: [], steps: [], xpLog: [],
                achievements: [], meta: {}};
  const store = createStore(backend());
  store.load();
  assert.ok(store.inspect({...base, version: SCHEMA_VERSION}).total > 0,
            "v3 少了 planner 就是被截斷了");
  assert.equal(store.inspect({...base, version: 2}).total, 0,
               "v2 本來就沒有 planner");

  // 載入時同樣走損壞保護：留了原樣快照才准覆寫
  const be = backend({[STORAGE_KEY]: {...base, version: SCHEMA_VERSION}});
  const loaded = createStore(be);
  loaded.load();
  assert.ok(loaded.migrationReport().total > 0);
  assert.ok(be.has("skill-damaged-v2"), "原樣另存一份才准覆寫");
});

test("只調低可用時間、沒動本次時間時，也會回報已縮到上限", () => {
  const {store} = seeded();
  const today = TODAY();
  store.setDayPlan(today, {availableMinutes: 60});
  store.setDayPlan(today, {plannedMinutes: 25});
  const lowered = store.setDayPlan(today, {availableMinutes: 5});
  assert.equal(lowered.ok, true);
  assert.equal(lowered.clamped, true);
  assert.equal(lowered.day.plannedMinutes, 5);
  // 沒有被夾到時不要謊報
  const same = store.setDayPlan(today, {energy: m.ENERGY.HIGH});
  assert.equal(same.clamped, false);
});

// ── Codex Review 第 2 輪的回歸測試 ─────────────────────────────────────────
test("v3 的 planner 被截斷：缺少的區段計入損失，不會靜默清掉班表與成果", () => {
  const store = createStore(backend());
  store.load();
  const full = {version: SCHEMA_VERSION, profile: {}, cores: [], skills: [], goals: [],
                steps: [], xpLog: [], achievements: [], meta: {},
                planner: {version: 1, config: {anchorDate: null, anchorPhase: null,
                                               goalBindings: {}},
                          days: {}, stepDetails: {}, entries: []}};
  assert.equal(store.inspect(full).total, 0, "完整的 v3 不算損失");

  const truncated = {...full, planner: {version: 1}};
  // config / days / stepDetails / entries 四段不見
  assert.equal(store.inspect(truncated).total, 4);

  const badConfig = {...full, planner: {...full.planner, config: {anchorDate: "壞", anchorPhase: 0}}};
  assert.equal(store.inspect(badConfig).total, 1, "整段 config 歸零也是損失");

  // 缺席的 config 會讓 createPlannerConfig 成功地做出一份空設定，不能因此
  // 當成沒事——匯入時它會把有效的 anchor 與目標綁定換成預設值。
  const noConfig = {...full, planner: {...full.planner}};
  delete noConfig.planner.config;
  assert.equal(store.inspect(noConfig).total, 1);
});

test("非今日計畫的寫入失敗同樣整個回復，不留下沒存進去的完成與 XP", () => {
  const be = backend();
  const {store, step} = seeded(be);
  const before = store.getState();
  const origSet = be.setItem;
  be.setItem = (k, v) => {
    if(k === STORAGE_KEY) throw new Error("quota");
    origSet(k, v);
  };
  assert.throws(() => store.completeStep(step.id), {name: "WriteError", reason: "write"});
  const after = store.getState();
  assert.equal(after.steps.find(s => s.id === step.id).state, m.STEP_STATE.TODO);
  assert.deepEqual(after.xpLog, before.xpLog);
  assert.deepEqual(after.meta.activeDays, before.meta.activeDays);
  assert.deepEqual(after.skills, before.skills);

  assert.throws(() => store.adjustSkillXp(m.generalSkillId("think"), 50),
                {name: "WriteError"});
  assert.deepEqual(store.getState().skills, before.skills);
});

// ── Codex Review 第 3 輪的回歸測試 ─────────────────────────────────────────
test("接受主線與本次時間在同一次寫入落地", () => {
  const be = backend();
  const {store, goal, step} = seeded(be);
  const today = TODAY();
  store.setDayPlan(today, {availableMinutes: 60});

  const ok = store.setDayFocus(today, {goalId: goal.id, stepId: step.id,
                                       plannedMinutes: 25});
  assert.equal(ok.ok, true);
  const day = store.getState().planner.days[today];
  assert.equal(day.focus.stepId, step.id);
  assert.equal(day.plannedMinutes, 25, "不必再補第二次寫入");

  // 沒帶 plannedMinutes 時沿用原值，不會被清掉
  store.setDayFocus(today, {goalId: goal.id, stepId: step.id});
  assert.equal(store.getState().planner.days[today].plannedMinutes, 25);
});

test("接受主線寫入失敗時，focus 與本次時間都不會留下", () => {
  const be = backend();
  const {store, goal, step} = seeded(be);
  const today = TODAY();
  const origSet = be.setItem;
  be.setItem = (k, v) => {
    if(k === STORAGE_KEY) throw new Error("quota");
    origSet(k, v);
  };
  const res = store.setDayFocus(today, {goalId: goal.id, stepId: step.id,
                                        plannedMinutes: 25});
  assert.equal(res.ok, false);
  assert.equal(store.getState().planner.days[today], undefined);
});
