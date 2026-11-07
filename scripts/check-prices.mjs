// GitHub Actions: проверка цен на Wildberries, дописывание истории (до 180 дней),
// проверка порогов/целевой цены, рассылка Web Push. Пишет результат в public/data/*.json.
import { readFileSync, writeFileSync } from "node:fs";
import webPush from "web-push";

const P = "public/data";
const MAX_AGE = 180 * 24 * 3600 * 1000;
const DAY = 24 * 3600 * 1000;

// card.wb.ru варьирует эндпоинты/гео-фильтр; пробуем несколько вариантов, плюс
// опциональный собственный relay (секрет WB_PROXY_URL, см. README).
const ENDPOINTS = (proxy, sku) => {
  const sep = proxy && proxy.includes("?") ? "&" : "?";
  return [
    ...(proxy ? [`${proxy}${sep}nm=${sku}`] : []), // свой relay: .../wb?key=...&nm=123 (ходит на card.wb.ru с RU-IP)
    `https://card.wb.ru/cards/v2/detail?appType=1&curr=rub&dest=-1257786&spp=30&nm=${sku}`,
    `https://card.wb.ru/cards/v2/detail?appType=1&curr=rub&dest=-1257786&spp=0&nm=${sku}`,
    `https://card.wb.ru/cards/v1/detail?appType=1&curr=rub&dest=-1257786&spp=0&nm=${sku}`,
    `https://search.wb.ru/exactmatch/ru/common/v9/search?appType=1&curr=rub&dest=-1257786&spp=0&query=${sku}`,
  ];
};

if (!process.env.WB_PROXY_URL) {
  console.log("! WB_PROXY_URL не задан — GitHub runner может получить 403 от WB");
}
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile Safari/604.1";

const products = JSON.parse(readFileSync(`${P}/products.json`, "utf8"));
const history = JSON.parse(readFileSync(`${P}/history.json`, "utf8"));
const subs = JSON.parse(readFileSync(`${P}/push-subscriptions.json`, "utf8"));

let committed = false;
const deadSubs = [];
const notifyQueue = [];
let vapidReady = false;

if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webPush.setVapidDetails(process.env.VAPID_SUBJECT ?? "mailto:you@example.com",
    process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
  vapidReady = true;
} else {
  console.log("! VAPID-ключи не заданы — push не отправляется");
}

async function sendPush(notes, removedSubs) {
  if (!notes.length || !vapidReady) return;
  const payload = JSON.stringify({
    title: "ЦенРадар",
    body: notes.join("\n"),
    url: "./",
  });
  for (const s of subs) {
    try {
      await webPush.sendNotification(s, payload);
    } catch (e) {
      if (e?.statusCode === 404 || e?.statusCode === 410) removedSubs.push(s.endpoint);
      else console.log(`push fail: ${e?.statusCode ?? ""} ${e?.message}`);
    }
  }
}

for (const p of products) {
  const card = await fetchCard(p.sku);
  p.lastCheckedAt = Date.now();
  if (!card) { console.log(`no card: ${p.sku}`); continue; }
  p.name = card.name || p.name;
  p.brand = card.brand || p.brand;
  const was = p.currentPrice;
  p.currentPrice = card.price;

  // предыдущая автоматическая цена — по истории ДО append'а, иначе новая точка обнулит дельту
  const lastAuto = (history[p.sku] ?? []).filter((x) => !x.m).pop();

  // история: точка если цена изменилась, либо прошло >24ч с последней точки
  const pts = history[p.sku] ?? [];
  const lastPt = pts[pts.length - 1];
  if (!lastPt || lastPt.p !== card.price || Date.now() - lastPt.t > DAY) {
    pts.push({ t: Date.now(), p: card.price });
    while (pts.length && Date.now() - pts[0].t > MAX_AGE) pts.shift();
    history[p.sku] = pts;
    committed = true;
  }

  // --- уведомления (если не отключены у товара) ---
  // сравниваем с последней АВТОМАТИЧЕСКОЙ точкой: ручные (m=1) вызывают ложные «скачки»
  const notes = [];
  const notifyOn = p.notify !== false;
  const prevAuto = lastAuto?.p ?? was;
  const drop = prevAuto ? ((card.price - prevAuto) / prevAuto) * 100 : 0;
  const thr = typeof p.thresholdPct === "number" ? p.thresholdPct : 10;
  if (notifyOn && prevAuto && prevAuto !== card.price && Math.abs(drop) >= thr && p.lastNotifyPrice !== card.price) {
    notes.push(`${drop < 0 ? "▼" : "▲"} «${p.brand}» ${card.name}: ${card.price.toLocaleString("ru-RU")} ₽ (${drop > 0 ? "+" : ""}${drop.toFixed(1)}%)`);
    p.lastNotifyPrice = card.price;
  }
  if (notifyOn && p.targetPrice && card.price <= p.targetPrice && p.lastNotifyPrice !== `t:${card.price}`) {
    notes.push(`🎯 «${p.brand}» ${card.name}: ${card.price.toLocaleString("ru-RU")} ₽ — ниже целевой ${p.targetPrice.toLocaleString("ru-RU")} ₽`);
    p.lastNotifyPrice = `t:${card.price}`;
  }
  if (notes.length) {
    notifyQueue.push(...notes);
    p.lastNotifiedAt = Date.now();
    committed = true;
  }
  console.log(`${p.sku}: ${card.price} ₽`);
}

await sendPush(notifyQueue, deadSubs);
if (deadSubs.length) {
  const kept = subs.filter((s) => !deadSubs.includes(s.endpoint));
  writeFileSync(`${P}/push-subscriptions.json`, JSON.stringify(kept, null, 2));
  committed = true;
}
writeFileSync(`${P}/products.json`, JSON.stringify(products, null, 2));
writeFileSync(`${P}/history.json`, JSON.stringify(history, null, 2));
console.log("done, changes:", committed);
process.exit(0);

// --- fetch helper ---
async function fetchCard(sku) {
  const proxy = process.env.WB_PROXY_URL ?? "";
  let blocked = false;
  for (const u of ENDPOINTS(proxy, sku)) {
    try {
      const res = await fetch(u, { headers: { "User-Agent": UA, Accept: "*/*" }, signal: AbortSignal.timeout(15000) });
      if (res.status === 403) { blocked = true; continue; } // гео-фильтр — пробуем следующий вариант
      if (!res.ok) continue;
      const j = await res.json();
      const pr = j?.data?.products?.[0] ?? j?.products?.[0] ?? j?.data?.[0];
      const price = (pr?.salePriceU ?? pr?.priceU ?? 0) / 100;
      if (!pr || !price) continue;
      return { name: pr.name ?? "", brand: pr.brand ?? "", price };
    } catch (e) {
      console.log(`fetch err ${sku}: ${e?.message}`);
    }
  }
  if (blocked) console.log(`WB 403 для ${sku}: нужен WB_PROXY_URL (RU-релей)`);
  return null;
}

