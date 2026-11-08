#!/usr/bin/env node
// Локальный импорт избранного Wildberries (MVP) через видимый Edge + ваш профиль.
//
// ВАЖНО:
// - Данные ЛК сохраняются только в .local/marketplaces/wb/ (gitignored).
// - Скрипт НЕ коммитит и НЕ пушит ничего автоматически.
// - Войдите в WB в открывшемся окне браузера, если потребуется.
//
// Запуск:
//   node scripts/wb-import-favorites.mjs
//   node scripts/wb-import-favorites.mjs --headed           # окно развёрнуто
//   node scripts/wb-import-favorites.mjs --add-candidates   # показать, чего нет в public/data/products.json
//
// Результат:
//   .local/marketplaces/wb/favorites-<ts>.json
//   .local/marketplaces/wb/favorites-<ts>.csv
//   .local/marketplaces/wb/favorites-latest.json
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, ".local", "marketplaces", "wb");
const PROFILE = path.join(ROOT, ".local", "edge-profile"); // общий профиль с check-prices-local
const PRODUCTS = path.join(ROOT, "public", "data", "products.json");
const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(`Импорт избранного WB (локально, без коммита)
Использование:
  node scripts/wb-import-favorites.mjs [--headed] [--add-candidates]

  --headed          открыть окно развёрнутым
  --add-candidates  сохранить candidates (SKU, которых нет в public/data/products.json)

Данные сохраняются только в .local/marketplaces/wb/ (gitignored).
Требуется ручной вход в WB в открывшемся Edge, если сессии нет.`);
  process.exit(0);
}
const HEADED = args.includes("--headed");
const SHOW_CANDIDATES = args.includes("--add-candidates");
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function ts() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function csvEscape(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function parsePriceText(text) {
  const m = String(text || "").match(/(\d[\d\s\u00a0]*)\s*₽/);
  return m ? Number(m[1].replace(/[^\d]/g, "")) : null;
}

async function extractFavorites(page) {
  return await page.evaluate(() => {
    const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
    const skuFromHref = (href) => {
      const m = String(href || "").match(/\/catalog\/(\d{5,})\/detail\.aspx/);
      return m ? m[1] : null;
    };
    const out = [];
    const seen = new Set();

    // Пытаемся собрать по ссылкам на карточки товара (устойчивее к смене классов).
    const links = Array.from(document.querySelectorAll('a[href*="/catalog/"][href*="/detail.aspx"]'));
    for (const a of links) {
      const sku = skuFromHref(a.getAttribute("href") || a.href);
      if (!sku || seen.has(sku)) continue;
      // Поднимаемся к разумному контейнеру карточки
      let card = a;
      for (let i = 0; i < 8 && card.parentElement; i++) {
        card = card.parentElement;
        const t = norm(card.textContent);
        if (t.includes("₽") || card.querySelector("img")) break;
      }
      const text = norm(card.textContent).slice(0, 600);
      const img = card.querySelector('img[src*="wbbasket"], img[src*="/images/"], img');
      const priceMatch = text.match(/(\d[\d\s\u00a0]*)\s*₽/);
      const nameGuess = norm(a.textContent) || norm(a.getAttribute("aria-label")) || "";
      out.push({
        marketplace: "wb",
        sku,
        url: `https://www.wildberries.ru/catalog/${sku}/detail.aspx`,
        name: nameGuess.length > 3 ? nameGuess.slice(0, 220) : "",
        priceText: priceMatch ? priceMatch[0] : "",
        image: img ? (img.currentSrc || img.src || "") : "",
        rawText: text,
      });
      seen.add(sku);
    }

    // Fallback: JSON в скриптах/глобальных объектах (best-effort, без жёстких предположений).
    let jsonHints = 0;
    for (const s of Array.from(document.scripts)) {
      const t = s.textContent || "";
      if (t.length < 200 || t.length > 2_000_000) continue;
      if (!t.includes("favorites") && !t.includes("nmId") && !t.includes("cod1S")) continue;
      jsonHints++;
    }

    return {
      url: location.href,
      title: document.title,
      items: out,
      debug: {
        links: links.length,
        extracted: out.length,
        jsonHints,
        hasLoginText: /войти|вход/i.test(document.body?.innerText || ""),
      },
    };
  });
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  log("Запуск Edge (профиль: .local/edge-profile). Если WB попросит вход — войдите в открывшемся окне.");

  const ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: "msedge",
    headless: false,
    locale: "ru-RU",
    userAgent: UA,
    viewport: null,
    args: [
      "--disable-blink-features=AutomationControlled",
      ...(HEADED ? ["--start-maximized"] : ["--start-minimized"]),
    ],
    ignoreDefaultArgs: ["--enable-automation"],
  });

  try {
    const page = ctx.pages()[0] || (await ctx.newPage());
    const favoritesUrl = "https://www.wildberries.ru/lk/favorites";
    try {
      await page.goto(favoritesUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    } catch (e) {
      log(`goto favorites: ${e && e.message ? e.message : e}`);
    }

    log("Ожидание загрузки/авторизации (до 90 сек). Если видите экран входа — войдите, затем дождитесь списка избранного.");
    const started = Date.now();
    let best = { items: [], debug: {} };
    while (Date.now() - started < 90000) {
      await page.waitForTimeout(3000);
      const snap = await extractFavorites(page);
      if ((snap.items || []).length >= best.items.length) best = snap;
      if (best.items.length > 0 && !/войти|вход/i.test(snap.title + " " + (snap.debug?.hasLoginText ? "войти" : ""))) {
        // Дали странице ещё немного догрузиться
        await page.waitForTimeout(3000);
        best = await extractFavorites(page);
        break;
      }
      if (Date.now() - started > 20000 && best.items.length > 0) break;
    }

    const items = (best.items || []).map((it) => ({
      ...it,
      price: parsePriceText(it.priceText),
      importedAt: new Date().toISOString(),
    }));

    const stamp = ts();
    const payload = {
      marketplace: "wb",
      kind: "favorites",
      exportedAt: new Date().toISOString(),
      sourceUrl: best.url || favoritesUrl,
      pageTitle: best.title || "",
      debug: best.debug || {},
      count: items.length,
      items,
      notice: "Локальный экспорт ЛК WB. Не коммитить. Добавляйте в products.json только выбранные товары.",
    };

    const jsonFile = path.join(OUT_DIR, `favorites-${stamp}.json`);
    const latestFile = path.join(OUT_DIR, "favorites-latest.json");
    const csvFile = path.join(OUT_DIR, `favorites-${stamp}.csv`);
    fs.writeFileSync(jsonFile, JSON.stringify(payload, null, 2) + "\n", "utf8");
    fs.writeFileSync(latestFile, JSON.stringify(payload, null, 2) + "\n", "utf8");
    const header = ["marketplace", "sku", "name", "price", "url", "image"];
    const rows = [header.join(",")].concat(
      items.map((it) => [it.marketplace, it.sku, it.name, it.price ?? "", it.url, it.image].map(csvEscape).join(",")),
    );
    fs.writeFileSync(csvFile, "\ufeff" + rows.join("\n") + "\n", "utf8");

    log(`Готово: ${items.length} товаров`);
    log(`JSON: ${jsonFile}`);
    log(`CSV:  ${csvFile}`);
    log(`Latest: ${latestFile}`);
    log(`Debug: ${JSON.stringify(best.debug || {})}`);

    if (!items.length) {
      console.log("\nНе удалось извлечь товары. Возможные причины: не выполнен вход в WB, изменилась вёрстка, или избранное пустое.");
      console.log("Откройте страницу избранного вручную в появившемся браузере и запустите снова с --headed.");
    }

    if (SHOW_CANDIDATES && items.length) {
      let existing = new Set();
      try {
        const products = JSON.parse(fs.readFileSync(PRODUCTS, "utf8"));
        existing = new Set((products || []).map((p) => String(p.sku)));
      } catch {}
      const candidates = items.filter((it) => !existing.has(String(it.sku)));
      const candFile = path.join(OUT_DIR, `favorites-candidates-${stamp}.json`);
      fs.writeFileSync(candFile, JSON.stringify({ exportedAt: payload.exportedAt, count: candidates.length, items: candidates }, null, 2) + "\n", "utf8");
      console.log(`\nКандидаты, которых нет в public/data/products.json: ${candidates.length}`);
      console.log(`Файл: ${candFile}`);
      console.log("Добавление в products.json делайте вручную/отдельным шагом, выбрав нужные SKU (чувствительные данные ЛК не коммитить).");
    }
  } finally {
    await ctx.close().catch(() => {});
  }
}

main().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
