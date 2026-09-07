// ── 到期提醒與 App Badge ─────────────────────────────────────────────────────
// 分類與統計是純函式，瀏覽器 API 只包一層薄薄的轉接。
//
// 重要限制：這是純靜態 PWA，沒有後端就沒有 Web Push，瀏覽器也沒有提供
// Notification Triggers（預約未來時間的本地通知）。因此提醒只在 app 開啟或
// 回到前景時更新——badge 會留在圖示上直到下次開啟，但通知不是背景鬧鐘。

import {isActionable, GOAL_STATUS, STEP_KIND} from "./model.js";

export const DUE = {OVERDUE: "overdue", TODAY: "today", LATER: "later", NONE: "none"};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// 用本地時區組出 YYYY-MM-DD。不能用 toISOString()，那是 UTC，
// 在 UTC+8 的深夜會早一天翻頁，造成「今天到期」被誤判成逾期。
export function todayISO(d = new Date()){
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function classifyDue(due, today = todayISO()){
  if(typeof due !== "string" || !ISO_DATE.test(due)) return DUE.NONE;
  if(due < today) return DUE.OVERDUE;
  if(due === today) return DUE.TODAY;
  return DUE.LATER;
}

// 只計入使用者還看得到的步驟：進行中目標底下的，加上收件匣（尚未歸屬目標）的。
// 封存或已完成目標的步驟不會出現在今日與目標檢視，badge 也不該替它們計數。
export function stepsInScope(steps, goals){
  const active = new Set(
    (goals || []).filter(g => g && g.status === GOAL_STATUS.ACTIVE).map(g => g.id));
  return (steps || []).filter(s => s && (s.goalId == null || active.has(s.goalId)));
}

// Step：完成與筆記不需要行動，所以不提醒；封存的已經不在清單上，也不該提醒。
// 每日習慣沒有「到期」的概念，即使帶了日期也不計入。
export function pendingSteps(steps){
  return (steps || []).filter(s =>
    s && s.due && !s.archived && s.kind !== STEP_KIND.DAILY && isActionable(s.state));
}

// Quest：每日習慣沒有到期日的概念；完成與封存的不提醒
export function pendingQuests(quests){
  return (quests || []).filter(q =>
    q && q.dueDate && !q.done && !q.archived && q.type !== "daily");
}

export function collectDue({steps = [], goals = [], quests = [], today = todayISO()} = {}){
  const items = [];
  const take = (kind, id, title, due) => {
    const bucket = classifyDue(due, today);
    if(bucket === DUE.OVERDUE || bucket === DUE.TODAY) items.push({kind, id, title, due, bucket});
  };
  for(const s of pendingSteps(stepsInScope(steps, goals))) take("step", s.id, s.title, s.due);
  for(const q of pendingQuests(quests)) take("quest", q.id, q.title, q.dueDate);

  const overdue = items.filter(i => i.bucket === DUE.OVERDUE);
  const dueToday = items.filter(i => i.bucket === DUE.TODAY);
  return {items, overdue, dueToday, count: items.length};
}

export function summarize({overdue = [], dueToday = []} = {}){
  const parts = [];
  if(overdue.length) parts.push(`${overdue.length} 件逾期`);
  if(dueToday.length) parts.push(`${dueToday.length} 件今日到期`);
  return parts.join("、");
}

// 同一天只在件數增加時才再提醒一次，避免每次 render 都轟炸使用者
export function shouldNotify(last, today, count){
  if(count <= 0) return false;
  if(!last || last.date !== today) return true;
  return count > last.count;
}

// ── 偏好設定（自己的 key，與 Goal / Step 的儲存分開）────────────────────────
export const PREFS_KEY = "skill-reminders-v1";

function memoryBackend(){
  const m = new Map();
  return {getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => {m.set(k, String(v));}};
}

export function defaultBackend(){
  try{
    if(typeof localStorage !== "undefined" && localStorage) return localStorage;
  }catch{ /* Safari 隱私模式存取 localStorage 會丟例外 */ }
  return memoryBackend();
}

export function createPrefs(backend = defaultBackend()){
  let data = {enabled: false, lastNotified: null};
  try{
    const raw = JSON.parse(backend.getItem(PREFS_KEY) || "null");
    if(raw && typeof raw === "object"){
      data = {
        enabled: raw.enabled === true,
        lastNotified: raw.lastNotified && ISO_DATE.test(raw.lastNotified.date || "")
          ? {date: raw.lastNotified.date, count: Number(raw.lastNotified.count) || 0}
          : null,
      };
    }
  }catch{ /* 讀不到或壞掉就用預設值 */ }

  const persist = () => {
    try{ backend.setItem(PREFS_KEY, JSON.stringify(data)); }catch{ /* 寫不進去就只留記憶體 */ }
  };

  return {
    get(){return {...data, lastNotified: data.lastNotified ? {...data.lastNotified} : null};},
    setEnabled(on){data.enabled = on === true; persist(); return this.get();},
    setLastNotified(v){data.lastNotified = v ? {date: v.date, count: v.count} : null; persist(); return this.get();},
  };
}

// ── 瀏覽器 API 轉接（全部 feature-detect，失敗一律吞掉不影響其他功能）──────
export function badgeSupported(){
  return typeof navigator !== "undefined" && typeof navigator.setAppBadge === "function";
}

export async function setBadge(count){
  if(!badgeSupported()) return "unsupported";
  try{
    if(count > 0) await navigator.setAppBadge(count);
    else if(typeof navigator.clearAppBadge === "function") await navigator.clearAppBadge();
    return count > 0 ? "set" : "cleared";
  }catch{
    return "failed";  // 多數瀏覽器只在已安裝的 PWA 才允許設定 badge
  }
}

export function notificationsSupported(){
  return typeof Notification !== "undefined";
}

export function permissionState(){
  return notificationsSupported() ? Notification.permission : "unsupported";
}

export async function requestPermission(){
  if(!notificationsSupported()) return "unsupported";
  try{ return await Notification.requestPermission(); }catch{ return permissionState(); }
}

export async function showDueNotification(body, count){
  if(permissionState() !== "granted") return false;
  try{
    const reg = typeof navigator !== "undefined" && navigator.serviceWorker
      ? await navigator.serviceWorker.getRegistration()
      : null;
    if(!reg || typeof reg.showNotification !== "function") return false;
    await reg.showNotification("人生技能樹", {
      body,
      icon: "icon-192.png",
      badge: "icon-192.png",
      tag: "due-reminder",   // 同一個 tag 會取代舊通知，不會越積越多
      renotify: false,
      data: {count},
    });
    return true;
  }catch{
    return false;
  }
}

// ── 對外的協調層 ─────────────────────────────────────────────────────────────
export function createReminders(store, prefs = createPrefs()){
  const api = {
    // 每次 render 都會呼叫，所以必須便宜且不能拋錯
    async refresh(quests){
      let due;
      try{
        const {steps, goals} = store.getState();
        due = collectDue({steps, goals, quests});
      }catch{
        return null;
      }
      await setBadge(due.count);

      if(prefs.get().enabled && permissionState() === "granted"){
        const today = todayISO();
        if(shouldNotify(prefs.get().lastNotified, today, due.count)){
          if(await showDueNotification(summarize(due), due.count)){
            prefs.setLastNotified({date: today, count: due.count});
          }
        }
      }
      return due;
    },

    status(){
      return {
        enabled: prefs.get().enabled,
        permission: permissionState(),
        badgeSupported: badgeSupported(),
      };
    },

    // 使用者主動打開開關時才請求權限，不在開啟 app 時就跳詢問
    async enable(){
      const state = await requestPermission();
      prefs.setEnabled(state === "granted");
      return api.status();
    },

    disable(){
      prefs.setEnabled(false);
      prefs.setLastNotified(null);
      return api.status();
    },
  };
  return api;
}
