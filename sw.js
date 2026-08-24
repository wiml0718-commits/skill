const CACHE = "skill-tree-v3";
const ASSETS = ["./index.html", "./manifest.json",
  "./src/model.js", "./src/store.js", "./src/views.js", "./src/reminders.js"];
self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});
self.addEventListener("fetch", e => {
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request).catch(() => caches.match("./index.html")))
  );
});
// 點擊到期通知時把既有分頁帶到前景，沒有的話才開新的
self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(clients.matchAll({type: "window", includeUncontrolled: true}).then(list => {
    for(const c of list){
      if("focus" in c) return c.focus();
    }
    return clients.openWindow ? clients.openWindow("./index.html") : undefined;
  }));
});
