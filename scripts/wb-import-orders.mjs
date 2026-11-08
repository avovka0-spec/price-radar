#!/usr/bin/env node
// Локальный импорт заказов WB (MVP, best-effort).
//
// Открывает раздел заказов в видимом Edge с вашим профилем. Вы входите сами.
// Скрипт пытается извлечь видимые заказы/позиции и сохраняет ТОЛЬКО в .local/.
// Ничего не коммитит. Данные заказов — чувствительные (ПДн), не публикуйте.
//
// Запуск:
//   node scripts/wb-import-orders.mjs
//   node scripts/wb-import-orders.mjs --url https://www.wildberries.ru/lk/myorders/archive
//   node scripts/wb-import-orders.mjs --headed --scrolls 12
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, ".local", "marketplaces", "wb");
const PROFILE = path.join(ROOT, ".local", "edge-profile");
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function getArg(name, def = null) {
  const a = process.argv.slice(2);
  const i = a.indexOf(name);
  if (i >= 0 && a[i + 1] && !a[i + 1].startsWith("--")) return a[i + 1];
  const eq = a.find((x) => x.startsWith(name + "="));
  return eq ? eq.slice(name.length + 1) : def;
}
function has(name) { return process.argv.includes(name); }
if (has("--help") || has("-h")) {
  console.log(`Импорт заказов WB (локально, без коммита)
  --url <url>     страница заказов (по умолчанию /lk/myorders/delivery)
  --headed        развёрнутое окно
  --scrolls N     число прокруток для подгрузки (по умолчанию 8)
  --wait-ms N     ожидание после загрузки/прокрутки (по умолчанию 2500)

Данные сохраняются только в .local/marketplaces/wb/ (gitignored).`);
  process.exit(0);
}

const HEADED = has("--headed");
const SCROLLS = Math.max(0, Number(getArg("--scrolls", "8")) || 8);
const WAIT = Math.max(500, Number(getArg("--wait-ms", "2500")) || 2500);
const START_URL = getArg("--url", "https://www.wildberries.ru/lk/myorders/delivery");

function ts() { return new Date().toISOString().replace(/[:.]/g, "-"); }
function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }
const esc = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

function parsePrice(text) {
  const m = String(text || "").replace(/\u00a0/g, " ").match(/(\d[\d\s]*)\s*₽/);
  return m ? Number(m[1].replace(/[^\d]/g, "")) : null;
}

async function extractOrders(page) {
  return await page.evaluate(() => {
    const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
    const results = [];
    const seen = new Set();

    // Эвристика: блоки, похожие на заказы/доставки/сборки (WB меняет классы).
    const candidates = Array.from(document.querySelectorAll(
      "section, article, li, div"
    )).filter((el) => {
      const t = norm(el.textContent);
      if (t.length < 30 || t.length > 4000) return false;
      return /заказ|сборк|достав|получ|отмен|руб|₽/i.test(t) && /₽|\d{2}\.\d{2}|\d{4}/.test(t);
    });

    for (const el of candidates) {
      const text = norm(el.textContent).slice(0, 2000);
      const key = text.slice(0, 180);
      if (seen.has(key)) continue;
      // пропускаем слишком общие контейнеры, если внутри есть более специфичные
      if (el.querySelectorAll("section, article, li").length > 8) continue;
      const links = Array.from(el.querySelectorAll('a[href*="/catalog/"]')).map((a) => a.href).filter((v,i,a)=>a.indexOf(v)===i).slice(0, 20);
      const prices = (text.match(/(\d[\d\s\u00a0]*)\s*₽/g) || []).slice(0, 10);
      const dates = (text.match(/\d{1,2}\s+[а-я]{3,}\.?|\d{2}\.\d{2}\.\d{2,4}/gi) || []).slice(0, 6);
      const skus = links.map((h) => (h.match(/\/catalog\/(\d{5,})\//) || [])[1]).filter(Boolean);
      if (!prices.length && !skus.length && !dates.length) continue;
      results.push({
        text,
        links,
        skus: [...new Set(skus)],
        pricesText: prices,
        dates,
      });
      seen.add(key);
      if (results.length >= 120) break;
    }

    return {
      url: location.href,
      title: document.title,
      loginHint: /войти|вход/i.test(norm(document.body?.innerText || "")),
      orders: results,
    };
  });
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  log(`Открываю заказы WB: ${START_URL}`);
  log("Если нужен вход — войдите в открывшемся Edge. Данные сохраняются только локально.");

  const ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: "msedge", headless: false, locale: "ru-RU", userAgent: UA, viewport: null,
    args: ["--disable-blink-features=AutomationControlled", ...(HEADED ? ["--start-maximized"] : ["--start-minimized"])],
    ignoreDefaultArgs: ["--enable-automation"],
  });

  try {
    const page = ctx.pages()[0] || (await ctx.newPage());
    try {
      await page.goto(START_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    } catch (e) {
      log(`goto: ${e && e.message ? e.message : e}`);
    }
    await page.waitForTimeout(WAIT + 1500);

    for (let i = 0; i < SCROLLS; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
      await page.waitForTimeout(WAIT);
    }
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await page.waitForTimeout(1000);

    const snap = await extractOrders(page);
    const orders = (snap.orders || []).map((o, idx) => ({
      index: idx + 1,
      ...o,
      prices: (o.pricesText || []).map(parsePrice).filter(Boolean),
      totalGuess: (() => { const p = (o.pricesText || []).map(parsePrice).filter(Boolean); return p.length ? Math.max(...p) : null; })(),
      importedAt: new Date().toISOString(),
    }));

    const stamp = ts();
    const payload = {
      marketplace: "wb", kind: "orders", exportedAt: new Date().toISOString(),
      sourceUrl: snap.url || START_URL, pageTitle: snap.title || "",
      loginHint: !!snap.loginHint, count: orders.length,
      notice: "Локальный экспорт заказов WB (ПДн). Не коммитить, не публиковать.",
      orders,
    };
    const jsonFile = path.join(OUT_DIR, `orders-${stamp}.json`);
    const latest = path.join(OUT_DIR, "orders-latest.json");
    const csvFile = path.join(OUT_DIR, `orders-${stamp}.csv`);
    fs.writeFileSync(jsonFile, JSON.stringify(payload, null, 2) + "\n", "utf8");
    fs.writeFileSync(latest, JSON.stringify(payload, null, 2) + "\n", "utf8");
    const header = ["index","totalGuess","dates","skus","pricesText","links","text"];
    fs.writeFileSync(csvFile, "\ufeff" + [header.join(","), ...orders.map(o => header.map(h => esc(Array.isArray(o[h]) ? o[h].join(" | ") : o[h])).join(","))].join("\n") + "\n", "utf8");

    log(`Готово: ${orders.length} блоков. JSON: ${jsonFile}`);
    if (snap.loginHint) log("Похоже, требуется вход в WB. Запустите с --headed и войдите, затем повторите.");
    if (!orders.length) log("Не удалось извлечь заказы. Откройте нужный раздел заказов вручную, при необходимости укажите --url и увеличьте --scrolls.");
  } finally {
    await ctx.close().catch(() => {});
  }
}

main().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
