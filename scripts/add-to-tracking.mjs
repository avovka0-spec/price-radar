#!/usr/bin/env node
// Безопасный локальный поток: импорт (.local) → выбор → добавить в трекинг (public/data/products.json).
// НЕ копирует заказы, rawText, персональные цены ЛК. НЕ делает git commit/push.
//
// Примеры:
//   node scripts/add-to-tracking.mjs -m wb --from-candidates --dry-run
//   node scripts/add-to-tracking.mjs -m ozon --from-favorites --all --dry-run
//   node scripts/add-to-tracking.mjs -m ozon --skus ozon:851822112,ozon:1147653759
//   node scripts/add-to-tracking.mjs -m ym --indexes 1,2,5 --with-price
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
function has(n){return argv.includes(n);} 
function getArg(names, def=null){ const list=Array.isArray(names)?names:[names]; for(const n of list){ const i=argv.indexOf(n); if(i>=0&&argv[i+1]&&!argv[i+1].startsWith("-")) return argv[i+1]; const eq=argv.find(x=>x.startsWith(n+"=")); if(eq) return eq.slice(n.length+1);} return def; }
if (has("--help")||has("-h")) {
  console.log(`Добавить товары из локального импорта в трекинг (public/data/products.json)
  -m, --marketplace <wb|ozon|ym|ali>   (обязательно)
  --source <path>                       файл импорта (иначе авто)
  --from-candidates                     последний favorites-candidates-*.json (если есть)
  --from-favorites                      favorites-latest.json
  --all                                 добавить всех кандидатов (которых нет в products.json)
  --skus <s1,s2>                        добавить указанные SKU/ID
  --indexes <1,2,3>                     номера из показанного списка (1-based)
  --pick                                интерактивный выбор номеров
  --with-price                          взять цену из импорта как начальную currentPrice (осторожно)
  --dry-run                             только показать, не записывать
Без --all/--skus/--indexes/--pick будет показан список кандидатов и подсказка.
НЕ копирует rawText/заказы/персональные цены ЛК. НЕ делает git commit/push.`);
  process.exit(0);
}

const marketplaceRaw=(getArg(["-m","--marketplace"],"")||"").toLowerCase();
const M = ({wb:"wb",wildberries:"wb",ozon:"ozon",ym:"ym","yandex-market":"ym",market:"ym",ali:"ali",aliexpress:"ali"})[marketplaceRaw];
if(!M){ console.error("Укажите --marketplace: wb|ozon|ym|ali"); process.exit(1); }

function readJson(p){ try{return JSON.parse(fs.readFileSync(p,"utf8"));}catch{return null;} }
function listFiles(dir, re){ try{return fs.readdirSync(dir).filter(f=>re.test(f)).map(f=>path.join(dir,f)).sort();}catch{return [];} }

const mDir = path.join(ROOT, ".local", "marketplaces", M);
let source = getArg("--source");
if(!source){
  const cands = listFiles(mDir, /^favorites-candidates-.*\.json$/);
  const fromC = has("--from-candidates") || (!has("--from-favorites") && cands.length);
  if(fromC && cands.length) source = cands[cands.length-1];
  else source = path.join(mDir, "favorites-latest.json");
}
source = path.isAbsolute(source) ? source : path.resolve(ROOT, source);
const imp = readJson(source);
if(!imp){ console.error(`Не найден/невалиден файл импорта: ${source}`); process.exit(1); }
const items = Array.isArray(imp.items) ? imp.items : Array.isArray(imp) ? imp : [];
if(!items.length){ console.error(`Нет items в ${source}`); process.exit(1); }

const productsPath = path.join(ROOT, "public", "data", "products.json");
const products = readJson(productsPath);
if(!Array.isArray(products)){ console.error(`Не найден/невалиден ${productsPath}`); process.exit(1); }

function wbImageUrl(sku){
  const n=Number(sku); if(!n) return undefined;
  const vol=Math.floor(n/100000), part=Math.floor(n/1000);
  const b= vol<=143?1:vol<=287?2:vol<=431?3:vol<=719?4:vol<=1007?5:vol<=1061?6:vol<=1115?7:vol<=1168?8:vol<=1220?9:vol<=1273?10:vol<=1326?11:vol<=1379?12:vol<=1432?13:vol<=2469?14:vol<=3129?15:16;
  return `https://basket-${String(b).padStart(2,"0")}.wbbasket.ru/vol${vol}/part${part}/${sku}/images/c246x328/1.webp`;
}

