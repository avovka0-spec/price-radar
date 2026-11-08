#!/usr/bin/env node
// Локальный импорт избранного/wishlist AliExpress (MVP, best-effort). Данные только в .local/.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { resolveEdgeProfile, edgeLaunchOptions } from "./lib/browser-profile.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, ".local", "marketplaces", "ali");
const PRODUCTS = path.join(ROOT, "public", "data", "products.json");
const args = process.argv.slice(2);
function has(n){return args.includes(n);} function getArg(n,d=null){const i=args.indexOf(n); if(i>=0&&args[i+1]&&!args[i+1].startsWith("-")) return args[i+1]; const eq=args.find(x=>x.startsWith(n+"=")); return eq?eq.slice(n.length+1):d;}
if (has("--help")||has("-h")) { console.log(`Импорт избранного AliExpress/aliexpress.ru (локально)\n  --url <url> (по умолчанию wishlist aliexpress.ru) --headed --add-candidates --scrolls N\n  Если ваш URL избранного отличается, обязательно укажите --url.`); process.exit(0); }
const HEADED=has("--headed"), SHOW_CANDIDATES=has("--add-candidates"), SCROLLS=Math.max(0,Number(getArg("--scrolls","8"))||8);
const START_URL=getArg("--url","https://aliexpress.ru/p/wishlist/index.html");
if(!getArg("--url")) log("Внимание: дефолтный URL aliexpress.ru может не совпадать с вашим аккаунтом. Если откроется не избранное/будет редирект — запустите с --url \"<ваш фактический URL избранного на aliexpress.ru>\".");
const UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const ts=()=>new Date().toISOString().replace(/[:.]/g,"-"); const log=(m)=>console.log(`[${new Date().toISOString()}] ${m}`);
const esc=(v)=>{const s=String(v??""); return /[",\n]/.test(s)?`"${s.replace(/"/g,'""')}"`:s;};
const parsePrice=(t)=>{ const s=String(t||"").replace(/\u00a0/g," ").replace(/,/g,"."); const m=s.match(/(\d[\d\s]*[.,]?\d*)\s*(₽|руб|RUB)/i)||s.match(/(₽|руб|RUB)\s*(\d[\d\s]*[.,]?\d*)/i); if(!m) return null; const n=Number(String(m[1]||m[2]).replace(/[^\d.]/g,"")); return Number.isFinite(n)?Math.round(n):null; };

async function extract(page){ return await page.evaluate(()=>{
  const norm=s=>String(s||"").replace(/\s+/g," ").trim();
  const junk=t=>/window\.__|__INITIAL_STATE__|webpackJsonp|baobab/i.test(String(t||""));
  const productId=(href)=>{ const s=String(href||""); let m=s.match(/\/item\/(\d{6,})\.html/); if(m) return m[1]; m=s.match(/\/product\/(\d{6,})\.html/); if(m) return m[1]; m=s.match(/[?&](?:productId|product_id|sku_id|id)=(\d{6,})/); if(m) return m[1]; m=s.match(/\/(\d{10,})(?:[/?#]|$)/); return m?m[1]:null; };
  const visibleText=el=>{ try{ if(el?.innerText) return norm(el.innerText);}catch{} const c=el?.cloneNode?.(true); c?.querySelectorAll?.('script,style,noscript').forEach(n=>n.remove()); return norm(c?.innerText||c?.textContent||""); };
  const nameFromSlug=href=>{ const m=String(href||"").match(/\/item\/([^/]+)\.html/); if(!m) return ""; try{return decodeURIComponent(m[1]).replace(/[-_]+/g," ").trim();}catch{return m[1].replace(/[-_]+/g," ");} };
  const isGoodName=t=>{ const s=norm(t); return s.length>=8&&s.length<=320&&!junk(s)&&/[A-Za-zА-Яа-я\u4e00-\u9fff]{3,}/.test(s)&&!/^\d[\d\s.,]*\s*(₽|руб|RUB|US \$|\$)?$/i.test(s); };
  const items=[]; const seen=new Set();
  const anchors=Array.from(document.querySelectorAll('a[href*="/item/"],a[href*="/product/"],a[href*="productId="],a[href*="product_id="],a[href*="aliexpress.ru/item"],a[href*="aliexpress.com/item"]'));
  let junkSkipped=0;
  for(const a of anchors){
    const href=a.href||""; const id=productId(href); if(!id||seen.has(id)) continue;
    let card=a; for(let i=0;i<10&&card.parentElement;i++){ card=card.parentElement; const t=visibleText(card); if(!junk(t)&&/₽|руб|RUB|\$/.test(t)&&t.length<1500) break; if(!junk(t)&&t.length<900&&card.querySelector('img')) break; }
    const text=visibleText(card).slice(0,1000);
    if(junk(text)){ junkSkipped++; seen.add(id); continue; }
    const img=card.querySelector("img");
    const priceText=(text.match(/(\d[\d\s.,]*)\s*(?:₽|руб|RUB)/i)||text.match(/(?:₽|руб|RUB)\s*(\d[\d\s.,]*)/i)||text.match(/US\s*\$\s*[\d.,]+|\$\s*[\d.,]+/i)||["",""])[0];
    let name=norm(a.getAttribute("title"))||norm(img?.getAttribute("alt"));
    if(!isGoodName(name)){ const cand=Array.from(card.querySelectorAll('h1,h2,h3,a[title],[title],span,div')).map(e=>norm(e.getAttribute?.('title')||e.textContent)).find(isGoodName); name=cand||nameFromSlug(href)||""; }
    if(!name && !priceText) continue;
    items.push({marketplace:"ali",sku:`ali:${id}`,productId:id,url:href.split("?")[0].replace(/^\/\//,"https://"),name:name.slice(0,320),priceText:priceText||"",image:img?(img.currentSrc||img.src||""):"",rawText:text});
    seen.add(id);
  }
  const body=norm(document.body?.innerText||"");
  return {url:location.href,title:document.title,items,debug:{links:anchors.length,extracted:items.length,junkSkipped,loginHint:/sign in|log in|войти|вход|регистрация/i.test(body)&&items.length===0,antibotHint:/captcha|robot|verify|punish|blocked|slide to verify/i.test(body)||/captcha|punish/i.test(document.documentElement.innerHTML)}};
});}

(async()=>{
  fs.mkdirSync(OUT_DIR,{recursive:true});
  const profile=resolveEdgeProfile(); log(`Профиль Edge: ${profile}. ${START_URL}`);
  const ctx=await chromium.launchPersistentContext(profile,{...edgeLaunchOptions({headed:HEADED,background:!HEADED}),userAgent:UA});
  try{
    const page=ctx.pages()[0]||await ctx.newPage();
    await page.goto(START_URL,{waitUntil:"domcontentloaded",timeout:60000}).catch(e=>log(`goto: ${e.message}`));
    log("Ожидание/вход/антибот (до 180 сек)..."); const started=Date.now(); let best={items:[],debug:{}};
    while(Date.now()-started<180000){
      await page.waitForTimeout(4000);
      for(let i=0;i<SCROLLS&&Date.now()-started<180000;i++){ await page.evaluate(()=>window.scrollBy(0,Math.max(500,innerHeight*0.8))).catch(()=>{}); await page.waitForTimeout(2200); }
      const snap=await extract(page); if((snap.items||[]).length>=best.items.length) best=snap;
      if(best.items.length>0 && Date.now()-started>25000){ await page.waitForTimeout(3000); best=await extract(page); break; }
    }
    const items=(best.items||[]).map(it=>({...it,price:parsePrice(it.priceText),importedAt:new Date().toISOString()}));
    const stamp=ts(); const payload={marketplace:"ali",kind:"favorites",exportedAt:new Date().toISOString(),sourceUrl:best.url||START_URL,pageTitle:best.title||"",debug:best.debug||{},count:items.length,items,notice:"Локальный экспорт wishlist AliExpress. Не коммитить."};
    const jsonFile=path.join(OUT_DIR,`favorites-${stamp}.json`);
    fs.writeFileSync(jsonFile,JSON.stringify(payload,null,2)+"\n","utf8");
    fs.writeFileSync(path.join(OUT_DIR,"favorites-latest.json"),JSON.stringify(payload,null,2)+"\n","utf8");
    const header=["marketplace","sku","productId","name","price","priceText","url","image"];
    fs.writeFileSync(path.join(OUT_DIR,`favorites-${stamp}.csv`),"﻿"+[header.join(","),...items.map(it=>header.map(h=>esc(it[h])).join(","))].join("\n")+"\n","utf8");
    log(`Готово: ${items.length}. ${jsonFile}`); log(`Debug: ${JSON.stringify(best.debug||{})}`);
    if(SHOW_CANDIDATES&&items.length){ let existing=new Set(); try{existing=new Set((JSON.parse(fs.readFileSync(PRODUCTS,"utf8"))||[]).map(p=>String(p.sku)));}catch{} const cand=items.filter(it=>!existing.has(it.sku)); fs.writeFileSync(path.join(OUT_DIR,`favorites-candidates-${stamp}.json`),JSON.stringify({count:cand.length,items:cand},null,2)); console.log(`Кандидаты: ${cand.length}`); }
  } finally { await ctx.close().catch(()=>{}); }
})().catch(e=>{console.error(e&&e.stack?e.stack:e);process.exit(1);});
