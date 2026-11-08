// Локальный воркер цен/метаданных для домашнего ПК (Windows + Edge).
//
// WB: headless/CI часто блокируются (403/498), поэтому проверка идёт через видимый
// (или смещённый за экран) Edge с домашнего IP и профилем ЦенРадара.
// Ozon/Яндекс Маркет/AliExpress (aliexpress.ru): best-effort через тот же профиль.
// Антибот-ограничения: увеличенные задержки, троттлинг, пропуск при капче/ошибке.
//
// Запуск:
//   node scripts/check-prices-local.mjs
//   PRICE_RADAR_MINIMIZED=0 node scripts/check-prices-local.mjs   # показать окно
//   node scripts/check-prices-local.mjs --only-marketplace wb
//   node scripts/check-prices-local.mjs --skip-marketplace ozon,ym,ali --limit 20
//   CHECK_MARKETPLACES=wb,ozon,ym,ali  (по умолчанию все поддерживаемые)
//   CHECK_DELAY_MS=4500                 (задержка между товарами, для Ozon/ЯМ/Ali полезно больше)
//
// Push-уведомления: если в .env заданы VAPID_*.
// Алерты в Telegram (падение/цель):
//   TELEGRAM_PRICE_BOT_TOKEN + TELEGRAM_PRICE_CHAT_ID (или fallback TELEGRAM_BOT_TOKEN/CHAT_ID)
//   При ошибке прямого доступа (Telegram заблокирован) — relay через GitHub Actions
//   (нужны GH_TOKEN локально и секрет TELEGRAM_PRICE_BOT_TOKEN в GitHub Actions;
//   fallback: TELEGRAM_BOT_TOKEN). Принудительно relay: TELEGRAM_ALERT_RELAY=1.
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  appendFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import webPush from "web-push";
import { resolveEdgeProfile, edgeLaunchOptions, loadDotEnv } from "./lib/browser-profile.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "public", "data");
const LOCAL = path.join(ROOT, ".local");
const LOG_DIR = path.join(ROOT, "logs");
const LOG = path.join(LOG_DIR, "check-prices.log");
const LOCK = path.join(LOCAL, "check-prices.lock");
const MAX_AGE = 180 * 24 * 3600 * 1000;
const DAY = 24 * 3600 * 1000;
const MINIMIZED = process.env.PRICE_RADAR_MINIMIZED !== "0";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG, line + "\n");
  } catch {}
}

loadDotEnv();
const argv = process.argv.slice(2);
const hasArg = (n) => argv.includes(n);
const getArg = (n, d=null) => { const i=argv.indexOf(n); if(i>=0&&argv[i+1]&&!argv[i+1].startsWith("-")) return argv[i+1]; const eq=argv.find(x=>x.startsWith(n+"=")); return eq?eq.slice(n.length+1):d; };
const SUPPORTED = new Set(["wb","ozon","ym","ali"]);
function parseSet(v){ return new Set(String(v||"").split(/[\s,]+/).map(s=>s.trim().toLowerCase()).filter(Boolean)); }
const onlyM = parseSet(getArg("--only-marketplace", process.env.CHECK_ONLY_MARKETPLACE || ""));
const skipM = parseSet(getArg("--skip-marketplace", process.env.CHECK_SKIP_MARKETPLACE || ""));
const envM = parseSet(process.env.CHECK_MARKETPLACES || "wb,ozon,ym,ali");
const LIMIT = Math.max(0, Number(getArg("--limit", process.env.CHECK_LIMIT || "0")) || 0);
const BASE_DELAY = Math.max(500, Number(getArg("--delay-ms", process.env.CHECK_DELAY_MS || "2500")) || 2500);
function marketplaceAllowed(m){
  const x=(m||"wb").toLowerCase();
  if(!SUPPORTED.has(x)) return false;
  if(onlyM.size) return onlyM.has(x);
  if(skipM.has(x)) return false;
  return envM.has(x);
}
function delayFor(m){ return m==="wb" ? Math.min(BASE_DELAY, 3500) : Math.max(BASE_DELAY, 4000); }