function normalizeSku(it){
  const m=M;
  if(m==="wb"){ const id=String(it.productId||it.sku||"").replace(/^wb:/,""); return { sku:id, marketplace:"wb", url: it.url || `https://www.wildberries.ru/catalog/${id}/detail.aspx`, image: it.image || wbImageUrl(id) }; }
  if(m==="ozon"){ const id=String(it.productId||it.sku||"").replace(/^ozon:/,""); return { sku:`ozon:${id}`, marketplace:"ozon", url: it.url || `https://www.ozon.ru/product/${id}/`, image: it.image }; }
  if(m==="ym"){ const id=String(it.productId||it.sku||"").replace(/^ym:/,""); return { sku:`ym:${id}`, marketplace:"ym", url: it.url || `https://market.yandex.ru/product--${id}/${id}`, image: it.image }; }
  if(m==="ali"){ const id=String(it.productId||it.sku||"").replace(/^ali:/,""); return { sku:`ali:${id}`, marketplace:"ali", url: it.url || `https://aliexpress.ru/item/${id}.html`, image: it.image }; }
  return null;
}

const existing = new Set(products.map(p=>String(p.sku)));
const candidates = items.map((it, i)=>{
  const n=normalizeSku(it); if(!n) return null;
  if(existing.has(n.sku)) return null;
  return { idx:i+1, ...n, name: String(it.name||it.title||it.slug||n.sku).slice(0,240), brand: String(it.brand||""), importPrice: typeof it.price==="number"?it.price:null, sourceUrl: n.url };
}).filter(Boolean);

console.log(`Источник: ${path.relative(ROOT, source)}`);
console.log(`В products.json: ${products.length}; кандидатов (нет в трекинге): ${candidates.length}`);
if(!candidates.length){ console.log("Нечего добавлять."); process.exit(0); }

for(const c of candidates.slice(0,80)){
  console.log(`${String(c.idx).padStart(3)}. [${c.marketplace}] ${c.sku} ${c.importPrice!=null?c.importPrice+" ₽":"—"}  ${c.name.slice(0,90)}`);
}
if(candidates.length>80) console.log(`... и ещё ${candidates.length-80}`);

function pickByArgs(){
  if(has("--all")) return candidates;
  const sk = getArg("--skus"); if(sk){ const want=new Set(sk.split(/[\s,]+/).map(s=>s.trim()).filter(Boolean)); return candidates.filter(c=>want.has(c.sku)||want.has(c.sku.replace(/^(ozon|ym|ali):/,""))); }
  const ix = getArg("--indexes"); if(ix){ const want=new Set(ix.split(/[\s,]+/).map(Number).filter(Number.isFinite)); return candidates.filter(c=>want.has(c.idx)); }
  return null;
}

async function pickInteractive(){
  if(!has("--pick")) return null;
  const rl = readline.createInterface({input, output});
  try{
    const ans = await rl.question("Введите номера через запятую (или all / пусто=отмена): ");
    const s=ans.trim(); if(!s) return [];
    if(/^all$/i.test(s)) return candidates;
    const want=new Set(s.split(/[\s,]+/).map(Number).filter(Number.isFinite));
    return candidates.filter(c=>want.has(c.idx));
  } finally { rl.close(); }
}

(async()=>{
  let selected = pickByArgs();
  if(!selected) selected = await pickInteractive();
  if(!selected){
    console.log("\nНичего не выбрано. Используйте --all, --skus, --indexes или --pick. Добавьте --dry-run для проверки.");
    process.exit(0);
  }
  if(!selected.length){ console.log("Пустой выбор."); process.exit(0); }

  const withPrice = has("--with-price");
  const now = Date.now();
  const additions = selected.map(c=>({
    id: crypto.randomUUID(),
    sku: c.sku,
    url: c.url,
    name: c.name,
    brand: c.brand || "",
    marketplace: c.marketplace,
    ...(c.image ? {image:c.image} : {}),
    ...(withPrice && c.importPrice!=null ? {currentPrice:c.importPrice} : {}),
    thresholdPct: 10,
    notify: true,
    addedAt: now,
  }));

  console.log(`\nБудет добавлено: ${additions.length}${withPrice?" (с ценой из импорта)":""}${has("--dry-run")?" [DRY RUN]":""}`);
  for(const a of additions.slice(0,20)) console.log(`  + [${a.marketplace}] ${a.sku} ${a.name.slice(0,70)}`);
  if(additions.length>20) console.log(`  ... +${additions.length-20}`);

  if(has("--dry-run")){ console.log("Dry run: products.json не изменён."); process.exit(0); }
  // safety: ensure we never write personal/LK-only fields from import
  const clean = additions.map(a=>{
    const { personalPrice, personalPriceCapturedAt, rawText, orders, items, text, pricesText, totalGuess, ...safe } = a;
    return safe;
  });
  const next = [...products, ...clean];
  fs.writeFileSync(productsPath, JSON.stringify(next, null, 2) + "\n", "utf8");
  console.log(`\nЗаписано: ${path.relative(ROOT, productsPath)} (${products.length} → ${next.length})`);
  console.log("Проверьте diff, затем при необходимости: git add public/data/products.json && git commit && git push");
  console.log("ВАЖНО: в products.json добавлены только данные для трекинга (SKU/URL/название/маркетплейс). Избранное/заказы/персональные цены ЛК не копируются.");
})().catch(e=>{ console.error(e&&e.stack?e.stack:e); process.exit(1); });
