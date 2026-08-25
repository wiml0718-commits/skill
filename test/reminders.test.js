import {test} from "node:test";
import assert from "node:assert/strict";
import * as r from "../src/reminders.js";
import {STEP_STATE} from "../src/model.js";

const TODAY = "2026-08-24";
const step = (id, due, state = STEP_STATE.TODO) =>
  ({id, goalId: "g1", title: `step ${id}`, due, order: 0, state});
const quest = (id, dueDate, extra = {}) =>
  ({id, title: `quest ${id}`, type: "main", dueDate, done: false, archived: false, ...extra});

test("todayISO 用本地時區，不會因為 UTC 而早一天翻頁", () => {
  // UTC+8 的深夜：toISOString() 會給前一天，本地日期才是正確的
  const d = new Date(2026, 7, 24, 1, 30);   // 2026-08-24 01:30 本地
  assert.equal(r.todayISO(d), "2026-08-24");
  assert.equal(r.todayISO(new Date(2026, 0, 5)), "2026-01-05", "月與日要補零");
});

test("classifyDue 分成逾期、今日、之後", () => {
  assert.equal(r.classifyDue("2026-08-23", TODAY), r.DUE.OVERDUE);
  assert.equal(r.classifyDue(TODAY, TODAY), r.DUE.TODAY);
  assert.equal(r.classifyDue("2026-08-25", TODAY), r.DUE.LATER);
});

test("沒有到期日或格式不明的一律不提醒", () => {
  for(const bad of [null, undefined, "", "8/24", "2026-8-24", 20260824, {}]){
    assert.equal(r.classifyDue(bad, TODAY), r.DUE.NONE);
  }
});

test("pendingSteps 只留還需要行動且有到期日的", () => {
  const steps = [
    step("s1", "2026-08-23"),
    step("s2", null),
    step("s3", "2026-08-23", STEP_STATE.DONE),
    step("s4", "2026-08-23", STEP_STATE.NOTE),
    step("s5", "2026-08-23", STEP_STATE.DEFERRED),
    step("s6", "2026-08-23", STEP_STATE.SCHEDULED),
  ];
  assert.deepEqual(r.pendingSteps(steps).map(s => s.id), ["s1", "s5", "s6"]);
});

test("pendingQuests 排除完成、封存與每日習慣", () => {
  const quests = [
    quest("q1", "2026-08-23"),
    quest("q2", "2026-08-23", {done: true}),
    quest("q3", "2026-08-23", {archived: true}),
    quest("q4", "2026-08-23", {type: "daily"}),
    quest("q5", ""),
    quest("q6", "2026-08-23", {type: "side"}),
  ];
  assert.deepEqual(r.pendingQuests(quests).map(q => q.id), ["q1", "q6"]);
});

test("stepsInScope 只留進行中目標的步驟與收件匣項目", () => {
  const goals = [
    {id: "g1", title: "進行中", why: "", status: "active"},
    {id: "g2", title: "已封存", why: "", status: "archived"},
    {id: "g3", title: "已完成", why: "", status: "done"},
  ];
  const steps = [
    {...step("s1", "2026-08-20"), goalId: "g1"},
    {...step("s2", "2026-08-20"), goalId: "g2"},
    {...step("s3", "2026-08-20"), goalId: "g3"},
    {...step("s4", "2026-08-20"), goalId: null},
    {...step("s5", "2026-08-20"), goalId: "不存在的目標"},
  ];
  assert.deepEqual(r.stepsInScope(steps, goals).map(s => s.id), ["s1", "s4"]);
});

test("沒有給 goals 時只留收件匣項目", () => {
  const steps = [{...step("s1", "2026-08-20"), goalId: "g1"}, {...step("s2", "2026-08-20"), goalId: null}];
  assert.deepEqual(r.stepsInScope(steps, []).map(s => s.id), ["s2"]);
  assert.deepEqual(r.stepsInScope(steps, undefined).map(s => s.id), ["s2"]);
});

test("封存目標之後，它的逾期步驟不再計入 badge", () => {
  const steps = [{...step("s1", "2026-08-20"), goalId: "g1"}];
  const active = [{id: "g1", title: "x", why: "", status: "active"}];
  const archived = [{id: "g1", title: "x", why: "", status: "archived"}];
  assert.equal(r.collectDue({steps, goals: active, today: TODAY}).count, 1);
  assert.equal(r.collectDue({steps, goals: archived, today: TODAY}).count, 0,
    "封存後不該再替它計數，否則與今日／目標檢視不一致");
});

test("collectDue 同時涵蓋 Step 與 Quest，只取逾期與今日到期", () => {
  const due = r.collectDue({
    steps: [step("s1", "2026-08-20"), step("s2", TODAY), step("s3", "2026-09-01")],
    goals: [{id: "g1", title: "x", why: "", status: "active"}],
    quests: [quest("q1", "2026-08-19"), quest("q2", TODAY), quest("q3", "2026-12-01")],
    today: TODAY,
  });
  assert.deepEqual(due.overdue.map(i => i.id), ["s1", "q1"]);
  assert.deepEqual(due.dueToday.map(i => i.id), ["s2", "q2"]);
  assert.equal(due.count, 4, "之後才到期的不計入");
  assert.deepEqual([...new Set(due.items.map(i => i.kind))], ["step", "quest"]);
});

test("collectDue 在沒有資料時回 0，不丟例外", () => {
  assert.equal(r.collectDue({today: TODAY}).count, 0);
  assert.equal(r.collectDue({steps: [], quests: [], today: TODAY}).count, 0);
});

