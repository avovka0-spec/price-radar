#!/usr/bin/env node
// Локальный импорт избранного Ozon (MVP, best-effort). Данные только в .local/.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { resolveEdgeProfile, edgeLaunchOptions } from "./lib/browser-profile.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, ".local", "marketplaces", "ozon");
const PRODUCTS = path.join(ROOT, "public", "data", "products.json");
const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(`Импорт избранного Ozon (локально, без коммита)
  node scripts/ozon-import-favorites.mjs [--headed] [--add-candidates]
  --headed --add-candidates. Данные: .local/marketplaces/ozon/ (gitignored).`);
  process.exit(0);
}
const HEADED = args.includes("--headed");
const SHOW_CANDIDATES = args.includes("--add-candidates");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const ts = () => new Date().toISOString().replace(/[:.]/g, "-");
const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
const esc = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const parsePrice = (t) => { const m = String(t || "").replace(/\u00a0/g, " ").match(/(\d[\d\s]*)\s*₽/); return m ? Number(m[1].replace(/[^\d]/g, "")) : null; };

async function extract(page) {
  return await page.evaluate(() => {
    const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
    const items = [];
    const seen = new Set();
    const links = Array.from(document.querySelectorAll('a[href*="/product/"]'));
    for (const a of links) {
      const href = a.href || a.getAttribute("href") || "";
      const m = href.match(/\/product\/[^/]*?(\d{6,})/);
      if (!m) continue;
      const id = m[1];
      if (seen.has(id)) continue;
      let card = a;
      for (let i = 0; i < 8 && card.parentElement; i++) {
        card = card.parentElement;
        const t = norm(card.textContent);
        if (/₽|c Ozon Картой|руб/i.test(t)) break;
      }
      const text = norm(card.textContent).slice(0, 700);
      const img = card.querySelector("img");
      const price = (text.match(/(\d[\d\s\u00a0]*)\s*₽/) || ["", ""])[0];
      const name = norm(a.textContent) || norm(a.getAttribute("title")) || norm(card.querySelector("[data-state] span, span")?.textContent);
      if (!name && !price) continue;
      items.push({
        marketplace: "ozon", sku: `ozon:${id}`, productId: id,
        url: href.split("?")[0], name: name.slice(0, 220), priceText: price,
        image: img ? (img.currentSrc || img.src || "") : "", rawText: text,
      });
      seen.add(id);
    }
    return {
      url: location.href, title: document.title, items,
      debug: { links: links.length, extracted: items.length, loginHint: /войти|вход/i.test(norm(document.body?.innerText || "")) },
    };
  });
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const profile = resolveEdgeProfile();
  log(`Edge профиль: ${profile}. Если Ozon просит вход/антибот — пройдите вручную в окне.`);
  const ctx = await chromium.launchPersistentContext(profile, { ...edgeLaunchOptions({ headed: HEADED, background: !HEADED }), userAgent: UA });
  try {
    const page = ctx.pages()[0] || (await ctx.newPage());
    const url = "https://www.ozon.ru/my/favorites";
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch((e) => log(`goto: ${e.message}`));
    log("Ожидание загрузки/входа (до 120 сек)...");
    const started = Date.now();
    let best = { items: [], debug: {} };
    while (Date.now() - started < 120000) {
      await page.waitForTimeout(4000);
      const snap = await extract(page);
      if ((snap.items || []).length >= best.items.length) best = snap;
      if (best.items.length > 0 && Date.now() - started > 15000) { await page.waitForTimeout(3000); best = await extract(page); break; }
    }
    const items = (best.items || []).map((it) => ({ ...it, price: parsePrice(it.priceText), importedAt: new Date().toISOString() }));
    const stamp = ts();
    const payload = { marketplace: "ozon", kind: "favorites", exportedAt: new Date().toISOString(), sourceUrl: best.url || url, pageTitle: best.title || "", debug: best.debug || {}, count: items.length, items, notice: "Локальный экспорт ЛК Ozon. Не коммитить." };
    const jsonFile = path.join(OUT_DIR, `favorites-${stamp}.json`);
    fs.writeFileSync(jsonFile, JSON.stringify(payload, null, 2) + "\n", "utf8");
    fs.writeFileSync(path.join(OUT_DIR, "favorites-latest.json"), JSON.stringify(payload, null, 2) + "\n", "utf8");
    const header = ["marketplace","sku","productId","name","price","url","image"];
    fs.writeFileSync(path.join(OUT_DIR, `favorites-${stamp}.csv`), "\ufeff"+[header.join(","),...items.map(it=>header.map(h=>esc(it[h])).join(","))].join("\n")+"\n", "utf8");
    log(`Готово: ${items.length}. ${jsonFile}`); log(`Debug: ${JSON.stringify(best.debug||{})}`);
    if (SHOW_CANDIDATES && items.length) {
      let existing = new Set();
      try { existing = new Set((JSON.parse(fs.readFileSync(PRODUCTS,"utf8"))||[]).map(p=>String(p.sku))); } catch {}
      const cand = items.filter(it=>!existing.has(it.sku));
      fs.writeFileSync(path.join(OUT_DIR, `favorites-candidates-${stamp}.json`), JSON.stringify({count:cand.length,items:cand},null,2));
      console.log(`Кандидаты: ${cand.length}`);
    }
  } finally { await ctx.close().catch(()=>{}); }
})().catch((e)=>{ console.error(e&&e.stack?e.stack:e); process.exit(1); });
