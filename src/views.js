// ── 目標檢視 ─────────────────────────────────────────────────────────────────
// 今日 / 目標 / 收件匣三個檢視。資料一律經由 store 取得，不直接碰 localStorage。

import {createStore} from "./store.js";
import {STEP_STATE, STEP_STATE_LABEL, GOAL_STATUS, isStalling, DEFER_WARN_THRESHOLD} from "./model.js";
import {createReminders, todayISO} from "./reminders.js";

const store = createStore();
const reminders = createReminders(store);

let sub = "today";            // today | goals | inbox
const expanded = new Set();   // 展開完整步驟清單的目標 id

// ── 工具 ─────────────────────────────────────────────────────────────────────
function esc(v){
  return String(v ?? "").replace(/[&<>"']/g, c =>
    ({"&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"}[c]));
}

function toast(msg){
  if(typeof window !== "undefined" && typeof window.showToast === "function") window.showToast(msg);
}

function repaint(){
  if(typeof window !== "undefined" && typeof window.render === "function") window.render();
}

function dueClass(due){
  if(!due) return "";
  const today = todayISO();
  if(due < today) return "overdue";
  if(due === today) return "soon";
  return "ok";
}

function dueLabel(due){
  if(!due) return "";
  const cls = dueClass(due);
  const text = cls === "overdue" ? `⚠ ${due}` : cls === "soon" ? `今日 ${due}` : due;
  return `<span class="quest-due ${cls}">${esc(text)}</span>`;
}

function glyph(state){
  return `<span class="bujo-glyph" title="${esc(STEP_STATE_LABEL[state] || "")}">${esc(state)}</span>`;
}

// 順延次數只在達到門檻時才顯示——一兩次是常態，顯示出來只會變成雜訊
function deferTag(step){
  if(!isStalling(step)) return "";
  return `<span class="defer-tag" title="已順延 ${step.deferCount} 次">↻${step.deferCount}</span>`;
}

// id 一律走 data 屬性交給委派監聽，不插進可執行的 inline handler 字串裡。
function stepActions(id){
  const q = esc(id);
  return `<div class="step-actions">
    <button class="step-btn done" data-act="complete" data-id="${q}">完成</button>
    <button class="step-btn" data-act="defer" data-id="${q}">順延</button>
    <button class="step-btn" data-act="schedule" data-id="${q}">排程</button>
    <button class="step-btn drop" data-act="drop" data-id="${q}">放棄</button>
  </div>`;
}

// ── 今日 ─────────────────────────────────────────────────────────────────────
function renderToday(){
  const rows = store.todayList();
  if(rows.length === 0){
    return `<div class="empty-state">今天沒有待進行的下一步<br><small>到「目標」新增目標與步驟</small></div>`;
  }
  return rows.map(({goal, step}) => `<div class="step-card">
    <div class="step-main">
      ${glyph(step.state)}
      <div class="step-text">
        <div class="step-title">${esc(step.title)}${deferTag(step)}</div>
        <div class="step-goal">${esc(goal.title)}</div>
      </div>
      ${dueLabel(step.due)}
    </div>
    ${stepActions(step.id)}
  </div>`).join("");
}

// ── 目標 ─────────────────────────────────────────────────────────────────────
function renderGoalCard(goal){
  const next = store.nextStep(goal.id);
  const progress = store.goalProgress(goal.id);
  const isOpen = expanded.has(goal.id);
  const q = esc(goal.id);

  // 核心規則：預設只顯示一個下一步，其餘收合，避免清單膨脹。
  let body;
  if(isOpen){
    body = store.goalSteps(goal.id).map(s => `<div class="step-row ${s.state === STEP_STATE.DONE || s.state === STEP_STATE.DROPPED ? "is-done" : ""}">
      ${glyph(s.state)}
      <span class="step-row-title">${esc(s.title)}${deferTag(s)}</span>
      ${dueLabel(s.due)}
    </div>`).join("") || `<div class="step-row muted">尚無步驟</div>`;
  }else if(next){
    body = `<div class="step-main next">
      ${glyph(next.state)}
      <div class="step-text">
        <div class="step-title">${esc(next.title)}${deferTag(next)}</div>
        <div class="step-goal">下一步</div>
      </div>
      ${dueLabel(next.due)}
    </div>${stepActions(next.id)}`;
  }else{
    body = `<div class="step-row muted">${progress.total === 0 ? "尚無步驟" : "全部完成 🎉"}</div>`;
  }

  const hidden = isOpen ? 0 : Math.max(progress.total - (next ? 1 : 0), 0);

  return `<div class="goal-card">
    <div class="goal-head">
      <div>
        <div class="goal-title">${esc(goal.title)}</div>
        ${goal.why ? `<div class="goal-why">${esc(goal.why)}</div>` : ""}
      </div>
      <div class="goal-count">${progress.done}/${progress.total}</div>
    </div>
    ${body}
    <div class="goal-foot">
      <button class="step-btn" data-act="add-step" data-id="${q}">＋ 步驟</button>
      ${hidden > 0 ? `<button class="step-btn" data-act="toggle" data-id="${q}">其餘 ${hidden} 項</button>` : ""}
      ${isOpen ? `<button class="step-btn" data-act="toggle" data-id="${q}">收合</button>` : ""}
      <button class="step-btn" data-act="archive" data-id="${q}">封存</button>
    </div>
  </div>`;
}

function renderGoals(){
  const goals = store.getState().goals.filter(g => g.status === GOAL_STATUS.ACTIVE);
  const add = `<button class="goal-add" data-act="add-goal">＋ 新增目標</button>`;
  if(goals.length === 0){
    return `${add}<div class="empty-state">尚未建立目標<br><small>每個目標同時只會顯示一個下一步</small></div>`;
  }
  return add + goals.map(renderGoalCard).join("");
}

// ── 收件匣 ───────────────────────────────────────────────────────────────────
function renderInbox(){
  const items = store.inboxSteps().filter(s => s.state !== STEP_STATE.DONE);
  const goals = store.getState().goals.filter(g => g.status === GOAL_STATUS.ACTIVE);

  const capture = `<div class="inbox-capture">
    <input id="inbox-input" type="text" placeholder="快速捕捉…" autocomplete="off"/>
    <button class="step-btn done" data-act="capture">加入</button>
  </div>`;

  if(items.length === 0){
    return `${capture}<div class="empty-state">收件匣是空的<br><small>想到什麼先丟進來，之後再歸入目標</small></div>`;
  }

  const options = goals.map(g => `<option value="${esc(g.id)}">${esc(g.title)}</option>`).join("");

  return capture + items.map(s => `<div class="step-card">
    <div class="step-main">
      ${glyph(s.state)}
      <div class="step-text"><div class="step-title">${esc(s.title)}</div></div>
    </div>
    <div class="step-actions">
      ${goals.length
        ? `<select class="step-select" data-act="assign" data-id="${esc(s.id)}">
             <option value="">歸入目標…</option>${options}
           </select>`
        : `<span class="step-hint">先建立一個目標</span>`}
      <button class="step-btn done" data-act="complete" data-id="${esc(s.id)}">完成</button>
    </div>
  </div>`).join("");
}

// ── 回顧 ─────────────────────────────────────────────────────────────────────
function reviewStepRow(s, note){
  return `<div class="step-card">
    <div class="step-main">
      ${glyph(s.state)}
      <div class="step-text">
        <div class="step-title">${esc(s.title)}${deferTag(s)}</div>
        <div class="step-goal">${esc(note)}</div>
      </div>
      ${dueLabel(s.due)}
    </div>
    ${stepActions(s.id)}
  </div>`;
}

function renderReview(){
  const r = store.reviewItems(todayISO());
  if(r.total === 0){
    return `<div class="empty-state">沒有需要重新決定的事<br><small>順延 ${DEFER_WARN_THRESHOLD} 次以上、逾期過久，或失去下一步的目標會出現在這裡</small></div>`;
  }

  const section = (title, hint, body) =>
    `<div class="review-section">
      <div class="review-head">${esc(title)}</div>
      <div class="review-hint">${esc(hint)}</div>
      ${body}
    </div>`;

  let out = "";

  if(r.stalling.length){
    out += section(`反覆順延（${r.stalling.length}）`,
      "一直推遲通常代表這一步太大、時機不對，或其實不重要。拆小、排定日期，或放棄。",
      r.stalling.map(s => reviewStepRow(s, `已順延 ${s.deferCount} 次`)).join(""));
  }

  if(r.longOverdue.length){
    out += section(`逾期過久（${r.longOverdue.length}）`,
      "已經過期一段時間了。重新排一個做得到的日期，或承認它不會發生。",
      r.longOverdue.map(s => reviewStepRow(s, `到期日 ${s.due}`)).join(""));
  }

  if(r.stalledGoals.length){
    out += section(`失去下一步的目標（${r.stalledGoals.length}）`,
      "沒有任何可行動的步驟。補一步，或把目標收掉。",
      r.stalledGoals.map(g => {
        const p = store.goalProgress(g.id);
        const q = esc(g.id);
        return `<div class="goal-card">
          <div class="goal-head">
            <div>
              <div class="goal-title">${esc(g.title)}</div>
              ${g.why ? `<div class="goal-why">${esc(g.why)}</div>` : ""}
            </div>
            <div class="goal-count">${p.done}/${p.total}</div>
          </div>
          <div class="step-row muted">${p.total === 0 ? "尚無步驟" : "沒有可行動的下一步"}</div>
          <div class="goal-foot">
            <button class="step-btn" data-act="add-step" data-id="${q}">＋ 步驟</button>
            <button class="step-btn" data-act="archive" data-id="${q}">封存</button>
          </div>
        </div>`;
      }).join(""));
  }

  return out;
}

// ── 進入點 ───────────────────────────────────────────────────────────────────
function render(){
  const tabs = [
    {k: "today", label: "今日"},
    {k: "goals", label: "目標"},
    {k: "inbox", label: "收件匣"},
    {k: "review", label: "回顧"},
  ].map(t => `<button class="qtab ${sub === t.k ? "active" : ""}"
    style="${sub === t.k ? "background:#4a9eff22;border-color:#4a9eff;color:#4a9eff" : ""}"
    data-act="sub" data-sub="${t.k}">${t.label}</button>`).join("");

  const body = sub === "goals" ? renderGoals()
    : sub === "inbox" ? renderInbox()
    : sub === "review" ? renderReview()
    : renderToday();
  return `<div class="quest-tabs">${tabs}</div>${body}`;
}

// window.Goals：供 index.html 的 onclick 與 render() 呼叫
const api = {
  render,

  setSub(next){sub = next; repaint();},

  toggle(goalId){
    if(expanded.has(goalId)) expanded.delete(goalId);
    else expanded.add(goalId);
    repaint();
  },

  addGoal(){
    const title = prompt("目標是什麼？");
    if(!title || !title.trim()) return;
    const why = prompt("為什麼要做這件事？（可留空）") || "";
    store.addGoal({title, why});
    sub = "goals";
    toast("✓ 已新增目標");
    repaint();
  },

  addStep(goalId){
    const title = prompt("下一步要做什麼？");
    if(!title || !title.trim()) return;
    store.addStep({goalId, title});
    toast("✓ 已新增步驟");
    repaint();
  },

  capture(){
    const el = document.getElementById("inbox-input");
    const title = el && el.value;
    if(!title || !title.trim()) return;
    store.addStep({title});
    if(el) el.value = "";
    repaint();
  },

  complete(id){store.completeStep(id); toast("✓ 完成"); repaint();},

  defer(id){
    const s = store.deferStep(id);
    toast(isStalling(s) ? `> 已順延（第 ${s.deferCount} 次）` : "> 已順延");
    repaint();
  },

  drop(id){
    if(!confirm("放棄這個步驟？它會留下紀錄但不再需要行動。")) return;
    store.dropStep(id);
    toast("~ 已放棄");
    repaint();
  },

  schedule(id){
    const due = prompt("排到哪一天？（YYYY-MM-DD，留空取消）", todayISO());
    if(!due || !due.trim()) return;
    try{
      store.scheduleStep(id, due.trim());
      toast("< 已排程");
      repaint();
    }catch(err){
      alert(err.message);
    }
  },

  assign(id, goalId){
    if(!goalId) return;
    store.assignStep(id, goalId);
    toast("✓ 已歸入目標");
    repaint();
  },

  archive(goalId){
    if(!confirm("封存這個目標？封存後不會出現在今日與目標清單。")) return;
    store.setGoalStatus(goalId, GOAL_STATUS.ARCHIVED);
    toast("已封存");
    repaint();
  },

  // 與既有的備份匯出 / 匯入串接
  exportPayload(){return store.toJSON();},
  importPayload(data){store.replaceAll(data);},
};

// 事件委派：#content 這個元素本身在每次 render 都存在（只有 innerHTML 被換掉），
// 所以監聽掛一次就夠，也不會干擾其他分頁自己的 inline handler。
function bind(root){
  root.addEventListener("click", e => {
    const el = e.target.closest("[data-act]");
    if(!el || !root.contains(el)) return;
    const {act, id, sub: target} = el.dataset;
    if(act === "sub") return api.setSub(target);
    if(act === "add-goal") return api.addGoal();
    if(act === "capture") return api.capture();
    if(act === "complete") return api.complete(id);
    if(act === "defer") return api.defer(id);
    if(act === "drop") return api.drop(id);
    if(act === "schedule") return api.schedule(id);
    if(act === "add-step") return api.addStep(id);
    if(act === "toggle") return api.toggle(id);
    if(act === "archive") return api.archive(id);
  });

  root.addEventListener("change", e => {
    const el = e.target.closest('[data-act="assign"]');
    if(el && root.contains(el)) api.assign(el.dataset.id, el.value);
  });

  root.addEventListener("keydown", e => {
    if(e.key === "Enter" && e.target.id === "inbox-input") api.capture();
  });
}

export function install(){
  store.load();
  if(typeof window !== "undefined"){
    window.Goals = api;
    window.Reminders = reminders;
    const root = document.getElementById("content");
    if(root) bind(root);
  }
  return api;
}
