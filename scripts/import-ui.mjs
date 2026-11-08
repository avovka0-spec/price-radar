#!/usr/bin/env node
// Локальный UI (без бэкенда, только 127.0.0.1): импорт (.local) → выбор → добавить в трекинг.
// Читает .local/marketplaces/* и public/data/products.json; пишет ТОЛЬКО public/data/products.json.
// НЕ копирует/не отдаёт rawText, заказы, персональные цены ЛК. НЕ делает git commit/push.
//
//   node scripts/import-ui.mjs [--port 3847] [--open]
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const getArg = (n, d=null) => { const i=argv.indexOf(n); if(i>=0&&argv[i+1]&&!argv[i+1].startsWith("-")) return argv[i+1]; const eq=argv.find(x=>x.startsWith(n+"=")); return eq?eq.slice(n.length+1):d; };
const PORT = Math.max(1024, Number(getArg("--port", "3847")) || 3847);
const HOST = "127.0.0.1";
const LOCAL_DIR = path.join(ROOT, ".local");

const M = { wb:"wb", ozon:"ozon", ym:"ym", ali:"ali" };
function readJson(p){ try{return JSON.parse(fs.readFileSync(p,"utf8"));}catch{return null;} }
function listFiles(dir, re){ try{return fs.readdirSync(dir).filter(f=>re.test(f)).map(f=>path.join(dir,f)).sort();}catch{return [];} }
function wbImageUrl(sku){
  const n=Number(sku); if(!n) return undefined;
  const vol=Math.floor(n/100000), part=Math.floor(n/1000);
  const b= vol<=143?1:vol<=287?2:vol<=431?3:vol<=719?4:vol<=1007?5:vol<=1061?6:vol<=1115?7:vol<=1168?8:vol<=1220?9:vol<=1273?10:vol<=1326?11:vol<=1379?12:vol<=1432?13:vol<=2469?14:vol<=3129?15:16;
  return `https://basket-${String(b).padStart(2,"0")}.wbbasket.ru/vol${vol}/part${part}/${sku}/images/c246x328/1.webp`;
}
function normalizeItem(it, m){
  if(m==="wb"){ const id=String(it.productId||it.sku||"").replace(/^wb:/,""); if(!id) return null; return { sku:id, marketplace:"wb", url: it.url || `https://www.wildberries.ru/catalog/${id}/detail.aspx`, image: it.image || wbImageUrl(id) }; }
  if(m==="ozon"){ const id=String(it.productId||it.sku||"").replace(/^ozon:/,""); if(!id) return null; return { sku:`ozon:${id}`, marketplace:"ozon", url: it.url || `https://www.ozon.ru/product/${id}/`, image: it.image }; }
  if(m==="ym"){ const id=String(it.productId||it.sku||"").replace(/^ym:/,""); if(!id) return null; return { sku:`ym:${id}`, marketplace:"ym", url: it.url || `https://market.yandex.ru/product--${id}/${id}`, image: it.image }; }
  if(m==="ali"){ const id=String(it.productId||it.sku||"").replace(/^ali:/,""); if(!id) return null; return { sku:`ali:${id}`, marketplace:"ali", url: it.url || `https://aliexpress.ru/item/${id}.html`, image: it.image }; }
  return null;
}
function safeSourcePath(m, source){
  const mDir = path.resolve(LOCAL_DIR, "marketplaces", m);
  if(!fs.existsSync(mDir)) return null;
  let p = source ? (path.isAbsolute(source) ? path.resolve(source) : path.resolve(mDir, source)) : null;
  if(!p){
    const cands = listFiles(mDir, /^favorites-candidates-.*\.json$/);
    p = cands.length ? cands[cands.length-1] : path.join(mDir, "favorites-latest.json");
  }
  const rp = path.resolve(p);
  if(!(rp === LOCAL_DIR || rp.startsWith(LOCAL_DIR + path.sep))) return null;
  return rp;
}
function getCandidates(m, source){
  const productsPath = path.join(ROOT, "public", "data", "products.json");
  const products = readJson(productsPath);
  if(!Array.isArray(products)) return { error: "Не найден/невалиден public/data/products.json" };
  const src = safeSourcePath(m, source);
  if(!src) return { error: "Недопустимый источник (только .local)" };
  const imp = readJson(src);
  if(!imp) return { error: `Не найден/невалиден файл: ${path.relative(ROOT, src)}` };
  const items = Array.isArray(imp.items) ? imp.items : Array.isArray(imp) ? imp : [];
  const existing = new Set(products.map(p=>String(p.sku)));
  const candidates = [];
  let idx=0;
  for(const it of items){
    const n = normalizeItem(it, m); if(!n) continue;
    idx++;
    if(existing.has(n.sku)) continue;
    candidates.push({ idx, sku:n.sku, marketplace:n.marketplace, url:n.url, name:String(it.name||it.title||it.slug||n.sku).slice(0,240), brand:String(it.brand||""), importPrice: typeof it.price==="number"?it.price:null, image:n.image||null });
  }
  return { source: path.relative(ROOT, src), productsCount: products.length, totalItems: items.length, candidatesCount: candidates.length, candidates };
}
function addSelected(m, source, skus, withPrice){
  const productsPath = path.join(ROOT, "public", "data", "products.json");
  const products = readJson(productsPath);
  if(!Array.isArray(products)) return { error: "Не найден/невалиден public/data/products.json" };
  const src = safeSourcePath(m, source);
  if(!src) return { error: "Недопустимый источник" };
  const imp = readJson(src);
  if(!imp) return { error: `Не найден/невалиден файл: ${path.relative(ROOT, src)}` };
  const items = Array.isArray(imp.items) ? imp.items : Array.isArray(imp) ? imp : [];
  const existing = new Set(products.map(p=>String(p.sku)));
  const want = new Set((skus||[]).map(String));
  const now = Date.now();
  const additions = [];
  for(const it of items){
    const n = normalizeItem(it, m); if(!n) continue;
    if(!want.has(n.sku)) continue;
    if(existing.has(n.sku)) continue;
    const name = String(it.name||it.title||it.slug||n.sku).slice(0,240);
    const brand = String(it.brand||"");
    const price = (withPrice && typeof it.price==="number") ? it.price : undefined;
    additions.push({
      id: crypto.randomUUID(), sku: n.sku, url: n.url, name, brand, marketplace: n.marketplace,
      ...(n.image ? {image:n.image} : {}),
      ...(price!=null ? {currentPrice:price} : {}),
      thresholdPct: 10, notify: true, addedAt: now,
    });
    existing.add(n.sku);
  }
  if(!additions.length) return { ok:true, added:0, message:"Нечего добавлять (возможно, уже в трекинге или пустой выбор)." };
  // safety: only tracking fields
  const clean = additions.map(a=>{ const {personalPrice,personalPriceCapturedAt,rawText,orders,items:_,text,pricesText,totalGuess,...safe}=a; return safe; });
  fs.writeFileSync(productsPath, JSON.stringify([...products, ...clean], null, 2) + "\n", "utf8");
  return { ok:true, added: clean.length, total: products.length + clean.length, skus: clean.map(x=>x.sku) };
}

