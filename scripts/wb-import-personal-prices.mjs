#!/usr/bin/env node
// Локальный сбор цен/скидок, видимых в ВАШЕМ залогиненном профиле WB (MVP).
//
// Отличие от check-prices-local: использует ту же авторизованную сессию браузера,
// чтобы зафиксировать цену/скидку, как её видит пользователь (кошелёк, купоны,
// персональные акции могут влиять). Результат — только в .local/ (gitignored).
//
// Запуск:
//   node scripts/wb-import-personal-prices.mjs --from-favorites-latest
//   node scripts/wb-import-personal-prices.mjs --from-products
//   node scripts/wb-import-personal-prices.mjs --skus 1545780372,1704280114
//   node scripts/wb-import-personal-prices.mjs --from-products --limit 10 --headed
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { resolveEdgeProfile, edgeLaunchOptions } from "./lib/browser-profile.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, ".local", "marketplaces", "wb");
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
  console.log(`Персональные цены/скидки WB (локально, без коммита)
  --from-favorites-latest  взять SKU из .local/marketplaces/wb/favorites-latest.json
  --from-products          взять WB SKU из public/data/products.json
  --skus 1,2,3             явный список SKU
  --limit N                максимум товаров (по умолчанию 30)
  --headed                 развёрнутое окно
  --delay-ms N             пауза между товарами (по умолчанию 2500)`);
  process.exit(0);
}

const HEADED = has("--headed");
const LIMIT = Math.max(1, Number(getArg("--limit", "30")) || 30);
const DELAY = Math.max(500, Number(getArg("--delay-ms", "2500")) || 2500);

function ts() { return new Date().toISOString().replace(/[:.]/g, "-"); }
function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }
function parsePrice(text) {
  const m = String(text || "").replace(/\u00a0/g, " ").match(/(\d[\d\s]*)\s*₽/);
  return m ? Number(m[1].replace(/[^\d]/g, "")) : null;
}

function loadSkus() {
  const explicit = getArg("--skus");
  if (explicit) return explicit.split(/[,\s]+/).map((s) => s.trim()).filter(/^\d+$/);
  if (has("--from-favorites-latest")) {
    const p = path.join(OUT_DIR, "favorites-latest.json");
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    return (j.items || []).map((it) => String(it.sku)).filter((s) => /^\d+$/.test(s));
  }
  if (has("--from-products")) {
    const p = path.join(ROOT, "public", "data", "products.json");
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    return (j || [])
      .filter((it) => !it.marketplace || it.marketplace === "wb")
      .map((it) => String(it.sku))
      .filter((s) => /^\d+$/.test(s));
  }
  throw new Error("Укажите источник SKU: --from-favorites-latest | --from-products | --skus ...");
}

async function extractPersonal(page) {
  return await page.evaluate(() => {
    const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
    const text = norm(document.body?.innerText || "").slice(0, 12000);
    const title = document.title || "";
    const h1 = norm(document.querySelector("h1")?.textContent);
    // Цена: берём заметные ₽-строки рядом с покупкой; WB часто показывает финальную цену крупно.
    const priceEls = Array.from(document.querySelectorAll("ins, [class*='price'], [data-tag*='salePrice'], [class*='Price']"));
    const priceTexts = priceEls.map((e) => norm(e.textContent)).filter((t) => /₽/.test(t)).slice(0, 12);
    const oldPriceTexts = Array.from(document.querySelectorAll("del, [class*='old'], [class*='cross']"))
      .map((e) => norm(e.textContent)).filter((t) => /₽/.test(t)).slice(0, 6);
    const wallet = /кошел|wb wallet|wallet/i.test(text);
    const coupon = /купон|промокод/i.test(text);
    const loginHint = /войти|вход в профиль/i.test(text);
    return { title, h1, url: location.href, priceTexts, oldPriceTexts, wallet, coupon, loginHint, snippet: text.slice(0, 800) };
  });
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let skus = loadSkus();
  skus = [...new Set(skus)].slice(0, LIMIT);
  if (!skus.length) throw new Error("Список SKU пуст.");
  log(`Товаров к проверке: ${skus.length} (limit ${LIMIT}). Войдите в WB в окне Edge, если нужно.`);

  const profile = resolveEdgeProfile();
  log(`Профиль Edge: ${profile}`);
  const ctx = await chromium.launchPersistentContext(profile, {
    ...edgeLaunchOptions({ headed: HEADED, background: !HEADED }),
    userAgent: UA,
  });

  const items = [];
  try {
    const page = ctx.pages()[0] || (await ctx.newPage());
    for (let i = 0; i < skus.length; i++) {
      const sku = skus[i];
      const url = `https://www.wildberries.ru/catalog/${sku}/detail.aspx`;
      log(`[${i + 1}/${skus.length}] ${sku}`);
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      } catch (e) {
        log(`goto ${sku}: ${e && e.message ? e.message : e}`);
      }
      await page.waitForTimeout(3500);
      const ex = await extractPersonal(page);
      const allPrices = (ex.priceTexts || []).map(parsePrice).filter(Boolean);
      const oldPrices = (ex.oldPriceTexts || []).map(parsePrice).filter(Boolean);
      const personalPrice = allPrices.length ? Math.min(...allPrices) : null;
      const crossedPrice = oldPrices.length ? Math.max(...oldPrices) : null;
      items.push({
        marketplace: "wb", sku, url, capturedAt: new Date().toISOString(),
        personalPrice, crossedPrice,
        priceTexts: ex.priceTexts || [], oldPriceTexts: ex.oldPriceTexts || [],
        title: ex.title || "", h1: ex.h1 || "",
        walletHint: !!ex.wallet, couponHint: !!ex.coupon, loginHint: !!ex.loginHint,
        pageUrl: ex.url || url,
      });
      if (i < skus.length - 1) await page.waitForTimeout(DELAY);
    }
  } finally {
    await ctx.close().catch(() => {});
  }

  const stamp = ts();
  const payload = {
    marketplace: "wb", kind: "personal-prices", exportedAt: new Date().toISOString(),
    count: items.length, notice: "Локальный снимок цен из вашего профиля WB. Не коммитить.",
    items,
  };
  const jsonFile = path.join(OUT_DIR, `personal-prices-${stamp}.json`);
  const latest = path.join(OUT_DIR, "personal-prices-latest.json");
  const csvFile = path.join(OUT_DIR, `personal-prices-${stamp}.csv`);
  fs.writeFileSync(jsonFile, JSON.stringify(payload, null, 2) + "\n", "utf8");
  fs.writeFileSync(latest, JSON.stringify(payload, null, 2) + "\n", "utf8");
  const header = ["marketplace","sku","personalPrice","crossedPrice","walletHint","couponHint","loginHint","url","title"];
  const esc = (v) => { const s=String(v??""); return /[",\n]/.test(s)?`"${s.replace(/"/g,'""')}"`:s; };
  fs.writeFileSync(csvFile, "\ufeff"+[header.join(","), ...items.map(it=>header.map(h=>esc(it[h])).join(","))].join("\n")+"\n", "utf8");
  log(`Готово: ${items.length}. JSON: ${jsonFile}`);
}

main().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
