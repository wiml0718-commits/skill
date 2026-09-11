// ── 今日頁 ───────────────────────────────────────────────────────────────────
// 班表、精力與時間、唯一主線、成果表單。所有讀寫都經由傳進來的 store，
// 這裡不碰 localStorage、不自己發 XP、也不決定「今天是哪一天」。
// 規則見 docs/TODAY_PLAN.md。

import {ATTENDANCE, ENERGY, DAY_MODE, OUTCOME, STEP_KIND,
        GOAL_STATUS, MINUTE_CHOICES, MAX_MINUTES, PLANNER_LIMITS,
        isActionable, shiftDate, calcStreak, GOAL_BINDING_KEYS} from "./model.js";
import {logicalToday, resolveGrants} from "./rpg.js";
import {PHASE_LABEL, BINDING_LABEL,
        phaseForDate, scheduledAttendance, plannedAttendance, actualAttendance,
        actualStreak, projectedStreak, suggestForDay, defaultPlannedMinutes,
        resolveFocus, latestCheckpoint} from "./today-plan.js";

// 使用者輸入一律走這裡再進 innerHTML。views.js 也用同一份，不各自寫一個。
export function esc(v){
  return String(v ?? "").replace(/[&<>"']/g, c =>
    ({"&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"}[c]));
}

const ATTENDANCE_LABEL = {
  [ATTENDANCE.WORK]: "上班",
  [ATTENDANCE.OVERTIME]: "加班",
  [ATTENDANCE.REST]: "休息",
};
const ENERGY_LABEL = {[ENERGY.LOW]: "低", [ENERGY.MID]: "中", [ENERGY.HIGH]: "高"};
const WEEKDAY = ["日", "一", "二", "三", "四", "五", "六"];

function weekdayOf(iso){
  const [y, m, d] = iso.split("-").map(Number);
  return WEEKDAY[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

function shortDate(iso){
  const [, m, d] = iso.split("-");
  return `${Number(m)}/${Number(d)}`;
}

export function createTodayView(store){
  // ── 檢視狀態（不落地）──────────────────────────────────────────────────
  // 表單草稿留在記憶體：每次 render 都會換掉 innerHTML，寫在 DOM 裡的內容會
  // 連同錯誤訊息一起消失（§7）。
  const draft = {day: null, note: "", nextAction: "", url: "", confirmed: false};
  // 這一輪 render 讀到的狀態。子區塊需要目標清單時共用同一份，不重複讀 store。
  let lastState = null;
  let requestId = null;      // 這一次提交的重試識別，寫入失敗時不換
  let busy = false;          // 保存中：暫停重複送出
  let notice = null;         // {kind, text}
  let fieldError = null;     // {field, text}
  let openWeek = false;
  let openDaily = false;
  let openCriteria = false;
  let openSwitch = false;
  let openAnchor = false;
  // 已有紀錄時改 anchor 的二次確認。要連使用者剛選的日期與班別一起留著：
  // 重繪會把輸入欄依現有設定重建，只記天數的話按「確定要改」送出的是舊值。
  let anchorConfirm = null;   // {days, date, phase}
  let editingDate = null;
  let adjustingTime = false;

  function repaint(){
    if(typeof window !== "undefined" && typeof window.render === "function") window.render();
  }

  function say(kind, text){notice = {kind, text};}

  // 寫入失敗的共同出口。草稿留著、requestId 不換，使用者可以直接重試（§6.2）。
  const FAIL_TEXT = {
    conflict: "另一個分頁已經存了新的資料。這次開啟不會再寫入，請重新載入頁面後再試一次，草稿還在。",
    readonly: "目前是唯讀模式，尚未保存。請先處理載入時回報的資料問題。",
    unsupported: "存檔版本比這個版本新，尚未保存，也不會覆蓋原本的資料。",
    degraded: "讀不到儲存空間，尚未保存。",
    write: "尚未保存，請重試。儲存空間可能已滿。",
    serialize: "尚未保存，請重試。",
    read: "尚未保存，請重試。",
  };

  function failed(res){
    if(res.reason === "invalid"){
      fieldError = {field: res.field || null, text: res.message};
      say("error", res.message);
      return;
    }
    say("error", FAIL_TEXT[res.reason] || "尚未保存，請重試。");
  }

  // ── 讀資料 ───────────────────────────────────────────────────────────────
  function snapshot(){
    const state = store.getState();
    const today = logicalToday();
    const planner = state.planner;
    const day = planner.days[today] || null;
    return {state, planner, today, day};
  }

  // ── 1. 日期與班別 ────────────────────────────────────────────────────────
  function renderHeader({planner, today, day}){
    const phase = phaseForDate(planner.config, today);
    const scheduled = scheduledAttendance(planner.config, today);
    const plan = plannedAttendance(planner, today);
    const actual = actualAttendance(planner, today);
    const run = actualStreak(planner, today);
    const projected = projectedStreak(planner, today);

    const shiftText = phase === null
      ? "尚未設定四日班表"
      : `${PHASE_LABEL[phase]}・原排${ATTENDANCE_LABEL[scheduled]}`;
    const planText = plan ? ATTENDANCE_LABEL[plan] : "未設定";
    const overridden = !!(day && day.attendancePlan);

    const actualText = actual
      ? `已確認${ATTENDANCE_LABEL[actual]}`
      : "今天出勤待確認";

    const runText = !run.todayConfirmed
      ? (run.count > 0
          ? `今天出勤待確認，到昨天為止${run.exact ? "" : "至少"}連上 ${run.count} 天`
          : "今天出勤待確認")
      : run.todayRest
        ? "今天休息，連續出勤中斷"
        : `${run.exact ? "" : "至少"}連上 ${run.count} 天`;

    const projText = projected.unknown
      ? "班表還沒設定完，暫時無法預估後續"
      : `這段${projected.exact ? "" : "至少"}預計連上 ${projected.count} 天`
        + `（查到 ${projected.horizonEnd}${projected.ongoing ? "、仍持續中" : ""}）`;

    const confirmBtn = (value, label) => `<button class="today-btn ${actual === value ? "on" : ""}"
      data-tact="actual" data-value="${value}">${label}</button>`;

    const yesterday = shiftDate(today, -1);
    const yActual = actualAttendance(planner, yesterday);

    return `<section class="today-card">
      <div class="today-date">${today}（${weekdayOf(today)}）</div>
      <div class="today-shift">${esc(shiftText)}</div>
      <div class="today-line">今天安排：<b>${esc(planText)}</b>${overridden ? "（本日覆寫）" : ""}</div>
      <div class="today-line">${esc(actualText)}</div>
      <div class="today-streak">${esc(runText)}<br><span class="today-muted">${esc(projText)}</span></div>
      <div class="today-row" role="group" aria-label="確認今天的實際出勤">
        ${confirmBtn(ATTENDANCE.WORK, "確認上班")}
        ${confirmBtn(ATTENDANCE.OVERTIME, "確認加班")}
        ${confirmBtn(ATTENDANCE.REST, "確認休息")}
      </div>
      ${yActual ? "" : `<div class="today-row">
        <button class="today-btn ghost" data-tact="actual-yesterday" data-value="${ATTENDANCE.WORK}">昨天也上班了</button>
        <button class="today-btn ghost" data-tact="actual-yesterday" data-value="${ATTENDANCE.REST}">昨天休息</button>
      </div>`}
      ${renderAnchorSetup(planner, today, phase)}
    </section>`;
  }

  // 班表設定。設定不是必填：沒設定就顯示未知，仍可手動排今天。設定過之後也要
  // 改得動——日期或班別選錯的話，這是唯一能修正的地方。
  function renderAnchorSetup(planner, today, phase){
    // 二次確認期間一定要展開：收起來的話，說明與「確定要改」就跟著消失了。
    if(phase !== null && !openAnchor && !anchorConfirm){
      return `<div class="today-row">
        <button class="today-btn ghost" data-tact="fold-anchor">編輯四日班表</button>
      </div>`;
    }
    const config = planner.config;
    // 二次確認期間顯示的是待確認的提案，不是目前生效的設定。
    const date = (anchorConfirm && anchorConfirm.date) || config.anchorDate || today;
    const selected = anchorConfirm ? anchorConfirm.phase : config.anchorPhase;
    const options = PHASE_LABEL.map((label, i) =>
      `<option value="${i}" ${selected === i ? "selected" : ""}>${esc(label)}</option>`
    ).join("");
    return `<div class="today-setup">
      <div class="today-muted">四日班表：選一個日期，並指出那天是循環的哪一天。</div>
      <div class="today-row">
        <input class="today-input" type="date" id="today-anchor-date" value="${date}" aria-label="班表起算日"/>
        <select class="today-input" id="today-anchor-phase" aria-label="起算日的班別">${options}</select>
      </div>
      <div class="today-row">
        <button class="today-btn" data-tact="save-anchor">儲存班表</button>
        ${phase === null ? "" : `<button class="today-btn ghost" data-tact="fold-anchor">取消</button>`}
      </div>
      ${anchorConfirm ? `<div class="today-editor">
        <div class="today-err" role="alert">已經有 ${anchorConfirm.days} 天的紀錄。改成
          ${esc(anchorConfirm.date)}・${esc(PHASE_LABEL[anchorConfirm.phase] || "")}
          會讓過去的原定班別整批位移（實際出勤紀錄不受影響）。</div>
        <div class="today-row">
          <button class="today-btn primary" data-tact="save-anchor" data-force="1">確定要改</button>
          <button class="today-btn ghost" data-tact="cancel-anchor">維持原設定</button>
        </div>
      </div>` : ""}
    </div>`;
  }

  // ── 2. 一週班表（可收合）─────────────────────────────────────────────────
  function renderWeek({planner, today}){
    const head = `<button class="today-fold" data-tact="fold-week" aria-expanded="${openWeek}">
      ${openWeek ? "▾" : "▸"} 一週班表</button>`;
    if(!openWeek) return `<section class="today-card">${head}</section>`;

    const cells = [];
    for(let offset = -1; offset <= 5; offset++){
      const date = shiftDate(today, offset);
      const plan = plannedAttendance(planner, date);
      const actual = date <= today ? actualAttendance(planner, date) : null;
      const future = date > today;
      const text = actual
        ? ATTENDANCE_LABEL[actual]
        : plan ? `${future ? "預計" : ""}${ATTENDANCE_LABEL[plan]}` : "未設定";
      const cls = [date === today ? "is-today" : "", actual ? "is-actual" : "",
                   future ? "is-future" : ""].filter(Boolean).join(" ");
      cells.push(`<button class="today-cell ${cls}" data-tact="edit-day" data-date="${date}"
        aria-label="${date} ${esc(text)}">
        <span class="today-cell-date">${shortDate(date)}（${weekdayOf(date)}）</span>
        <span class="today-cell-text">${esc(text)}</span>
      </button>`);
    }

    return `<section class="today-card">
      ${head}
      <div class="today-week">${cells.join("")}</div>
      ${editingDate ? renderDayEditor(planner, today, editingDate) : ""}
      ${renderBindings(planner)}
    </section>`;
  }

  // 班表綁定：存的是 goalId，不從目標標題猜類別。可以只綁一個，也可以都不綁。
  function renderBindings(planner){
    const goals = lastState ? lastState.goals.filter(g => g.status === GOAL_STATUS.ACTIVE) : [];
    if(!goals.length) return "";
    const row = key => {
      const current = planner.config.goalBindings[key];
      const options = [`<option value="">未綁定</option>`].concat(goals.map(g =>
        `<option value="${esc(g.id)}" ${g.id === current ? "selected" : ""}>${esc(g.title)}</option>`));
      return `<label class="today-muted" for="today-bind-${key}">${esc(BINDING_LABEL[key])}</label>
        <select class="today-input" id="today-bind-${key}">${options.join("")}</select>`;
    };
    return `<div class="today-editor">
      <div class="today-muted">班表綁定：工作日 1／休假日 1 走前者，工作日 2／休假日 2 走後者。</div>
      ${GOAL_BINDING_KEYS.map(row).join("")}
      <div class="today-row"><button class="today-btn" data-tact="save-bindings">保存綁定</button></div>
    </div>`;
  }

  function renderDayEditor(planner, today, date){
    const future = date > today;
    const rec = planner.days[date] || null;
    const plan = rec && rec.attendancePlan;
    const btn = (value, label) => `<button class="today-btn ${plan === value ? "on" : ""}"
      data-tact="plan" data-date="${date}" data-value="${value}">${label}</button>`;
    const actual = rec && rec.attendanceActual;
    const actualBtn = (value, label) => `<button class="today-btn ${actual === value ? "on" : ""}"
      data-tact="actual-day" data-date="${date}" data-value="${value}">${label}</button>`;
    return `<div class="today-editor">
      <div class="today-muted">${date}（${weekdayOf(date)}）的安排</div>
      <div class="today-row">
        ${btn(ATTENDANCE.WORK, "上班")}${btn(ATTENDANCE.OVERTIME, "加班")}${btn(ATTENDANCE.REST, "休息")}
        <button class="today-btn ghost" data-tact="plan" data-date="${date}" data-value="">回原班表</button>
      </div>
      ${future
        ? `<div class="today-muted">未來只能規劃，不能確認實際出勤。</div>`
        : `<div class="today-muted">實際出勤</div>
           <div class="today-row">
             ${actualBtn(ATTENDANCE.WORK, "上班了")}${actualBtn(ATTENDANCE.OVERTIME, "加班了")}${actualBtn(ATTENDANCE.REST, "休息了")}
             <button class="today-btn ghost" data-tact="actual-day" data-date="${date}" data-value="">清除</button>
           </div>`}
      <div class="today-row"><button class="today-btn ghost" data-tact="close-editor">收起</button></div>
    </div>`;
  }

  // ── 3. 精力與可用時間 ────────────────────────────────────────────────────
  function renderEnergy({planner, today, day}){
    const suggestion = suggestForDay(planner, today, today);
    const energy = day ? day.energy : null;
    const available = day ? day.availableMinutes : null;
    const eBtn = (value, label) => `<button class="today-btn ${energy === value ? "on" : ""}"
      data-tact="energy" data-value="${value}">${label}</button>`;
    const mBtn = value => `<button class="today-btn ${available === value ? "on" : ""}"
      data-tact="available" data-value="${value}">${value} 分</button>`;
    return `<section class="today-card">
      <div class="today-label">今天的精力${energy ? "" : "（未填，建議暫以中等計算）"}</div>
      <div class="today-row">${eBtn(ENERGY.LOW, "低")}${eBtn(ENERGY.MID, "中")}${eBtn(ENERGY.HIGH, "高")}</div>
      <div class="today-label">可用時間${available === null ? "（未填）" : ""}</div>
      <div class="today-row">${MINUTE_CHOICES.map(mBtn).join("")}</div>
      <div class="today-row">
        <input class="today-input" type="number" id="today-available" min="0" max="${MAX_MINUTES}"
          inputmode="numeric" placeholder="自訂 0–${MAX_MINUTES}"
          value="${available === null ? "" : available}" aria-label="自訂可用時間（分鐘）"/>
        <button class="today-btn" data-tact="available-custom">套用</button>
      </div>
      <div class="today-muted">建議一段主線時間：${suggestion.minutes} 分鐘
        ${suggestion.energyFilled ? "" : "（精力未填）"}</div>
    </section>`;
  }

  // ── 4. 唯一主線 ──────────────────────────────────────────────────────────
  const ISSUE_TEXT = {
    "goal-missing": "今天接受的目標已經不在了。請重新選一個要推進的目標。",
    "goal-inactive": "今天接受的目標已經完成或封存。請重新選一個要推進的目標。",
    "step-missing": "今天接受的步驟已經不在了。請重新選一個下一步。",
    "no-next-step": "這個目標沒有可行動的主線下一步。到「全部任務」補一步。",
    "no-binding": "這一天的班表還沒綁定目標。先手動挑一個進行中的目標。",
    "no-goal": "還沒有進行中的目標。到「目標」頁新增一個。",
  };

  function grantText(state, step){
    const grants = resolveGrants(step, {goals: state.goals, skills: state.skills});
    return grants.map(g => {
      const skill = g.skillId ? state.skills.find(s => s.id === g.skillId) : null;
      const core = skill ? state.cores.find(c => c.id === skill.coreId) : null;
      const where = skill ? `${core ? core.name + "・" : ""}${skill.name}` : "未歸屬";
      return `${where} +${g.xp} XP`;
    }).join("、");
  }

  function renderFocus({state, planner, today, day}, focus){
    if(!focus.step){
      const hint = ISSUE_TEXT[focus.issue] || "目前沒有可以進行的主線。";
      return `<section class="today-card">
        <div class="today-label">今日主線</div>
        <div class="empty-state">${esc(hint)}</div>
        ${renderGoalPicker(state, "選一個目標")}
      </section>`;
    }

    const {goal, step} = focus;
    const detail = planner.stepDetails[step.id] || null;
    const suggestion = suggestForDay(planner, today, today);
    const available = day ? day.availableMinutes : null;
    const planned = day && day.plannedMinutes !== null
      ? day.plannedMinutes
      : defaultPlannedMinutes(available, suggestion.minutes);
    const accepted = focus.state === "accepted";
    const recovery = day && day.mode === DAY_MODE.RECOVERY;
    const checkpoint = latestCheckpoint(planner, step.id);

    const doneNote = focus.stepDone
      ? `<div class="today-done">上次接受的「${esc(focus.doneStep.title)}」已經完成了。這是同一個目標的下一步。</div>`
      : "";
    const resumeNote = focus.state === "resume"
      ? `<div class="today-muted">接續 ${focus.since} 開始的主線。</div>`
      : focus.state === "suggested" && focus.bindingKey
        ? `<div class="today-muted">依班表綁定：${esc(BINDING_LABEL[focus.bindingKey] || "")}</div>`
        : "";

    const firstAction = detail && detail.firstAction
      ? esc(detail.firstAction)
      : "先打開這個任務並確認第一步";
    const criteria = detail && detail.completionCriteria ? detail.completionCriteria : "";

    return `<section class="today-card focus">
      <div class="today-label">今日主線</div>
      ${doneNote}
      <div class="today-goal">${esc(goal.title)}</div>
      <div class="today-step">${esc(step.title)}</div>
      ${resumeNote}
      <div class="today-line">第一動作：${firstAction}</div>
      <div class="today-line">預計一段時間：<b>${planned} 分鐘</b>
        <span class="today-muted">（建議 ${suggestion.minutes}）</span></div>
      <div class="today-line today-muted">完成後：${esc(grantText(state, step))}</div>
      ${checkpoint ? `<div class="today-check">最近一次${checkpoint.outcome === OUTCOME.COMPLETE ? "已完成" : "停在"}：
        ${esc(checkpoint.outcome === OUTCOME.COMPLETE ? checkpoint.note : checkpoint.nextAction || checkpoint.note)}
        <span class="today-muted">（${checkpoint.day}）</span></div>` : ""}
      <button class="today-fold" data-tact="fold-criteria" aria-expanded="${openCriteria}">
        ${openCriteria ? "▾" : "▸"} 完成條件</button>
      ${openCriteria ? `<div class="today-editor">
        <textarea class="today-input" id="today-criteria" rows="2"
          maxlength="${PLANNER_LIMITS.stepDetail}" placeholder="怎樣才算完成？"
          aria-label="完成條件">${esc(criteria)}</textarea>
        <textarea class="today-input" id="today-first" rows="2"
          maxlength="${PLANNER_LIMITS.stepDetail}" placeholder="第一動作是什麼？"
          aria-label="第一動作">${esc(detail && detail.firstAction ? detail.firstAction : "")}</textarea>
        <div class="today-row"><button class="today-btn" data-tact="save-detail">保存說明</button></div>
      </div>` : ""}
      <div class="today-row">
        <button class="today-btn primary" data-tact="accept"
          data-goal="${esc(goal.id)}" data-step="${esc(step.id)}">
          ${accepted ? "接著做" : "開始"}</button>
        <button class="today-btn ghost" data-tact="adjust-time">調整本次時間</button>
      </div>
      ${adjustingTime ? renderTimeAdjust(available, planned) : ""}
      ${recovery ? `<div class="today-muted">今天已收工。重新選一段時間並開始，就會回到進行中。</div>` : ""}
      <div class="today-row">
        <button class="today-btn ghost" data-tact="fold-switch" aria-expanded="${openSwitch}">換主線</button>
        <button class="today-btn ghost" data-tact="stop">今天收工（0 分鐘）</button>
      </div>
      ${openSwitch ? renderGoalPicker(state, "換成哪一個目標？") : ""}
    </section>`;
  }

  function renderTimeAdjust(available, planned){
    const max = available === null ? MAX_MINUTES : available;
    const choices = [...new Set([...MINUTE_CHOICES.filter(m => m <= max), max])]
      .sort((a, b) => a - b);
    return `<div class="today-editor">
      <div class="today-muted">本次時間（上限 ${max} 分鐘）</div>
      <div class="today-row">${choices.map(m =>
        `<button class="today-btn ${planned === m ? "on" : ""}"
          data-tact="planned" data-value="${m}">${m} 分</button>`).join("")}</div>
    </div>`;
  }

  function renderGoalPicker(state, label){
    const goals = state.goals.filter(g => g.status === GOAL_STATUS.ACTIVE);
    if(!goals.length){
      return `<div class="today-editor"><div class="today-muted">還沒有進行中的目標。</div>
        <div class="today-row"><button class="today-btn ghost" data-tact="go-goals">到目標頁新增</button></div></div>`;
    }
    const options = goals.map(g => `<option value="${esc(g.id)}">${esc(g.title)}</option>`).join("");
    return `<div class="today-editor">
      <div class="today-muted">${esc(label)}</div>
      <select class="today-input" id="today-goal-pick" aria-label="${esc(label)}">${options}</select>
      <input class="today-input" id="today-reason" type="text" maxlength="${PLANNER_LIMITS.changeReason}"
        placeholder="更換原因（可留空）" aria-label="更換原因"/>
      <div class="today-row"><button class="today-btn" data-tact="switch-goal">換成這個</button></div>
    </div>`;
  }

  // ── 5. 成果表單 ──────────────────────────────────────────────────────────
  function renderOutcome({today}, focus){
    if(!focus.step || focus.state !== "accepted") return "";
    const err = field => (fieldError && fieldError.field === field
      ? `<div class="today-err" role="alert">${esc(fieldError.text)}</div>` : "");
    const crossed = draft.day && draft.day !== today
      ? `<div class="today-err" role="alert">已經過了換日時間，這次會記在 ${today}。</div>` : "";
    return `<section class="today-card">
      <div class="today-label">保存這次的成果</div>
      ${crossed}
      <textarea class="today-input" id="today-note" rows="3" maxlength="${PLANNER_LIMITS.note}"
        placeholder="這次做了什麼？" aria-label="這次做了什麼">${esc(draft.note)}</textarea>
      ${err("note")}
      <input class="today-input" id="today-next" type="text" maxlength="${PLANNER_LIMITS.nextAction}"
        placeholder="下一個動作是什麼？" aria-label="下一個動作" value="${esc(draft.nextAction)}"/>
      ${err("nextAction")}
      <input class="today-input" id="today-url" type="url" maxlength="${PLANNER_LIMITS.url}"
        placeholder="成果連結（選填，http/https）" aria-label="成果連結" value="${esc(draft.url)}"/>
      ${err("url")}
      <label class="today-check-row">
        <input type="checkbox" id="today-confirm" data-tact="confirm" ${draft.confirmed ? "checked" : ""}/>
        完成條件已達成（自述）
      </label>
      <div class="today-row">
        <button class="today-btn" data-tact="submit" data-outcome="${OUTCOME.PROGRESS}"
          ${busy ? "disabled" : ""}>保存進度</button>
        <button class="today-btn primary" data-tact="submit" data-outcome="${OUTCOME.COMPLETE}"
          ${busy || !draft.confirmed ? "disabled" : ""}>完成並記錄</button>
      </div>
      <div class="today-muted">成果文字由你自述，不代表系統驗證過。</div>
    </section>`;
  }

  // ── 6. 日常維持 ──────────────────────────────────────────────────────────
  function renderDaily({state, planner, today, day}){
    // 目標收掉之後，它底下的每日任務也跟著離開可行動範圍——任務頁與到期提醒
    // 都已經這樣做了。今日頁不跟上就會變成繼續替一個封存目標賺 XP 的側門。
    const activeGoals = new Set(state.goals
      .filter(g => g.status === GOAL_STATUS.ACTIVE).map(g => g.id));
    const items = state.steps.filter(s =>
      s.kind === STEP_KIND.DAILY && !s.archived
      && (s.goalId === null || activeGoals.has(s.goalId)));
    if(!items.length) return "";
    const suggestion = suggestForDay(planner, today, today);
    // 加班、低精力、收工時預設收合：它們是可選的，不是主線的前置條件（§5）。
    const collapse = suggestion.minutes <= 5 || (day && day.mode === DAY_MODE.RECOVERY);
    const shown = openDaily || !collapse;
    const head = `<button class="today-fold" data-tact="fold-daily" aria-expanded="${shown}">
      ${shown ? "▾" : "▸"} 日常維持（${items.length}）</button>`;
    if(!shown) return `<section class="today-card">${head}</section>`;
    const rows = items.map(s => {
      const done = s.streakHistory.includes(today);
      const streak = calcStreak(s.streakHistory, today);
      return `<div class="today-daily">
        <span>${esc(s.title)}${streak > 0 ? ` <span class="today-muted">連續 ${streak} 天</span>` : ""}</span>
        <button class="today-btn ${done ? "on" : ""}" data-tact="daily" data-id="${esc(s.id)}"
          ${done ? "disabled" : ""}>${done ? "今天已做" : "打卡"}</button>
      </div>`;
    }).join("");
    return `<section class="today-card">${head}${rows}</section>`;
  }

  // ── 進入點 ───────────────────────────────────────────────────────────────
  function render(){
    const snap = snapshot();
    lastState = snap.state;
    // 跨過 04:00 之後回到前景：草稿留著，但提交日期換成新的邏輯日（§3.1）。
    const focus = resolveFocus({planner: snap.planner, today: snap.today,
                                goals: snap.state.goals, steps: snap.state.steps});
    const bar = notice
      ? `<div class="today-notice ${notice.kind}" role="${notice.kind === "error" ? "alert" : "status"}"
           aria-live="polite">${esc(notice.text)}</div>`
      : `<div class="today-notice" aria-live="polite"></div>`;
    return `<div class="today-page">
      ${bar}
      ${renderHeader(snap)}
      ${renderWeek(snap)}
      ${renderEnergy(snap)}
      ${renderFocus(snap, focus)}
      ${renderOutcome(snap, focus)}
      ${renderDaily(snap)}
      <div class="today-row">
        <button class="today-btn ghost" data-tact="go-all">全部任務</button>
      </div>
    </div>`;
  }

  // ── 動作 ─────────────────────────────────────────────────────────────────
  function value(id){
    const el = typeof document !== "undefined" ? document.getElementById(id) : null;
    return el ? el.value : "";
  }

  function apply(res, okText){
    if(res.ok){
      fieldError = null;
      say("ok", okText);
    }else{
      failed(res);
    }
    repaint();
  }

  // 表單先回寫草稿再做事：innerHTML 會被整段換掉，沒先收就是丟掉使用者打的字。
  function captureDraft(today){
    if(typeof document === "undefined") return;
    const note = document.getElementById("today-note");
    if(!note) return;
    draft.note = note.value;
    draft.nextAction = value("today-next");
    draft.url = value("today-url");
    const box = document.getElementById("today-confirm");
    draft.confirmed = !!(box && box.checked);
    if(!draft.day) draft.day = today;
  }

  const api = {
    render,

    setDayField(patch, okText){
      const today = logicalToday();
      const res = store.setDayPlan(today, patch);
      // 調低可用時間會把已選的本次時間一併縮到上限，那不是「已更新可用時間」
      // 一句話交代得完的事（§4）。
      apply(res, res.ok && res.clamped
        ? `${okText}；本次時間已縮到 ${res.day.plannedMinutes} 分鐘`
        : okText);
    },

    accept(goalId, stepId){
      const today = logicalToday();
      const snap = snapshot();
      const day = snap.day;
      // 接受時把這次的時間一併落地，之後改精力或班表都不會默默改掉它（§4）。
      // 跟 focus 同一次寫入：分兩次的話，第二次失敗會留下一個沒有時間的今天。
      const minutes = day && day.plannedMinutes !== null
        ? undefined
        : defaultPlannedMinutes(day ? day.availableMinutes : null,
                                suggestForDay(snap.planner, today, today).minutes);
      const res = store.setDayFocus(today, {goalId, stepId, plannedMinutes: minutes});
      if(res.ok){
        requestId = null;
        draft.day = today;
      }
      apply(res, "已開始，接著做就好");
    },

    // 儲存班表。DOM 的讀取留在事件處理，這裡只處理規則，才驗得到二次確認
    // 帶出去的是哪一組值。
    saveAnchor({date, phase, force = false} = {}){
      // 確認時送的是當初提案的值。重繪之後再讀一次輸入欄，讀到的會是重建過
      // 的欄位，按下「確定要改」等於原封不動地把舊設定再存一次。
      const anchorDate = force && anchorConfirm ? anchorConfirm.date : date;
      const anchorPhase = force && anchorConfirm ? anchorConfirm.phase : phase;
      const res = store.setPlannerConfig({anchorDate, anchorPhase, force});
      // 已經有紀錄時不直接改，但也不是改不了：講清楚影響再讓使用者決定。
      if(!res.ok && res.reason === "has-days"){
        anchorConfirm = {days: res.days, date: anchorDate, phase: anchorPhase};
        repaint();
        return res;
      }
      if(res.ok){ openAnchor = false; anchorConfirm = null; }
      apply(res, "已更新四日班表");
      return res;
    },

    stop(){
      const today = logicalToday();
      // 收工只保存當日模式：保留主線與進度，不完成 step、不發 XP（§4）。
      apply(store.setDayPlan(today, {mode: DAY_MODE.RECOVERY, plannedMinutes: 0}),
            "今天收工。主線與進度都留著。");
    },

    submit(outcome){
      if(busy) return;
      const today = logicalToday();
      captureDraft(today);
      const snap = snapshot();
      const focus = resolveFocus({planner: snap.planner, today: snap.today,
                                  goals: snap.state.goals, steps: snap.state.steps});
      if(!focus.step || focus.state !== "accepted"){
        say("error", "要先開始今天的主線才能保存成果。");
        repaint();
        return;
      }
      if(!draft.note.trim()){
        fieldError = {field: "note", text: "要先寫下這次做了什麼"};
        repaint();
        return;
      }
      if(outcome === OUTCOME.PROGRESS && !draft.nextAction.trim()){
        fieldError = {field: "nextAction", text: "要先寫下下一個動作"};
        repaint();
        return;
      }
      // 重試沿用同一個 requestId：序列化或寫入失敗不消耗它（§6.2）。
      if(!requestId) requestId = `req_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
      busy = true;
      const res = store.submitOutcome({
        requestId, stepId: focus.step.id, outcome,
        note: draft.note, nextAction: draft.nextAction, url: draft.url,
        confirmed: outcome === OUTCOME.COMPLETE ? draft.confirmed : true,
      });
      busy = false;
      if(!res.ok){
        // url 的錯誤要指回欄位，內容保留，不能連著草稿一起清掉。
        if(res.reason === "invalid" && /連結/.test(res.message || "")) res.field = "url";
        failed(res);
        repaint();
        return;
      }
      fieldError = null;
      draft.note = "";
      draft.nextAction = "";
      draft.url = "";
      draft.confirmed = false;
      draft.day = null;
      requestId = null;
      say("ok", res.duplicate
        ? "這一筆已經保存過了，沒有重複計分。"
        : res.completed
          ? `已完成並記錄：${grantText(snap.state, focus.step)}`
          : "進度已保存。下次打開會接著這裡。");
      repaint();
    },
  };

  // ── 事件委派 ─────────────────────────────────────────────────────────────
  // #content 本身每次 render 都在（只有 innerHTML 被換掉），監聽掛一次就夠。
  // 用 data-tact 與 views.js 的 data-act 分開，兩邊不會互相攔截。
  function bind(root){
    root.addEventListener("click", e => {
      const el = e.target.closest("[data-tact]");
      if(!el || !root.contains(el)) return;
      const {tact, value: v, date, id, goal, step, outcome} = el.dataset;
      const today = logicalToday();
      if(tact === "fold-week"){ openWeek = !openWeek; editingDate = null; return repaint(); }
      if(tact === "fold-daily"){ openDaily = !openDaily; return repaint(); }
      if(tact === "fold-criteria"){ openCriteria = !openCriteria; return repaint(); }
      if(tact === "fold-switch"){ openSwitch = !openSwitch; return repaint(); }
      if(tact === "adjust-time"){ adjustingTime = !adjustingTime; return repaint(); }
      if(tact === "close-editor"){ editingDate = null; return repaint(); }
      if(tact === "edit-day"){ editingDate = editingDate === date ? null : date; return repaint(); }
      if(tact === "actual"){ return api.setDayField({attendanceActual: v}, "已確認今天的出勤"); }
      if(tact === "actual-yesterday"){
        return apply(store.setDayPlan(shiftDate(today, -1), {attendanceActual: v}),
                     "已確認昨天的出勤");
      }
      if(tact === "actual-day"){
        return apply(store.setDayPlan(date, {attendanceActual: v || null}), "已更新實際出勤");
      }
      if(tact === "plan"){
        return apply(store.setDayPlan(date, {attendancePlan: v || null}), "已更新當天安排");
      }
      if(tact === "energy"){ return api.setDayField({energy: v}, "已記下今天的精力"); }
      if(tact === "available"){
        return api.setDayField({availableMinutes: Number(v)}, "已更新可用時間");
      }
      if(tact === "available-custom"){
        const raw = value("today-available").trim();
        const n = Number(raw);
        if(raw === "" || !Number.isInteger(n) || n < 0 || n > MAX_MINUTES){
          say("error", `可用時間要填 0–${MAX_MINUTES} 的整數。`);
          return repaint();
        }
        return api.setDayField({availableMinutes: n}, "已更新可用時間");
      }
      if(tact === "planned"){
        const res = store.setDayPlan(today, {plannedMinutes: Number(v)});
        adjustingTime = false;
        return apply(res, res.ok && res.clamped
          ? `可用時間只有 ${res.day.plannedMinutes} 分鐘，已縮到上限`
          : "已更新本次時間");
      }
      if(tact === "fold-anchor"){
        openAnchor = !openAnchor;
        anchorConfirm = null;
        return repaint();
      }
      if(tact === "cancel-anchor"){ anchorConfirm = null; return repaint(); }
      if(tact === "save-anchor"){
        api.saveAnchor({
          date: value("today-anchor-date"),
          phase: Number(value("today-anchor-phase")),
          force: el.dataset.force === "1",
        });
        return;
      }
      if(tact === "save-bindings"){
        const bindings = {};
        for(const key of GOAL_BINDING_KEYS) bindings[key] = value(`today-bind-${key}`) || null;
        return apply(store.setPlannerConfig({goalBindings: bindings}), "已保存班表綁定");
      }
      if(tact === "save-detail"){
        const snap = snapshot();
        const focus = resolveFocus({planner: snap.planner, today: snap.today,
                                    goals: snap.state.goals, steps: snap.state.steps});
        if(!focus.step) return;
        return apply(store.setStepDetail(focus.step.id, {
          completionCriteria: value("today-criteria"),
          firstAction: value("today-first"),
        }), "已保存說明");
      }
      if(tact === "accept"){ return api.accept(goal, step); }
      if(tact === "stop"){ return api.stop(); }
      if(tact === "switch-goal"){
        const goalId = value("today-goal-pick");
        const snap = snapshot();
        const next = snap.state.steps.filter(s =>
          s.goalId === goalId && s.kind === STEP_KIND.MAIN && !s.archived
          && isActionable(s.state)).sort((a, b) => a.order - b.order)[0];
        if(!next){
          say("error", "這個目標沒有可行動的主線下一步。");
          return repaint();
        }
        const reason = value("today-reason");
        const res = store.setDayFocus(today, {goalId, stepId: next.id});
        if(res.ok && reason.trim()) store.setDayPlan(today, {changeReason: reason});
        openSwitch = false;
        return apply(res, "已換主線。舊的進度還留著。");
      }
      if(tact === "daily"){
        try{ store.completeStep(id); say("ok", "✓ 已打卡"); }
        catch(err){ say("error", err.message); }
        return repaint();
      }
      if(tact === "submit"){ return api.submit(outcome); }
      if(tact === "go-all" || tact === "go-goals"){
        if(typeof window !== "undefined" && typeof window.leaveToday === "function"){
          window.leaveToday(tact === "go-goals" ? "goals" : "all");
        }
        return;
      }
    });

    // 打字不重繪：草稿留在記憶體，重繪只發生在真的要換畫面的時候。
    root.addEventListener("input", e => {
      const el = e.target;
      if(el.id === "today-note") draft.note = el.value;
      else if(el.id === "today-next") draft.nextAction = el.value;
      else if(el.id === "today-url") draft.url = el.value;
      else return;
      if(!draft.day) draft.day = logicalToday();
    });

    root.addEventListener("change", e => {
      if(e.target.id !== "today-confirm") return;
      draft.confirmed = e.target.checked;
      repaint();
    });
  }

  return {render, bind, api};
}