function send(res, code, body, type="application/json; charset=utf-8"){
  const b = type.startsWith("application/json") ? JSON.stringify(body) : body;
  res.writeHead(code, {"Content-Type": type, "Cache-Control":"no-store"});
  res.end(b);
}
async function readBody(req){ return await new Promise((resolve)=>{ let d=""; req.on("data",c=>d+=c); req.on("end",()=>{ try{resolve(d?JSON.parse(d):{});}catch{resolve({});} }); }); }

const HTML = `<!doctype html><html lang="ru"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>ЦенРадар — локальный импорт в трекинг</title>
<style>
:root{--bg:#0b1020;--card:#141c33;--muted:#93a0c6;--text:#eaf0ff;--acc:#5b8cff;--ok:#37c871;--warn:#ffb020;--bad:#ff5d6c;--line:#263258}
*{box-sizing:border-box}body{margin:0;font:14px/1.45 system-ui,Segoe UI,Arial;background:linear-gradient(180deg,#090e1b,#0b1020);color:var(--text)}
.wrap{max-width:1100px;margin:0 auto;padding:18px}h1{font-size:20px;margin:0 0 4px}.sub{color:var(--muted);margin:0 0 14px}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:end}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px;margin:10px 0}
label{display:block;color:var(--muted);font-size:12px;margin-bottom:4px}select,input,button{background:#0f1730;color:var(--text);border:1px solid var(--line);border-radius:8px;padding:8px 10px}
button{cursor:pointer;background:#18265a;border-color:#2f4594}button.primary{background:var(--acc);border-color:var(--acc);color:#081022;font-weight:600}
button:disabled{opacity:.5;cursor:default}.muted{color:var(--muted)}.ok{color:var(--ok)}.warn{color:var(--warn)}.err{color:var(--bad)}
table{width:100%;border-collapse:collapse}th,td{padding:7px 6px;border-bottom:1px solid var(--line);vertical-align:top;text-align:left;font-size:13px}
th{color:var(--muted);font-weight:600}tr:hover td{background:#10193a}.name{max-width:520px}.price{white-space:nowrap}
.pill{display:inline-block;padding:1px 7px;border-radius:999px;font-size:11px;background:#1c2857;color:#bfd0ff}
#status{white-space:pre-wrap}.toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:8px 0}
a{color:#9ec1ff}
</style></head><body><div class="wrap">
<h1>ЦенРадар — локальный импорт в трекинг</h1>
<p class="sub">Только <b>127.0.0.1</b>. Читает <code>.local/marketplaces/*</code>, пишет <b>только</b> <code>public/data/products.json</code>. Не копирует заказы/<code>rawText</code>/персональные цены ЛК. Не делает git commit/push.</p>
<div class="card row">
  <div><label>Маркетплейс</label><select id="m"><option value="wb">WB</option><option value="ozon">Ozon</option><option value="ym">Яндекс Маркет</option><option value="ali">AliExpress (ru)</option></select></div>
  <div style="flex:1;min-width:260px"><label>Источник (.local, опционально имя файла)</label><input id="src" placeholder="пусто = авто (candidates/favorites-latest)" style="width:100%"/></div>
  <div><label>&nbsp;</label><button id="load" class="primary">Загрузить кандидатов</button></div>
</div>
<div class="card">
  <div class="toolbar">
    <button id="selAll">Выбрать всех</button>
    <button id="selNone">Снять выбор</button>
    <label style="display:inline-flex;gap:6px;align-items:center;color:var(--text)"><input type="checkbox" id="withPrice"/> взять цену из импорта как начальную (осторожно)</label>
    <button id="add" class="primary">Добавить выбранные в трекинг</button>
    <span id="meta" class="muted"></span>
  </div>
  <div id="status" class="muted"></div>
  <div style="overflow:auto;max-height:62vh"><table><thead><tr><th></th><th>#</th><th>Маркет</th><th>SKU</th><th class="name">Название</th><th class="price">Цена (импорт)</th><th></th></tr></thead><tbody id="tb"></tbody></table></div>
</div>
</div>
<script>
const $=s=>document.querySelector(s); let data=null;
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function load(){
  $('#status').textContent='Загрузка...'; $('#tb').innerHTML=''; $('#add').disabled=true;
  const m=$('#m').value, source=$('#src').value.trim();
  const r=await fetch('/api/candidates?marketplace='+encodeURIComponent(m)+'&source='+encodeURIComponent(source));
  data=await r.json();
  if(!r.ok||data.error){ $('#status').innerHTML='<span class="err">'+esc(data.error||'Ошибка')+'</span>'; $('#meta').textContent=''; return; }
  $('#meta').textContent = 'Источник: '+data.source+' · в products.json: '+data.productsCount+' · в импорте: '+data.totalItems+' · кандидатов: '+data.candidatesCount;
  if(!data.candidates.length){ $('#status').innerHTML='<span class="ok">Нечего добавлять (все уже в трекинге или импорт пуст).</span>'; return; }
  $('#status').textContent='';
  $('#tb').innerHTML=data.candidates.map(c=>'<tr><td><input type="checkbox" class="ck" value="'+esc(c.sku)+'"></td><td class="muted">'+c.idx+'</td><td><span class="pill">'+esc(c.marketplace)+'</span></td><td><code>'+esc(c.sku)+'</code></td><td class="name">'+esc(c.name)+'</td><td class="price">'+(c.importPrice!=null?esc(c.importPrice)+' ₽':'—')+'</td><td>'+(c.url?'<a href="'+esc(c.url)+'" target="_blank" rel="noreferrer">открыть</a>':'')+'</td></tr>').join('');
  $('#add').disabled=false;
}
$('#load').onclick=load;
$('#selAll').onclick=()=>document.querySelectorAll('.ck').forEach(c=>c.checked=true);
$('#selNone').onclick=()=>document.querySelectorAll('.ck').forEach(c=>c.checked=false);
$('#add').onclick=async()=>{
  const skus=[...document.querySelectorAll('.ck:checked')].map(c=>c.value);
  if(!skus.length){ $('#status').innerHTML='<span class="warn">Выберите хотя бы один товар.</span>'; return; }
  $('#add').disabled=true; $('#status').textContent='Добавляю...';
  const r=await fetch('/api/add',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({marketplace:$('#m').value,source:$('#src').value.trim(),skus,withPrice:$('#withPrice').checked})});
  const j=await r.json();
  if(!r.ok||j.error){ $('#status').innerHTML='<span class="err">'+esc(j.error||'Ошибка')+'</span>'; $('#add').disabled=false; return; }
  $('#status').innerHTML='<span class="ok">Добавлено: '+j.added+'. Всего в products.json: '+j.total+'.</span> Проверьте <code>git diff -- public/data/products.json</code>, затем при необходимости commit/push (только трекинг-данные).';
  await load();
};
</script></body></html>`;

