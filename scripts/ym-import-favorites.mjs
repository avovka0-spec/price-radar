#!/usr/bin/env node
// Локальный импорт избранного Яндекс Маркета (MVP, best-effort). Данные только в .local/.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { resolveEdgeProfile, edgeLaunchOptions } from "./lib/browser-profile.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, ".local", "marketplaces", "ym");
const PRODUCTS = path.join(ROOT, "public", "data", "products.json");
const args = process.argv.slice(2);
function has(n){return args.includes(n);} function getArg(n,d=null){const i=args.indexOf(n); if(i>=0&&args[i+1]&&!args[i+1].startsWith("-")) return args[i+1]; const eq=args.find(x=>x.startsWith(n+"=")); return eq?eq.slice(n.length+1):d;}
if (has("--help")||has("-h")) { console.log(`Импорт избранного Яндекс Маркета (локально)\n  --url <url> (по умолчанию /my/wishlist) --headed --add-candidates --scrolls N`); process.exit(0); }
const HEADED=has("--headed"), SHOW_CANDIDATES=has("--add-candidates"), SCROLLS=Math.max(0,Number(getArg("--scrolls","6"))||6);
const START_URL=getArg("--url","https://market.yandex.ru/my/wishlist");
const UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const ts=()=>new Date().toISOString().replace(/[:.]/g,"-"); const log=(m)=>console.log(`[${new Date().toISOString()}] ${m}`);
const esc=(v)=>{const s=String(v??""); return /[",\n]/.test(s)?`"${s.replace(/"/g,'""')}"`:s;};
const parsePrice=(t)=>{const m=String(t||"").replace(/\u00a0/g," ").match(/(\d[\d\s]*)\s*₽/); return m?Number(m[1].replace(/[^\d]/g,"")):null;};

function productIdFromUrl(href){
  const s=String(href||"");
  let m=s.match(/\/product--[^/]*\/(\d{5,})/); if(m) return m[1];
  m=s.match(/\/card\/[^/]*\/(\d{5,})/); if(m) return m[1];
  m=s.match(/[?&](?:productId|sku|id)=(\d{5,})/); if(m) return m[1];
  m=s.match(/\/(\d{7,})(?:[/?#]|$)/); return m?m[1]:null;
}

async function extract(page){ return await page.evaluate(()=>{
  const norm=s=>String(s||"").replace(/\s+/g," ").trim();
  const productIdFromUrl=(href)=>{ const s=String(href||""); let m=s.match(/\/product--[^/]*\/(\d{5,})/); if(m) return m[1]; m=s.match(/\/card\/[^/]*\/(\d{5,})/); if(m) return m[1]; m=s.match(/[?&](?:productId|sku|id)=(\d{5,})/); if(m) return m[1]; m=s.match(/\/(\d{7,})(?:[/?#]|$)/); return m?m[1]:null; };
  const items=[]; const seen=new Set();
  const anchors=Array.from(document.querySelectorAll('a[href*="/product"],a[href*="/card/"],a[href*="productId="]'));
  for(const a of anchors){
    const href=a.href||""; const id=productIdFromUrl(href); if(!id||seen.has(id)) continue;
    let card=a; for(let i=0;i<9&&card.parentElement;i++){ card=card.parentElement; const t=norm(card.textContent); if(/₽/.test(t) && t.length<1200) break; }
    const text=norm(card.textContent).slice(0,900);
    const img=card.querySelector("img");
    const priceText=(text.match(/(\d[\d\s\u00a0]*)\s*₽/)||["",""])[0];
    let name=norm(a.getAttribute("title"))||norm(a.textContent);
    if(!/[А-Яа-яA-Za-z]{4,}/.test(name)||name.length<8){ const cand=Array.from(card.querySelectorAll('a,span,h3,h4')).map(e=>norm(e.textContent)).find(t=>t.length>12&&t.length<260&&/[А-Яа-яA-Za-z]{4,}/.test(t)&&!/^\d[\d\s\u00a0]*\s*₽$/.test(t)&&!/отзыв|достав|купить/i.test(t)); if(cand) name=cand; }
    if(!name && !priceText) continue;
    items.push({marketplace:"ym",sku:`ym:${id}`,productId:id,url:href.split("?")[0],name:name.slice(0,260),priceText,image:img?(img.currentSrc||img.src||""):"",rawText:text});
    seen.add(id);
  }
  const body=norm(document.body?.innerText||"");
  return {url:location.href,title:document.title,items,debug:{links:anchors.length,extracted:items.length,loginHint:/войти|вход/i.test(body)&&items.length===0,antibotHint:/smartcaptcha|робот|подтвердите/i.test(body)}};
});}

(async()=>{
  fs.mkdirSync(OUT_DIR,{recursive:true});
  const profile=resolveEdgeProfile(); log(`Профиль Edge: ${profile}. ${START_URL}`);
  const ctx=await chromium.launchPersistentContext(profile,{...edgeLaunchOptions({headed:HEADED,background:!HEADED}),userAgent:UA});
  try{
    const page=ctx.pages()[0]||await ctx.newPage();
    await page.goto(START_URL,{waitUntil:"domcontentloaded",timeout:60000}).catch(e=>log(`goto: ${e.message}`));
    log("Ожидание/вход/антибот (до 150 сек)..."); const started=Date.now(); let best={items:[],debug:{}};
    while(Date.now()-started<150000){
      await page.waitForTimeout(4000);
      for(let i=0;i<SCROLLS&&Date.now()-started<150000;i++){ await page.evaluate(()=>window.scrollBy(0,Math.max(500,innerHeight*0.8))).catch(()=>{}); await page.waitForTimeout(1800); }
      const snap=await extract(page); if((snap.items||[]).length>=best.items.length) best=snap;
      if(best.items.length>0 && Date.now()-started>20000){ best=await extract(page); break; }
    }
    const items=(best.items||[]).map(it=>({...it,price:parsePrice(it.priceText),importedAt:new Date().toISOString()}));
    const stamp=ts(); const payload={marketplace:"ym",kind:"favorites",exportedAt:new Date().toISOString(),sourceUrl:best.url||START_URL,pageTitle:best.title||"",debug:best.debug||{},count:items.length,items,notice:"Локальный экспорт ЛК Яндекс Маркета. Не коммитить."};
    const jsonFile=path.join(OUT_DIR,`favorites-${stamp}.json`);
    fs.writeFileSync(jsonFile,JSON.stringify(payload,null,2)+"\n","utf8");
    fs.writeFileSync(path.join(OUT_DIR,"favorites-latest.json"),JSON.stringify(payload,null,2)+"\n","utf8");
    const header=["marketplace","sku","productId","name","price","url","image"];
    fs.writeFileSync(path.join(OUT_DIR,`favorites-${stamp}.csv`),"﻿"+[header.join(","),...items.map(it=>header.map(h=>esc(it[h])).join(","))].join("\n")+"\n","utf8");
    log(`Готово: ${items.length}. ${jsonFile}`); log(`Debug: ${JSON.stringify(best.debug||{})}`);
    if(SHOW_CANDIDATES&&items.length){ let existing=new Set(); try{existing=new Set((JSON.parse(fs.readFileSync(PRODUCTS,"utf8"))||[]).map(p=>String(p.sku)));}catch{} const cand=items.filter(it=>!existing.has(it.sku)); fs.writeFileSync(path.join(OUT_DIR,`favorites-candidates-${stamp}.json`),JSON.stringify({count:cand.length,items:cand},null,2)); console.log(`Кандидаты: ${cand.length}`); }
  } finally { await ctx.close().catch(()=>{}); }
})().catch(e=>{console.error(e&&e.stack?e.stack:e);process.exit(1);});
