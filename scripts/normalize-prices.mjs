#!/usr/bin/env node
// Нормализация: публичная цена (трекер/public/data) vs персональная цена из ЛК (локально).
//
// ВАЖНО: персональные данные читаются из .local/ и результат пишется только в .local/.
// Скрипт НИЧЕГО не пишет в public/data и не делает git commit/push.
//
// Использование:
//   node scripts/normalize-prices.mjs
//   node scripts/normalize-prices.mjs --marketplace wb
//   node scripts/normalize-prices.mjs --personal .local/marketplaces/wb/personal-prices-latest.json
//   node scripts/import.mjs -m wb -k normalize
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
function has(n) { return argv.includes(n); }
function getArg(name, def = null) {
  const i = argv.indexOf(name);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("-")) return argv[i + 1];
  const eq = argv.find((x) => x.startsWith(name + "="));
  return eq ? eq.slice(name.length + 1) : def;
}
if (has("--help") || has("-h")) {
  console.log(`Нормализация публичной и персональной цены (локально)
  --marketplace wb|all   фильтр (по умолчанию wb)
  --personal <path>      файл personal-prices-latest.json
  --products <path>      products.json (по умолчанию public/data/products.json)
Результат: .local/marketplaces/normalized-prices.json|csv (не коммитить).`);
  process.exit(0);
}

const marketplace = (getArg("--marketplace", "wb") || "wb").toLowerCase();
const productsPath = path.resolve(ROOT, getArg("--products", "public/data/products.json"));
const personalPath = getArg("--personal")
  ? path.resolve(ROOT, getArg("--personal"))
  : path.join(ROOT, ".local", "marketplaces", marketplace === "all" ? "wb" : marketplace, "personal-prices-latest.json");
const outDir = path.join(ROOT, ".local", "marketplaces");
const esc = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

const products = readJson(productsPath);
if (!Array.isArray(products)) {
  console.error(`Не удалось прочитать products: ${productsPath}`);
  process.exit(1);
}
const personal = readJson(personalPath);
if (!personal || !Array.isArray(personal.items)) {
  console.error(`Не найден/невалиден снимок персональных цен: ${personalPath}`);
  console.error("Сначала запустите: node scripts/import.mjs -m wb -k prices --from-products (или --from-favorites-latest)");
  process.exit(1);
}

const personalBySku = new Map();
for (const it of personal.items) personalBySku.set(String(it.sku), it);

const rows = [];
for (const p of products) {
  const m = String(p.marketplace || "wb").toLowerCase();
  if (marketplace !== "all" && m !== marketplace) continue;
  const sku = String(p.sku);
  const pers = personalBySku.get(sku);
  const publicPrice = num(p.currentPrice);
  const personalPrice = pers ? num(pers.personalPrice) : null;
  const crossedPrice = pers ? num(pers.crossedPrice) : null;
  const delta = publicPrice != null && personalPrice != null ? personalPrice - publicPrice : null;
  const deltaPct = publicPrice && delta != null ? (delta / publicPrice) * 100 : null;
  rows.push({
    marketplace: m,
    sku,
    name: p.name || "",
    brand: p.brand || "",
    url: p.url || "",
    publicPrice,
    personalPrice,
    crossedPrice,
    delta,
    deltaPct: deltaPct != null ? Number(deltaPct.toFixed(2)) : null,
    personalCapturedAt: pers?.capturedAt || null,
    publicCheckedAt: p.lastCheckedAt ? new Date(p.lastCheckedAt).toISOString() : null,
    priceSourcePublic: "tracker/public",
    priceSourcePersonal: pers ? "wb_lk_profile" : null,
    flags: {
      hasPersonal: !!pers,
      cheaperInProfile: delta != null ? delta < 0 : null,
      loginHint: !!pers?.loginHint,
      walletHint: !!pers?.walletHint,
      couponHint: !!pers?.couponHint,
    },
  });
}

fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const payload = {
  kind: "normalized-prices",
  exportedAt: new Date().toISOString(),
  marketplace,
  notice: "Локальная нормализация. Содержит персональные цены — НЕ коммитить, НЕ публиковать.",
  sources: { products: path.relative(ROOT, productsPath), personal: path.relative(ROOT, personalPath) },
  count: rows.length,
  items: rows,
};
const jsonFile = path.join(outDir, `normalized-prices-${stamp}.json`);
const latest = path.join(outDir, "normalized-prices-latest.json");
const csvFile = path.join(outDir, `normalized-prices-${stamp}.csv`);
fs.writeFileSync(jsonFile, JSON.stringify(payload, null, 2) + "\n", "utf8");
fs.writeFileSync(latest, JSON.stringify(payload, null, 2) + "\n", "utf8");
const header = ["marketplace","sku","name","publicPrice","personalPrice","crossedPrice","delta","deltaPct","personalCapturedAt","cheaperInProfile","url"];
fs.writeFileSync(csvFile, "\ufeff" + [header.join(","), ...rows.map(r => header.map(h => {
  const v = h === "cheaperInProfile" ? r.flags?.cheaperInProfile : r[h];
  return esc(v == null ? "" : v);
}).join(","))].join("\n") + "\n", "utf8");

const withPersonal = rows.filter(r => r.flags.hasPersonal).length;
const cheaper = rows.filter(r => r.flags.cheaperInProfile === true).length;
console.log(`Товаров: ${rows.length}; с персональной ценой: ${withPersonal}; дешевле в профиле: ${cheaper}`);
for (const r of rows.filter(r => r.flags.hasPersonal).slice(0, 15)) {
  const d = r.delta == null ? "" : ` (Δ ${r.delta > 0 ? "+" : ""}${r.delta} ₽, ${r.deltaPct}%)`;
  console.log(`- ${r.sku} ${r.name.slice(0,50)}: public ${r.publicPrice ?? "?"} / personal ${r.personalPrice ?? "?"}${d}`);
}
console.log(`JSON: ${jsonFile}`);
console.log(`CSV:  ${csvFile}`);
console.log("ВНИМАНИЕ: результат содержит персональные данные/цены ЛК — не коммитить.");
