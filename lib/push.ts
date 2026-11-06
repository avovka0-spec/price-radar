// Сервис-воркер и подписка на Web Push (iOS 16.4+: только для PWA с домашнего экрана)

export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const buf = new ArrayBuffer(raw.length);
  const arr = new Uint8Array(buf);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";

export async function registerPush(vapidPublicKey: string): Promise<PushSubscription> {
  if (!("serviceWorker" in navigator)) throw new Error("Service Worker не поддерживается");
  const reg = await navigator.serviceWorker.register(`${basePath}/sw.js`);
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error("Разрешение на уведомления не выдано");
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
  });
  return sub;
}

export function subToJson(sub: PushSubscription) {
  return sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
}