function git(args) {
  return execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function parsePrice(text) {
  const m = String(text || "").replace(/\u00a0/g," ").match(/(\d[\d\s]*)\s*₽/);
  return m ? Number(m[1].replace(/[^\d]/g, "")) : 0;
}
function clean(s){ return String(s||"").replace(/\s+/g," ").trim(); }

function ghDispatch(body) {
  return new Promise((resolve, reject) => {
    const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    if (!token) return reject(new Error("GH_TOKEN/GITHUB_TOKEN not set"));
    const owner = process.env.GH_OWNER || "avovka0-spec";
    const repo = process.env.GH_REPO || "price-radar";
    const data = JSON.stringify(body.payload);
    const req = https.request({
      hostname: "api.github.com",
      path: body.workflow ? `/repos/${owner}/${repo}/actions/workflows/${body.workflow}/dispatches` : `/repos/${owner}/${repo}/dispatches`,
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
        "User-Agent": "price-radar-local-agent",
      },
    }, (res) => { let b=""; res.on("data",c=>b+=c); res.on("end",()=>resolve({status:res.statusCode,body:b})); });
    req.on("error", reject); req.write(data); req.end();
  });
}

async function sendTelegramRelay(notes, chatId) {
  const text = `ЦенРадар: изменение цен (${notes.length})\n\n${notes.join("\n")}`.slice(0, 3900);
  // workflow_dispatch first, then repository_dispatch fallback
  let r = await ghDispatch({ workflow: "telegram-notify.yml", payload: { ref: "main", inputs: { chat_id: String(chatId), text, bot: "price" } } });
  if (r.status === 204) return { ok: true, via: "workflow_dispatch" };
  if ([403,404,422].includes(r.status)) {
    r = await ghDispatch({ payload: { event_type: "telegram-notify", client_payload: { chat_id: String(chatId), text, bot: "price" } } });
    if (r.status === 204) return { ok: true, via: "repository_dispatch" };
  }
  return { ok: false, status: r.status, body: String(r.body||"").slice(0,180) };
}

function productUrl(p){
  if (p.url) return p.url;
  const m = (p.marketplace || "wb").toLowerCase();
  const id = String(p.sku || "").replace(/^(wb|ozon|ym|ali):/, "");
  if (m === "wb") return `https://www.wildberries.ru/catalog/${id}/detail.aspx`;
  if (m === "ozon") return `https://www.ozon.ru/product/${id}/`;
  if (m === "ym") return `https://market.yandex.ru/product--${id}/${id}`;
  if (m === "ali") return `https://aliexpress.ru/item/${id}.html`;
  return null;
}

async function fetchWbPage(page, sku, url){
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  } catch (e) {
    log(`goto wb ${sku}: ${e && e.message ? e.message : e}`);
  }
  await page.waitForSelector('[class*="priceBlockPrice"]', { timeout: 30000 }).catch(() => null);
  await page.waitForTimeout(2500);
  const data = await page.evaluate(() => {
    const priceEl = document.querySelector('[class*="priceBlockPrice"]');
    const nameEl = document.querySelector('[class*="productNameContainer"]');
    const h2 = document.querySelector("h2");
    const badges = document.querySelector('[class*="productHeaderBadges"]');
    const og = document.querySelector('meta[property="og:image"]');
    const img = document.querySelector('img[src*="/vol"][src*="/images/"]') || document.querySelector('img[src*="/images/"]');
    return {
      priceText: priceEl ? priceEl.textContent : "",
      nameText: nameEl ? nameEl.textContent : "",
      h2Text: h2 ? h2.textContent : "",
      badgesText: badges ? badges.textContent : "",
      title: document.title,
      ogImage: og ? og.getAttribute("content") || "" : "",
      image: img ? img.currentSrc || img.src || "" : "",
      body: (document.body?.innerText || "").slice(0, 4000),
    };
  });
  let price = parsePrice(data.priceText);
  if (!price) { const m = String(data.title).match(/купить за\s*([\d\s\u00a0]+)\s*₽/); if (m) price = parsePrice(m[1]); }
  const candidates = [clean(data.h2Text), clean(data.nameText)].filter((s) => s.length > 10 && !/^язык$/i.test(s) && !/^wildberries/i.test(s));
  const nameText = candidates[0] || "";
  let brand = ""; let name = "";
  if (nameText.includes(" / ")) { const parts = nameText.split(" / "); brand = (parts.shift() || "").trim(); name = parts.join(" / ").trim(); }
  else { name = nameText; brand = clean(data.badgesText).replace(/Оригинал\w*/gi, "").trim(); }
  if (!name) name = clean(data.title).split(" купить за ")[0].replace(/\s*\d{6,}\s*$/, "").trim();
  const antibot = /доступ ограничен|подтвердите|robot|captcha|498/i.test(data.title + " " + data.body);
  if (!price) log(`parse failed wb ${sku}: price="${data.priceText}" title="${data.title}" antibot=${antibot}`);
  if (!name || !price) return null;
  return { name, brand, price, image: clean(data.ogImage) || clean(data.image) };
}

