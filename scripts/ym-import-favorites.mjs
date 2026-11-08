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
  const junk=t=>/window\.apiary|apiaryMarkerPortal|apiarySleepingQueue|\{"widgets"|"widgets":\{|baobab/i.test(String(t||""));
  const visibleText=el=>{ try{ const t=el?.innerText; if(t) return norm(t); }catch{} return norm(el?.textContent||""); };
  const productIdFromUrl=(href)=>{ const s=String(href||""); let m=s.match(/\/product--[^/]*\/(\d{5,})/); if(m) return m[1]; m=s.match(/\/card\/[^/]*\/(\d{5,})/); if(m) return m[1]; m=s.match(/[?&](?:productId|sku|id)=(\d{5,})/); if(m) return m[1]; m=s.match(/\/(\d{7,})(?:[/?#]|$)/); return m?m[1]:null; };
  const nameFromSlug=(href)=>{ const m=String(href||"").match(/\/(?:product--|card\/)([^/?#]+)/); if(!m) return ""; try{ return decodeURIComponent(m[1]).replace(/[-_]+/g," ").replace(/\s+/g," ").trim(); }catch{return m[1].replace(/[-_]+/g," ");} };
  const badName=t=>/Рейтинг товара|Оценок[:\s(]|\d[\d.,]*\s*\(\d+\)\s*[·•]\s*\d+\s*купил|купили$|отзыв|достав|купить|в корзин|поделиться|сравнить|Цена с картой|Яндекс Пэй|Промокод|Финальная цена/i.test(String(t||""));
  const isGoodName=t=>{ const s=norm(t); return s.length>=8 && s.length<=300 && !junk(s) && !badName(s) && /[А-Яа-яA-Za-z]{3,}/.test(s) && !/^\d[\d\s\u00a0]*\s*₽$/.test(s) && !/^(войти|вход|корзин|избранн)$/i.test(s); };
  const cleanSlug=s=>norm(String(s||"").replace(/\b\d{6,}\b/g," ")).slice(0,220);
  const nameFromRaw=raw=>{
    let t=norm(raw);
    t=t.replace(/^\d+\s*%\s*(ПРОМОКОД|скидк[аи])\s*/iu,"").replace(/^(ПРОМОКОД|Распродажа|Хит)\s*/iu,"").trim();
    const cut=t.search(/Цена с картой|Яндекс Пэй|\bПэй\b|\d[\d\s\u00a0]*\s*₽|Рейтинг товара|Оценок|купили|доставк|Из-за рубежа/i);
    if(cut>8) t=t.slice(0,cut).trim();
    return isGoodName(t)?t:"";
  };
  const pickName=(card,a,href,rawText)=>{
    const cands=[];
    const add=(v,score=0)=>{ const s=norm(v); if(isGoodName(s)) cands.push({s,score}); };
    add(card.querySelector('h1,h2,h3,h4,[data-auto*="title"],[data-zone-name*="title"]')?.innerText,5);
    add(a.getAttribute("title"),4); add(a.getAttribute("aria-label"),3);
    add(card.querySelector('img[alt]')?.getAttribute('alt'),2);
    for(const el of Array.from(card.querySelectorAll('a[title],a span,span,div')).slice(0,140)){
      const s=norm(el.getAttribute?.('title')||el.textContent);
      if(isGoodName(s)) cands.push({s,score:s.length>20&&s.length<140?2:1});
    }
    const fromRaw=nameFromRaw(rawText); if(fromRaw) cands.push({s:fromRaw,score:6});
    const slug=cleanSlug(nameFromSlug(href)); if(isGoodName(slug)) cands.push({s:slug,score:1});
    cands.sort((x,y)=> (y.score-x.score) || (Math.abs(x.s.length-75)-Math.abs(y.s.length-75)));
    return cands[0]?.s||"";
  };

  const items=[]; const seen=new Set();
  const anchors=Array.from(document.querySelectorAll('a[href*="/product--"],a[href*="/card/"],a[href*="productId="]'));
  let junkSkipped=0;
  for(const a of anchors){
    const href=a.href||a.getAttribute("href")||""; const id=productIdFromUrl(href); if(!id||seen.has(id)) continue;
    let card=a;
    for(let i=0;i<10&&card.parentElement;i++){
      card=card.parentElement;
      const t=visibleText(card);
      if(!junk(t) && /₽/.test(t) && t.length>20 && t.length<1400) break;
      if(!junk(t) && t.length>30 && t.length<900 && card.querySelector('img')) break;
    }
    let text=visibleText(card);
    if(junk(text)){
      // попытка взять поддерево без hydration-скриптов
      const clone=card.cloneNode(true);
      clone.querySelectorAll('script,style,noscript').forEach(n=>n.remove());
      text=norm(clone.innerText||clone.textContent||"");
    }
    if(junk(text)){ junkSkipped++; seen.add(id); continue; }
    text=text.slice(0,1000);
    const img=card.querySelector("img");
    const priceText=(text.match(/(\d[\d\s\u00a0]*)\s*₽/)||["",""])[0];
    const name=pickName(card,a,href,text);
    if(!name && !priceText) continue;
    const slug=nameFromSlug(href);
    items.push({marketplace:"ym",sku:`ym:${id}`,productId:id,url:href.split("?")[0],name:name.slice(0,260),slug:slug&&slug!==name?slug.slice(0,180):undefined,priceText,image:img?(img.currentSrc||img.src||""):"",rawText:text});
    seen.add(id);
  }
  const body=norm(document.body?.innerText||"");
  return {url:location.href,title:document.title,items,debug:{links:anchors.length,extracted:items.length,junkSkipped,loginHint:/войти|вход в аккаунт/i.test(body)&&items.length===0,antibotHint:/smartcaptcha|я не робот|подтвердите, что вы не робот/i.test(body)||/smartcaptcha/i.test(document.documentElement.innerHTML)}};
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
