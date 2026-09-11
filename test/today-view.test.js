// 今日頁的渲染。render() 只組字串、不碰 DOM，所以能直接在測試裡驗。
import {test} from "node:test";
import assert from "node:assert/strict";
import {createStore} from "../src/store.js";
import {createTodayView} from "../src/today-view.js";
import {logicalToday} from "../src/rpg.js";
import * as m from "../src/model.js";

function backend(){
  const map = new Map();
  return {getItem: k => (map.has(k) ? map.get(k) : null),
          setItem: (k, v) => {map.set(k, String(v));}};
}

function seeded(){
  const store = createStore(backend());
  store.load();
  const goal = store.addGoal({title: "做出第一版", coreId: "think"});
  const step = store.addStep({goalId: goal.id, title: "寫下規格", kind: m.STEP_KIND.MAIN});
  const view = createTodayView(store);
  return {store, goal, step, view};
}

test("目標被封存後，它底下的日常維持就不再出現在今日頁", () => {
  const {store, goal, view} = seeded();
  store.addStep({goalId: goal.id, title: "睡前記錄一句", kind: m.STEP_KIND.DAILY});
  assert.ok(view.render().includes("睡前記錄一句"), "進行中的目標照常顯示");

  store.setGoalStatus(goal.id, m.GOAL_STATUS.ARCHIVED);
  const html = view.render();
  assert.ok(!html.includes("睡前記錄一句"),
            "封存目標底下的每日任務不該還留著一個能拿 XP 的打卡鈕");
  assert.ok(!html.includes('data-tact="daily"'));
});

test("沒有綁目標的日常維持不受影響", () => {
  const {store, view} = seeded();
  const skill = store.getState().skills.find(s => s.id === m.generalSkillId("body"));
  store.addStep({title: "喝水", kind: m.STEP_KIND.DAILY,
                 rewards: [{skillId: skill.id, xp: 5}]});
  assert.ok(view.render().includes("喝水"));
});

test("班表設定好之後仍然改得動", () => {
  const {store, view} = seeded();
  assert.ok(view.render().includes('data-tact="save-anchor"'), "還沒設定時直接顯示表單");

  store.setPlannerConfig({anchorDate: m.shiftDate(logicalToday(), -1), anchorPhase: 0});
  const html = view.render();
  assert.ok(html.includes('data-tact="fold-anchor"'),
            "設定過之後仍要有編輯入口，否則日期選錯就再也改不回來");
});

test("使用者輸入一律跳脫，不會被當成標記渲染", () => {
  const {store, view} = seeded();
  const goal = store.addGoal({title: '<img src=x onerror="alert(1)">', coreId: "think"});
  store.addStep({goalId: goal.id, title: "正常步驟", kind: m.STEP_KIND.MAIN});
  const html = view.render();
  assert.ok(!html.includes("<img src=x"), "原樣的標記不得進 innerHTML");
  assert.ok(html.includes("&lt;img src=x"));
});
