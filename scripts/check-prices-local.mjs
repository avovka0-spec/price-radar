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

function sanitizeProductUrl(raw, marketplace, sku) {
  const s = String(raw || "").trim();
  const mUrl = s.match(/https?:\/\/[^\s"'<>]+/i);
  if (mUrl) return mUrl[0].replace(/[),.;!?]+$/g, "");
  const sk = String(sku || "");
  if (/^ali:click:/i.test(sk)) return `https://ali.click/${sk.replace(/^ali:click:/i, "")}`;
  if (/^ali:short:/i.test(sk)) return `https://a.aliexpress.com/_${sk.replace(/^ali:short:/i, "")}`;
  if (/^ali:\d+/i.test(sk)) return `https://aliexpress.ru/item/${sk.replace(/^ali:/i, "")}.html`;
  if (/^ozon:/i.test(sk) && s && !/^https?:/i.test(s)) return `https://www.ozon.ru/product/${sk.replace(/^ozon:(?:t:)?/i, "")}/`;
  if (/^ym:\d+/i.test(sk)) return `https://market.yandex.ru/product/${sk.replace(/^ym:/i, "")}`;
  return /^https?:\/\//i.test(s) ? s : "";
}

function productUrl(p){
  const m = (p.marketplace || "wb").toLowerCase();
  const fromField = sanitizeProductUrl(p.url, m, p.sku);
  if (fromField) return fromField;
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

function pickPlausiblePrice(candidates, prevPrice) {
  const nums = [...new Set(candidates.map((n) => Math.round(Number(n) || 0)).filter((n) => n > 0))];
  if (!nums.length) return 0;
  if (nums.length === 1) return nums[0];
  const sorted = [...nums].sort((a, b) => a - b);
  // Если есть предыдущая цена/история, отбрасываем явный мусор (бонусы, "1 ₽", рассрочка).
  // Якорь считаем ненадёжным, если он сам похож на ошибку парсинга (слишком мал).
  const anchor = prevPrice >= 50 ? prevPrice : 0;
  if (anchor > 0) {
    const plausible = sorted.filter((n) => n >= Math.max(2, anchor * 0.08) && n <= anchor * 8);
    if (plausible.length) return plausible[0];
    // Если якорь не помог (редкий случай резкой смены цены), не возвращаем мусор — пробуем без якоря.
  }
  // Без надёжного якоря: убираем экстремально малые выбросы относительно основной группы.
  const hi = sorted[sorted.length - 1];
  const tail = sorted.filter((n) => n >= Math.max(10, hi * 0.03));
  const pool = tail.length ? tail : sorted.filter((n) => n >= Math.max(2, hi * 0.01));
  const finalPool = pool.length ? pool : sorted;
  // Часто [текущая, старая/зачёркнутая] — текущая обычно среди наименьших в правдоподобной группе.
  return finalPool.length > 1 ? Math.min(...finalPool.slice(0, Math.min(3, finalPool.length))) : finalPool[0];
}

async function fetchGenericPage(page, p, url, opts = {}) {
  const m = (p.marketplace || "").toLowerCase();
  const prevRef = Number(p._priceRef || p.currentPrice || 0);
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  } catch (e) {
    log(`goto ${m} ${p.sku}: ${e && e.message ? e.message : e}`);
  }
  // Короткие/партнёрские ссылки (ali.click, a.aliexpress.com и т.п.) могут редиректить в браузере.
  if (m === "ali") {
    try { await page.waitForLoadState("domcontentloaded", { timeout: 15000 }); } catch {}
    try { await page.waitForURL(/aliexpress\.(ru|com)\/item/i, { timeout: 12000 }); } catch {}
  }
  await page.waitForTimeout(opts.waitMs ?? 4500);
  const ex = await page.evaluate(() => {
    const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
    const body = norm(document.body?.innerText || "").slice(0, 14000);
    const title = document.title || "";
    const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute("content") || "";
    const h1 = norm(document.querySelector("h1")?.textContent);
    const ogImage = document.querySelector('meta[property="og:image"]')?.getAttribute("content") || "";
    const img =
      document.querySelector('img[src*="ir.ozone"],img[src*="avatars.mds.yandex"],img[src*="alicdn"],img[src*="ae-pic"],img[src*="/images/"],main img,img') || null;
    const metaPrice = norm(document.querySelector('meta[property="product:price:amount"]')?.getAttribute("content"));

    // JSON-LD: самый надёжный источник цены карточки, если он есть.
    const ldPrices = [];
    const ldNodes = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
    for (const n of ldNodes.slice(0, 12)) {
      try {
        const j = JSON.parse(n.textContent || "null");
        const stack = [j];
        while (stack.length) {
          const v = stack.pop();
          if (!v) continue;
          if (Array.isArray(v)) { stack.push(...v); continue; }
          if (typeof v === "object") {
            if (v.price != null) ldPrices.push(String(v.price));
            if (v.lowPrice != null) ldPrices.push(String(v.lowPrice));
            if (v.highPrice != null) ldPrices.push(String(v.highPrice));
            for (const k of Object.keys(v)) stack.push(v[k]);
          }
        }
      } catch {}
    }

    // DOM-кандидаты с ₽: берём метаданные, чтобы отсеять зачёркнутые/скрытые/мусорные мелочи.
    const priceEls = Array.from(document.querySelectorAll("span,div,strong,p,b"))
      .map((e) => {
        const t = norm(e.textContent);
        if (!/^\d[\d\s\u00a0]*\s*₽$/.test(t) || t.length > 20) return null;
        const st = getComputedStyle(e);
        const r = e.getBoundingClientRect();
        if (st.display === "none" || st.visibility === "hidden" || Number(st.opacity || 1) < 0.05) return null;
        if (r.width < 8 || r.height < 8) return null;
        const dec = `${st.textDecorationLine || ""} ${st.textDecoration || ""}`.toLowerCase();
        return {
          t,
          strike: dec.includes("line-through"),
          fs: parseFloat(st.fontSize || "0") || 0,
          fw: parseInt(st.fontWeight || "400", 10) || 400,
          area: Math.round(r.width * r.height),
        };
      })
      .filter(Boolean)
      .slice(0, 80);

    // Фрагменты встроенного JSON в script (Ozon/SPA часто хранят цену там).
    const scriptPrices = [];
    const scripts = Array.from(document.scripts || []).slice(0, 25);
    for (const s of scripts) {
      const txt = String(s.textContent || "");
      if (txt.length < 40 || txt.length > 250000) continue;
      let m;
      const re = /"(?:price|finalPrice|webPrice|cardPrice|marketingPrice|originalPrice|discountedPrice)"\s*:\s*"?(\d[\d\s\u00a0]{0,12})"?/g;
      while ((m = re.exec(txt)) && scriptPrices.length < 40) scriptPrices.push(m[1]);
    }

    // Таможенный сбор/пошлина (best-effort, напр. AliExpress): ищем в видимом тексте и небольших элементах.
    const customsHits = [];
    try {
      const re = /(?:таможенн\w*[\s\S]{0,25}?(?:сбор|пошлин)\w*|(?:сбор|пошлин)\w*[\s\S]{0,25}?таможенн\w*)[^0-9]{0,30}(\d[\d\s\u00a0]{1,12})\s*₽/gi;
      let mm;
      while ((mm = re.exec(body)) && customsHits.length < 5) customsHits.push(mm[1]);
    } catch {}

    return {
      title, ogTitle, h1, ogImage, image: img ? (img.currentSrc || img.src || "") : "",
      metaPrice, ldPrices, priceEls, scriptPrices, customsHits, body, url: location.href,
    };
  });

  const antibot = /captcha|smartcaptcha|робот|подтвердите|доступ ограничен|verify you are human|blocked|punish/i.test(ex.title + " " + ex.body) || /captcha|punish/i.test(ex.url);

  const toNum = (v) => {
    const s = String(v ?? "").replace(/\u00a0/g, " ").trim();
    if (!s) return 0;
    // JSON-LD/meta могут отдавать "279170.00" — берём рубли, не склеиваем копейки.
    const m = s.match(/(\d[\d\s]*)(?:[.,]\d+)?/);
    if (!m) return 0;
    const n = Number(m[1].replace(/[^\d]/g, ""));
    return Number.isFinite(n) && n > 0 ? n : 0;
  };

  // Приоритет: JSON-LD/meta -> незачёркнутые заметные DOM-цены -> встроенный JSON -> любые DOM.
  const ldNums = [...(ex.ldPrices || []), ex.metaPrice].map(toNum).filter(Boolean);
  let price = pickPlausiblePrice(ldNums, prevRef);

  if (!price) {
    const dom = (ex.priceEls || []).filter((x) => x && !x.strike).map((x) => ({ n: toNum(x.t), ...x })).filter((x) => x.n > 0);
    dom.sort((a, b) => (b.fs - a.fs) || (b.fw - a.fw) || (b.area - a.area));
    // Берём верх заметных элементов (обычно текущая цена крупнее старой/мелочей), затем фильтруем правдоподобность.
    const top = dom.slice(0, 8).map((x) => x.n);
    price = pickPlausiblePrice(top, prevRef);
    if (!price) price = pickPlausiblePrice(dom.map((x) => x.n), prevRef);
  }

  if (!price) price = pickPlausiblePrice((ex.scriptPrices || []).map(toNum).filter(Boolean), prevRef);

  if (!price) {
    const anyDom = (ex.priceEls || []).map((x) => toNum(x?.t)).filter(Boolean);
    price = pickPlausiblePrice(anyDom, prevRef);
  }

  let name = clean(ex.h1) || clean(ex.ogTitle) || clean(ex.title)
    .replace(/\s*[|—-]\s*(OZON|Ozon|Яндекс Маркет|AliExpress|АлиЭкспресс).*$/i, "")
    .replace(/\s*купить.*$/i, "")
    .trim();
  if (/^ozon|^яндекс маркет|^aliexpress|^алиэкспресс/i.test(name)) name = clean(ex.h1) || name;

  if (antibot) log(`antibot/captcha hint ${m} ${p.sku}: title="${ex.title}"`);
  if (!price || !name) {
    const sample = (ex.priceEls || []).slice(0, 6).map((x) => `${x.t}${x.strike ? "(s)" : ""}`).join("|");
    log(`parse miss ${m} ${p.sku}: price=${price} prev=${prevRef} prices=[${sample}] ld=[${(ex.ldPrices||[]).slice(0,3).join(",")}] name="${name.slice(0, 80)}" antibot=${antibot}`);
  }
  let dutyPrice;
  if (Array.isArray(ex.customsHits) && ex.customsHits.length) {
    const vals = ex.customsHits.map((v) => toNum(v)).filter((n) => n > 0 && n < Math.max(500000, price * 2));
    // Берём наиболее частое/разумное; обычно одно значение. Отсекаем слишком большие (не сбор).
    if (vals.length) {
      const pick = vals.sort((a, b) => a - b)[0];
      if (pick > 0 && pick < (price || Infinity)) dutyPrice = Math.round(pick);
    }
  }

  if (!price) return null;
  return { name: name || p.name || String(p.sku), brand: p.brand || "", price, dutyPrice, image: clean(ex.ogImage) || clean(ex.image) || undefined, antibot, url: clean(ex.url) || undefined };
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
      // Надёжный якорь для анти-мусорной фильтрации цены: последний авто-пойнт истории
      // (игнорируем крошечные значения, похожие на прошлые ошибки парсинга).
      const histPts = (history[p.sku] ?? []).filter((x) => !x.m && Number(x.p) >= 50).map((x) => Number(x.p));
      const goodHist = histPts.length ? histPts[histPts.length - 1] : 0;
      if (goodHist && !(Number(p.currentPrice) >= 50)) p._priceRef = goodHist;
      const card = await fetchMarketCard(ctx, p);
      try { delete p._priceRef; } catch {}
      p.lastCheckedAt = Date.now();
      if (!card) {
        log(`no card: [${m}] ${p.sku}`);
        if (i < runList.length - 1) await new Promise(r => setTimeout(r, Math.min(delayFor(m), 2500)));
        continue;
      }

      if (p.name !== card.name || p.brand !== card.brand || (card.image && p.image !== card.image) || (card.dutyPrice != null && p.dutyPrice !== card.dutyPrice) || (card.url && card.url !== p.url)) {
        changed = true;
      }
      p.name = card.name || p.name;
      p.brand = card.brand || p.brand;
      if (card.image) p.image = card.image;
      if (card.dutyPrice != null) p.dutyPrice = card.dutyPrice;
      // Сохраняем финальный URL страницы (редиректы/канонический адрес), чтобы ссылки оставались актуальными.
      if (card.url && /^https?:\/\//i.test(card.url)) p.url = card.url;

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

    // Скрейпинг занимает минуты: за это время пользователь мог удалить/добавить товары
    // через PWA (отдельные коммиты в GitHub). Делаем pull и мерджим результаты проверки
    // в свежие данные, НЕ воскрешая удалённые товары и не затирая параллельные правки.
    try {
      git(["pull", "--rebase", "--autostash", "origin", "main"]);
    } catch (e) {
      log(`git pull before save error: ${e && e.stderr ? e.stderr : e && e.message ? e.message : e}`);
    }
    let freshProducts = products;
    let freshHistory = history;
    try { freshProducts = JSON.parse(readFileSync(path.join(DATA, "products.json"), "utf8")); } catch {}
    try { freshHistory = JSON.parse(readFileSync(path.join(DATA, "history.json"), "utf8")); } catch {}

    const checkedBySku = new Map(products.map((p) => [String(p.sku), p]));
    const checkerFields = (u) => {
      const out = {};
      for (const k of ["name","brand","image","marketplace","currentPrice","lastCheckedAt","lastNotifiedAt","lastNotifyPrice","dutyPrice","url","sku","id"]) {
        if (u[k] !== undefined) out[k] = u[k];
      }
      // Настройки пользователя (targetPrice/thresholdPct/notify/addedAt/favorite/abroad) берём из fresh, если есть,
      // чтобы не затереть изменения из UI, сделанные параллельно.
      return out;
    };
    const mergedProducts = (Array.isArray(freshProducts) ? freshProducts : []).map((fp) => {
      const u = checkedBySku.get(String(fp.sku));
      return u ? { ...fp, ...checkerFields(u) } : fp;
    });
    const mergedSkus = new Set(mergedProducts.map((p) => String(p.sku)));

    const mergedHistory = { ...(freshHistory && typeof freshHistory === "object" ? freshHistory : {}) };
    const mergePoints = (a, b) => {
      const out = [];
      const seen = new Set();
      for (const pt of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
        if (!pt || typeof pt.t !== "number") continue;
        const k = `${pt.t}|${pt.p}|${pt.m ? 1 : 0}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(pt);
      }
      out.sort((x, y) => x.t - y.t);
      while (out.length && Date.now() - out[0].t > MAX_AGE) out.shift();
      return out;
    };
    // Обновляем историю только для товаров, которые всё ещё существуют.
    // Мерджим точки (дедуп по t+p+m), чтобы не потерять ручную точку, добавленную в окно гонки,
    // и при этом сохранить авто-точки этого прогона. Удаление товара уважаем.
    for (const [sku, pts] of Object.entries(history || {})) {
      if (mergedSkus.has(String(sku))) mergedHistory[sku] = mergePoints(mergedHistory[sku], pts);
    }
    for (const sku of Object.keys(mergedHistory)) {
      if (!mergedSkus.has(String(sku))) delete mergedHistory[sku];
    }
    if (mergedProducts.length !== products.length) {
      log(`merge: products ${products.length} -> ${mergedProducts.length} (учтены параллельные удаления/добавления)`);
      changed = true;
    }

    if (deadSubs.length) {
      let freshSubs = subs;
      try { freshSubs = JSON.parse(readFileSync(path.join(DATA, "push-subscriptions.json"), "utf8")); } catch {}
      subs = (Array.isArray(freshSubs) ? freshSubs : subs).filter((s) => !deadSubs.includes(s.endpoint));
      writeFileSync(path.join(DATA, "push-subscriptions.json"), JSON.stringify(subs, null, 2));
      changed = true;
    }

    writeFileSync(path.join(DATA, "products.json"), JSON.stringify(mergedProducts, null, 2));
    writeFileSync(path.join(DATA, "history.json"), JSON.stringify(mergedHistory, null, 2));
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
