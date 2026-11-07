// Локальный воркер цен для домашнего ПК (Windows + Edge).
//
// Почему локально: WB отдаёт GitHub-раннерам 403, а headless-браузерам — 498.
// Видимый Edge с домашнего IP проходит антибот, поэтому цены проверяет этот скрипт.
//
// Запуск:
//   node scripts/check-prices-local.mjs
//   PRICE_RADAR_MINIMIZED=0 node scripts/check-prices-local.mjs   # показать окно
//
// Push-уведомления отправляются, только если в .env заданы VAPID_*:
//   VAPID_PUBLIC_KEY=...
//   VAPID_PRIVATE_KEY=...
//   VAPID_SUBJECT=mailto:you@example.com
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  appendFileSync,
  existsSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import webPush from "web-push";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "public", "data");
const LOCAL = path.join(ROOT, ".local");
const LOG_DIR = path.join(ROOT, "logs");
const LOG = path.join(LOG_DIR, "check-prices.log");
const LOCK = path.join(LOCAL, "check-prices.lock");
const PROFILE = path.join(LOCAL, "edge-profile");
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

function loadDotEnv() {
  try {
    const raw = readFileSync(path.join(ROOT, ".env"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim() || /^\s*#/.test(line)) continue;
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      let value = m[2];
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!process.env[m[1]]) process.env[m[1]] = value;
    }
  } catch {}
}

function git(args) {
  return execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function parsePrice(text) {
  const m = String(text || "").match(/(\d[\d\s\u00a0]*)\s*₽/);
  return m ? Number(m[1].replace(/[^\d]/g, "")) : 0;
}

async function fetchCard(ctx, sku) {
  const page = await ctx.newPage();
  try {
    try {
      await page.goto(`https://www.wildberries.ru/catalog/${sku}/detail.aspx`, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
    } catch (e) {
      // WB иногда отдаёт 498 на первый запрос, но страница всё равно рендерится.
      log(`goto ${sku}: ${e && e.message ? e.message : e}`);
    }
    await page.waitForSelector('[class*="priceBlockPrice"]', { timeout: 30000 }).catch(() => null);
    await page.waitForTimeout(2500);

    const data = await page.evaluate(() => {
      const priceEl = document.querySelector('[class*="priceBlockPrice"]');
      const nameEl = document.querySelector('[class*="productNameContainer"]');
      const h2 = document.querySelector("h2");
      const img =
        document.querySelector('img[src*="/images/c246x328/"]') ||
        document.querySelector('img[src*="wbbasket.ru"]');
      return {
        priceText: priceEl ? priceEl.textContent : "",
        nameText: nameEl ? nameEl.textContent : h2 ? h2.textContent : "",
        title: document.title,
        image: img ? img.currentSrc || img.src || "" : "",
        url: location.href,
      };
    });

    let price = parsePrice(data.priceText);
    if (!price) {
      const m = String(data.title).match(/купить за\s*([\d\s\u00a0]+)\s*₽/);
      if (m) price = parsePrice(m[1]);
    }

    let brand = "";
    let name = "";
    const nameText = String(data.nameText || "").replace(/\s+/g, " ").trim();
    if (nameText.includes(" / ")) {
      const parts = nameText.split(" / ");
      brand = (parts.shift() || "").trim();
      name = parts.join(" / ").trim();
    } else {
      name = nameText;
    }
    if (!name) {
      name = String(data.title || "")
        .split(" купить за ")[0]
        .replace(new RegExp(`\\s*${sku}\\s*$`), "")
        .trim();
    }
    if (!name || !price) {
      log(`parse failed ${sku}: price="${data.priceText}" name="${nameText}" title="${data.title}"`);
      return null;
    }
    return { name, brand, price, image: data.image };
  } catch (e) {
    log(`fetch error ${sku}: ${e && e.stack ? e.stack : e}`);
    return null;
  } finally {
    await page.close().catch(() => {});
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

    const ctx = await chromium.launchPersistentContext(PROFILE, {
      channel: "msedge",
      headless: false,
      locale: "ru-RU",
      userAgent: UA,
      viewport: null,
      args: [
        "--disable-blink-features=AutomationControlled",
        ...(MINIMIZED ? ["--start-minimized"] : ["--start-maximized"]),
      ],
      ignoreDefaultArgs: ["--enable-automation"],
    });

    const notifyQueue = [];
    const deadSubs = [];
    let changed = false;

    for (const p of products) {
      const card = await fetchCard(ctx, p.sku);
      p.lastCheckedAt = Date.now();
      if (!card) {
        log(`no card: ${p.sku}`);
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

      log(`${p.sku}: ${card.price} ₽ — ${card.name}`);
    }

    await ctx.close().catch(() => {});
    await sendPush(notifyQueue, deadSubs, subs, vapidReady);

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
