// Service Worker: приход push → показываем уведомление; клик → открыть приложение
const APP_URL = self.registration.scope;

self.addEventListener("install", (e) => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = { title: "ЦенРадар", body: "Изменение цены", url: "./" };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch {}
  if (!data.body) {
    if (event.data) {
      const txt = event.data.text();
      if (txt) data.body = txt;
    }
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      data: data.url,
      icon: "icons/icon-192.png",
      badge: "icons/badge-96.png",
    })
  );
  if (self.navigator.setAppBadge) self.navigator.setAppBadge(1);
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      if (self.navigator.clearAppBadge) self.navigator.clearAppBadge();
      const cs = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const target = new URL(event.notification.data || "./", APP_URL).href;
      for (const c of cs) {
        if (c.url === target) return c.focus();
      }
      for (const c of cs) if ("focus" in c) return c.focus();
      return self.clients.openWindow(target);
    })()
  );
});