const server = http.createServer(async (req, res)=>{
  try{
    const u = new URL(req.url || "/", `http://${HOST}:${PORT}`);
    if(req.method==="GET" && u.pathname==="/"){ return send(res,200,HTML,"text/html; charset=utf-8"); }
    if(req.method==="GET" && u.pathname==="/api/candidates"){
      const m = M[String(u.searchParams.get("marketplace")||"").toLowerCase()];
      if(!m) return send(res,400,{error:"marketplace: wb|ozon|ym|ali"});
      return send(res,200,getCandidates(m, u.searchParams.get("source")||""));
    }
    if(req.method==="POST" && u.pathname==="/api/add"){
      const b = await readBody(req);
      const m = M[String(b.marketplace||"").toLowerCase()];
      if(!m) return send(res,400,{error:"marketplace: wb|ozon|ym|ali"});
      return send(res,200,addSelected(m, b.source||"", Array.isArray(b.skus)?b.skus:[], !!b.withPrice));
    }
    return send(res,404,{error:"not found"});
  }catch(e){ return send(res,500,{error: String(e&&e.message||e)}); }
});

server.listen(PORT, HOST, ()=>{
  const url = `http://${HOST}:${PORT}/`;
  console.log(`Локальный UI ЦенРадара: ${url}`);
  console.log("Только localhost. Данные ЛК не копируются в public/data. Без git commit/push.");
  if(argv.includes("--open")){
    const cmd = process.platform==="win32" ? ["cmd",["/c","start","",url]] : process.platform==="darwin" ? ["open",[url]] : ["xdg-open",[url]];
    try{ spawn(cmd[0], cmd[1], {stdio:"ignore", detached:true}).unref(); }catch{}
  }
});