async function fetchGenericPage(page, p, url, opts={}){
  const m = (p.marketplace || "").toLowerCase();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  } catch (e) {
    log(`goto ${m} ${p.sku}: ${e && e.message ? e.message : e}`);
  }
  await page.waitForTimeout(opts.waitMs ?? 4500);
  const ex = await page.evaluate(() => {
    const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
    const body = norm(document.body?.innerText || "").slice(0, 12000);
    const title = document.title || "";
    const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute("content") || "";
    const h1 = norm(document.querySelector("h1")?.textContent);
    const ogImage = document.querySelector('meta[property="og:image"]')?.getAttribute("content") || "";
    const img = document.querySelector('img[src*="ir.ozone"],img[src*="avatars.mds.yandex"],img[src*="alicdn"],img[src*="ae-pic"],img[src*="/images/"],main img,img') || null;
    // кандидаты цен: короткие элементы с ₽ (чаще всего цена товара)
    const priceEls = Array.from(document.querySelectorAll("span,div,strong,p"))
      .map(e => norm(e.textContent)).filter(t => /^\d[\d\s\u00a0]*\s*₽$/.test(t)).slice(0, 30);
    return { title, ogTitle, h1, ogImage, image: img ? (img.currentSrc || img.src || "") : "", priceEls, body, url: location.href };
  });
  const antibot = /captcha|smartcaptcha|робот|подтвердите|доступ ограничен|verify you are human|blocked|punish/i.test(ex.title + " " + ex.body) || /captcha|punish/i.test(ex.body);
  const nums = ex.priceEls.map(parsePrice).filter(n => n > 0);
  // эвристика: на карточке часто первая/минимальная видимая цена — текущая; берём разумную (не 0, не огромный выброс если есть несколько)
  let price = 0;
  if (nums.length === 1) price = nums[0];
  else if (nums.length > 1) {
    const sorted = [...nums].sort((a,b)=>a-b);
    // часто: [текущая, старая] или [текущая, старая, ещё] — текущая обычно меньше зачёркнутой; берём min среди первых 3
    price = Math.min(...sorted.slice(0, Math.min(3, sorted.length)));
  }
  let name = clean(ex.h1) || clean(ex.ogTitle) || clean(ex.title)
    .replace(/\s*[|—-]\s*(OZON|Ozon|Яндекс Маркет|AliExpress|АлиЭкспресс).*$/i, "")
    .replace(/\s*купить.*$/i, "")
    .trim();
  if (/^ozon|^яндекс маркет|^aliexpress|^алиэкспресс/i.test(name)) name = clean(ex.h1) || name;
  if (antibot) log(`antibot/captcha hint ${m} ${p.sku}: title="${ex.title}"`);
  if (!price || !name) log(`parse miss ${m} ${p.sku}: price=${price} prices=[${ex.priceEls.slice(0,5).join("|")}] name="${name.slice(0,80)}" antibot=${antibot}`);
  if (!price) return null;
  return { name: name || p.name || String(p.sku), brand: p.brand || "", price, image: clean(ex.ogImage) || clean(ex.image) || undefined, antibot };
}

async function fetchMarketCard(ctx, p){
  const m = (p.marketplace || "wb").toLowerCase();
  const url = productUrl(p);
  if (!url) { log(`no url: ${p.sku}`); return null; }
  const page = await ctx.newPage();
  try {
    if (m === "wb") return await fetchWbPage(page, String(p.sku).replace(/^wb:/,""), url);
    if (m === "ozon" || m === "ym" || m === "ali") return await fetchGenericPage(page, p, url, { waitMs: m === "ali" ? 5500 : 4500 });
    log(`unsupported marketplace: ${m} ${p.sku}`);
    return null;
  } catch (e) {
    log(`fetch error ${m} ${p.sku}: ${e && e.stack ? e.stack : e}`);
    return null;
  } finally {
    await page.close().catch(() => {});
  }
}