test("summarize 只描述有東西的分類", () => {
  const mk = (o, t) => ({overdue: Array(o).fill({}), dueToday: Array(t).fill({})});
  assert.equal(r.summarize(mk(2, 3)), "2 件逾期、3 件今日到期");
  assert.equal(r.summarize(mk(2, 0)), "2 件逾期");
  assert.equal(r.summarize(mk(0, 3)), "3 件今日到期");
  assert.equal(r.summarize(mk(0, 0)), "");
});

test("shouldNotify 同一天只在件數增加時再提醒", () => {
  assert.equal(r.shouldNotify(null, TODAY, 0), false, "沒有到期就不提醒");
  assert.equal(r.shouldNotify(null, TODAY, 2), true, "第一次要提醒");
  assert.equal(r.shouldNotify({date: TODAY, count: 2}, TODAY, 2), false, "件數沒變不重複");
  assert.equal(r.shouldNotify({date: TODAY, count: 2}, TODAY, 1), false, "件數減少不提醒");
  assert.equal(r.shouldNotify({date: TODAY, count: 2}, TODAY, 3), true, "件數增加要提醒");
  assert.equal(r.shouldNotify({date: "2026-08-23", count: 5}, TODAY, 1), true, "換一天重新提醒");
});

// ── 偏好設定 ────────────────────────────────────────────────────────────────
function fakeBackend(seed){
  const m = new Map();
  if(seed !== undefined) m.set(r.PREFS_KEY, JSON.stringify(seed));
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => {m.set(k, String(v));},
    raw: () => JSON.parse(m.get(r.PREFS_KEY)),
  };
}

test("偏好預設為關閉，且寫入後可重新讀回", () => {
  const b = fakeBackend();
  const p = r.createPrefs(b);
  assert.deepEqual(p.get(), {enabled: false, lastNotified: null});

  p.setEnabled(true);
  p.setLastNotified({date: TODAY, count: 3});
  assert.equal(b.raw().enabled, true);

  const again = r.createPrefs(b);
  assert.equal(again.get().enabled, true);
  assert.deepEqual(again.get().lastNotified, {date: TODAY, count: 3});
});

test("偏好回傳複本，外部改動不會污染", () => {
  const p = r.createPrefs(fakeBackend());
  p.setLastNotified({date: TODAY, count: 3});
  p.get().lastNotified.count = 99;
  p.get().enabled = true;
  assert.equal(p.get().lastNotified.count, 3);
  assert.equal(p.get().enabled, false);
});

test("損毀或不合法的偏好資料退回預設值，不丟例外", () => {
  assert.doesNotThrow(() => r.createPrefs({getItem: () => "{ 壞掉", setItem: () => {}}));
  assert.equal(r.createPrefs({getItem: () => "{ 壞掉", setItem: () => {}}).get().enabled, false);
  // enabled 只認 true；lastNotified 日期格式不合就丟掉
  const p = r.createPrefs(fakeBackend({enabled: "yes", lastNotified: {date: "昨天", count: 1}}));
  assert.equal(p.get().enabled, false);
  assert.equal(p.get().lastNotified, null);
});

test("disable 會清掉上次提醒紀錄，重新開啟時不會被舊紀錄壓住", () => {
  const b = fakeBackend();
  const p = r.createPrefs(b);
  p.setEnabled(true);
  p.setLastNotified({date: TODAY, count: 5});
  p.setEnabled(false);
  p.setLastNotified(null);
  assert.equal(p.get().lastNotified, null);
  assert.equal(r.shouldNotify(p.get().lastNotified, TODAY, 1), true);
});

// ── 轉接層在沒有瀏覽器 API 的環境要安全降級 ─────────────────────────────────
test("Node 環境下 badge 與通知一律回報不支援，不丟例外", async () => {
  assert.equal(r.badgeSupported(), false);
  assert.equal(await r.setBadge(3), "unsupported");
  assert.equal(r.notificationsSupported(), false);
  assert.equal(r.permissionState(), "unsupported");
  assert.equal(await r.requestPermission(), "unsupported");
  assert.equal(await r.showDueNotification("x", 1), false);
});

test("createReminders 在資料源出錯時回 null 而不是拋錯", async () => {
  const broken = {getState(){throw new Error("boom");}};
  const rem = r.createReminders(broken, r.createPrefs(fakeBackend()));
  assert.equal(await rem.refresh([]), null);
});

test("createReminders.refresh 回傳當下的到期統計", async () => {
  const store = {getState: () => ({
    steps: [step("s1", "2020-01-01"), step("s2", "2099-01-01")],
    goals: [{id: "g1", title: "x", why: "", status: "active"}],
  })};
  const rem = r.createReminders(store, r.createPrefs(fakeBackend()));
  const due = await rem.refresh([quest("q1", "2020-01-01")]);
  assert.equal(due.count, 2);
  assert.deepEqual(due.overdue.map(i => i.id), ["s1", "q1"]);
});

test("status 反映偏好與環境能力", () => {
  const rem = r.createReminders({getState: () => ({steps: [], goals: []})}, r.createPrefs(fakeBackend({enabled: true})));
  assert.deepEqual(rem.status(), {enabled: true, permission: "unsupported", badgeSupported: false});
});

test("放棄的步驟不計入 badge", () => {
  const dropped = {...step("s1", "2020-01-01"), goalId: "g1", state: STEP_STATE.DROPPED};
  const open = {...step("s2", "2020-01-01"), goalId: "g1"};
  const goals = [{id: "g1", title: "x", why: "", status: "active"}];
  assert.deepEqual(
    r.collectDue({steps: [dropped, open], goals, today: TODAY}).items.map(i => i.id),
    ["s2"]);
});