async function sendTelegramAlerts(notes) {
  const chatId = process.env.TELEGRAM_PRICE_CHAT_ID || process.env.TELEGRAM_CHAT_ID || "1782021699";
  if (!notes.length) return;
  const forceRelay = process.env.TELEGRAM_ALERT_RELAY === "1";
  const directToken = process.env.TELEGRAM_PRICE_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
  const text = `ЦенРадар: изменение цен (${notes.length})\n\n${notes.join("\n")}`.slice(0, 3900);

  if (!forceRelay && directToken) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 12000);
      const res = await fetch(`https://api.telegram.org/bot${directToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
        signal: controller.signal,
      }).finally(() => clearTimeout(t));
      if (res.ok) { log(`telegram alert sent (direct): ${notes.length} item(s)`); return; }
      const body = await res.text().catch(() => "");
      log(`telegram direct failed: ${res.status} ${body.slice(0, 160)}; trying relay`);
    } catch (e) {
      log(`telegram direct error: ${e && e.message ? e.message : e}; trying relay`);
    }
  }

  // Relay через GitHub Actions (работает, если прямой доступ к Telegram заблокирован).
  // Нужны GH_TOKEN (repo+workflow) локально и секрет TELEGRAM_PRICE_BOT_TOKEN в GitHub Actions
  // (или fallback на TELEGRAM_BOT_TOKEN).
  try {
    const r = await sendTelegramRelay(notes, chatId);
    if (r.ok) log(`telegram alert sent (relay/${r.via}): ${notes.length} item(s)`);
    else log(`telegram relay failed: ${r.status} ${r.body || ""}`);
  } catch (e) {
    log(`telegram relay error: ${e && e.message ? e.message : e}`);
  }
}

async function sendPush(notes, removed, subs, vapidReady) {
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
      if (e && (e.statusCode === 404 || e.statusCode === 410)) removed.push(s.endpoint);
      else log(`push fail: ${e && e.statusCode ? e.statusCode : ""} ${e && e.message ? e.message : e}`);
    }
  }
}

(async () => {
  mkdirSync(LOCAL, { recursive: true });
  mkdirSync(LOG_DIR, { recursive: true });

  try {
    writeFileSync(LOCK, String(process.pid), { flag: "wx" });
  } catch {
    try {
      const age = Date.now() - statSync(LOCK).mtimeMs;
      if (age < 30 * 60 * 1000) {
        log("another run is active, exit");
        return;
      }
      unlinkSync(LOCK);
      writeFileSync(LOCK, String(process.pid), { flag: "wx" });
    } catch {
      log("could not acquire lock, exit");
      return;
    }
  }

  try {
    loadDotEnv();
    const vapidPublic = process.env.VAPID_PUBLIC_KEY || "";
    const vapidPrivate = process.env.VAPID_PRIVATE_KEY || "";
    const vapidSubject = process.env.VAPID_SUBJECT || "mailto:you@example.com";
    let vapidReady = false;
    if (vapidPublic && vapidPrivate) {
      webPush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);
      vapidReady = true;
    } else {
      log("VAPID-ключи не заданы — push пропускается");
    }

    try {
      git(["pull", "--rebase", "--autostash", "origin", "main"]);
    } catch (e) {
      log(`git pull error: ${e && e.stderr ? e.stderr : e && e.message ? e.message : e}`);
    }

    const products = JSON.parse(readFileSync(path.join(DATA, "products.json"), "utf8"));
    const history = JSON.parse(readFileSync(path.join(DATA, "history.json"), "utf8"));
    let subs = [];
    try {
      subs = JSON.parse(readFileSync(path.join(DATA, "push-subscriptions.json"), "utf8"));
    } catch {}

    const profile = resolveEdgeProfile();
    log(`Профиль Edge: ${profile}`);
    const ctx = await chromium.launchPersistentContext(profile, {
      ...edgeLaunchOptions({ headed: !MINIMIZED, background: MINIMIZED }),
      userAgent: UA,
    });

    const notifyQueue = [];
    const deadSubs = [];
    let changed = false;

    const targets = products.filter(p => marketplaceAllowed((p.marketplace || "wb").toLowerCase()));
    const runList = LIMIT > 0 ? targets.slice(0, LIMIT) : targets;
    log(`Товаров всего: ${products.length}; к проверке: ${runList.length} (маркетплейсы: ${[...new Set(runList.map(p=>(p.marketplace||'wb').toLowerCase()))].join(',')||'-'}${LIMIT?`, limit=${LIMIT}`:''})`);

    for (let i = 0; i < runList.length; i++) {
      const p = runList[i];
      const m = (p.marketplace || "wb").toLowerCase();
      const card = await fetchMarketCard(ctx, p);
      p.lastCheckedAt = Date.now();
      if (!card) {
        log(`no card: [${m}] ${p.sku}`);
        if (i < runList.length - 1) await new Promise(r => setTimeout(r, Math.min(delayFor(m), 2500)));
        continue;
      }

      if (p.name !== card.name || p.brand !== card.brand || (card.image && p.image !== card.image)) {
        changed = true;
      }
      p.name = card.name || p.name;
      p.brand = card.brand || p.brand;
      if (card.image) p.image = card.image;

      const was = p.currentPrice;
      p.currentPrice = card.price;
      if (was !== card.price) changed = true;

      const lastAuto = (history[p.sku] ?? []).filter((x) => !x.m).pop();
      const pts = history[p.sku] ?? [];
      const lastPt = pts[pts.length - 1];
      if (!lastPt || lastPt.p !== card.price || Date.now() - lastPt.t > DAY) {
        pts.push({ t: Date.now(), p: card.price });
        while (pts.length && Date.now() - pts[0].t > MAX_AGE) pts.shift();
        history[p.sku] = pts;
        changed = true;
      }

      const notes = [];
      const notifyOn = p.notify !== false;
      const prevAuto = lastAuto ? lastAuto.p : was;
      const drop = prevAuto ? ((card.price - prevAuto) / prevAuto) * 100 : 0;
      const thr = typeof p.thresholdPct === "number" ? p.thresholdPct : 10;
      if (
        notifyOn &&
        prevAuto &&
        prevAuto !== card.price &&
        Math.abs(drop) >= thr &&
        p.lastNotifyPrice !== card.price
      ) {
        notes.push(
          `${drop < 0 ? "▼" : "▲"} «${p.brand}» ${card.name}: ${card.price.toLocaleString("ru-RU")} ₽ (${drop > 0 ? "+" : ""}${drop.toFixed(1)}%)`,
        );
        p.lastNotifyPrice = card.price;
        changed = true;
      }
      if (
        notifyOn &&
        p.targetPrice &&
        card.price <= p.targetPrice &&
        p.lastNotifyPrice !== `t:${card.price}`
      ) {
        notes.push(
          `🎯 «${p.brand}» ${card.name}: ${card.price.toLocaleString("ru-RU")} ₽ — ниже целевой ${p.targetPrice.toLocaleString("ru-RU")} ₽`,
        );
        p.lastNotifyPrice = `t:${card.price}`;
        changed = true;
      }
      if (notes.length) {
        notifyQueue.push(...notes);
        p.lastNotifiedAt = Date.now();
        changed = true;
      }

      log(`[${m}] ${p.sku}: ${card.price} ₽ — ${card.name}`);
      if (i < runList.length - 1) await new Promise(r => setTimeout(r, delayFor(m)));
    }

    await ctx.close().catch(() => {});
    await sendPush(notifyQueue, deadSubs, subs, vapidReady);
    await sendTelegramAlerts(notifyQueue);

    if (deadSubs.length) {
      subs = subs.filter((s) => !deadSubs.includes(s.endpoint));
      writeFileSync(path.join(DATA, "push-subscriptions.json"), JSON.stringify(subs, null, 2));
      changed = true;
    }

    writeFileSync(path.join(DATA, "products.json"), JSON.stringify(products, null, 2));
    writeFileSync(path.join(DATA, "history.json"), JSON.stringify(history, null, 2));
    log(`done, changes: ${changed}`);

    try {
      git(["add", "public/data"]);
      const status = git(["status", "--porcelain"]);
      if (status.trim()) {
        git([
          "commit",
          "-m",
          `data: цены (local) ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
        ]);
        for (let i = 0; i < 3; i++) {
          try {
            git(["push"]);
            break;
          } catch (e) {
            log(`push attempt ${i + 1} failed: ${e && e.stderr ? e.stderr : e && e.message ? e.message : e}`);
            try {
              git(["pull", "--rebase", "--autostash", "origin", "main"]);
            } catch {}
          }
        }
      } else {
        log("no data changes to commit");
      }
    } catch (e) {
      log(`git commit error: ${e && e.stderr ? e.stderr : e && e.message ? e.message : e}`);
    }
  } finally {
    try {
      unlinkSync(LOCK);
    } catch {}
  }
})().catch((e) => {
  log(`fatal: ${e && e.stack ? e.stack : e}`);
  try {
    unlinkSync(LOCK);
  } catch {}
  process.exit(1);
});
