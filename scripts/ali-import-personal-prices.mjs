#!/usr/bin/env node
// Локальный снимок цен AliExpress из залогиненного профиля (MVP, best-effort). Данные только в .local/.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { resolveEdgeProfile, edgeLaunchOptions } from "./lib/browser-profile.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, ".local", "marketplaces", "ali");
const args = process.argv.slice(2);
function has(n){return args.includes(n);} function getArg(n,d=null){const i=args.indexOf(n); if(i>=0&&args[i+1]&&!args[i+1].startsWith("-")) return args[i+1]; const eq=args.find(x=>x.startsWith(n+"=")); return eq?eq.slice(n.length+1):d;}
if (has("--help")||has("-h")) { console.log(`Персональные цены AliExpress/aliexpress.ru (локально)\n  --from-products|--from-favorites-latest|--urls <u1,u2>|--skus ali:123\n  --limit N --headed --delay-ms N`); process.exit(0); }
const HEADED=has("--headed"), LIMIT=Math.max(1,Number(getArg("--limit","25"))||25), DELAY=Math.max(800,Number(getArg("--delay-ms","4500"))||4500);
const UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const ts=()=>new Date().toISOString().replace(/[:.]/g,"-"); const log=(m)=>console.log(`[${new Date().toISOString()}] ${m}`);
const esc=(v)=>{const s=String(v??""); return /[",\n]/.test(s)?`"${s.replace(/"/g,'""')}"`:s;};
const parsePrice=(t)=>{ const s=String(t||"").replace(/\u00a0/g," ").replace(/,/g,"."); const m=s.match(/(\d[\d\s]*[.,]?\d*)\s*(₽|руб|RUB)/i)||s.match(/(₽|руб|RUB)\s*(\d[\d\s]*[.,]?\d*)/i); if(!m) return null; const n=Number(String(m[1]||m[2]).replace(/[^\d.]/g,"")); return Number.isFinite(n)?Math.round(n):null; };

function loadTargets(){
  const urls=getArg("--urls"); if(urls) return urls.split(/[\s,]+/).filter(u=>/aliexpress\.(ru|com)/i.test(u)).map(u=>({url:u}));
  const skus=getArg("--skus"); if(skus) return skus.split(/[\s,]+/).map(s=>s.trim()).filter(Boolean).map(s=>({sku:s,url:null}));
  if(has("--from-favorites-latest")){ const j=JSON.parse(fs.readFileSync(path.join(OUT_DIR,"favorites-latest.json"),"utf8")); return (j.items||[]).map(it=>({sku:it.sku,url:it.url})); }
  if(has("--from-products")){ const j=JSON.parse(fs.readFileSync(path.join(ROOT,"public/data/products.json"),"utf8")); return (j||[]).filter(p=>p.marketplace==="ali").map(p=>({sku:p.sku,url:p.url})); }
  throw new Error("Укажите --from-products | --from-favorites-latest | --urls | --skus");
}

async function extract(page){ return await page.evaluate(()=>{ const norm=s=>String(s||"").replace(/\s+/g," ").trim();
  const text=norm(document.body?.innerText||"").slice(0,14000);
  const prices=Array.from(document.querySelectorAll("span,div")).map(e=>norm(e.textContent)).filter(t=>/(₽|руб|RUB|\$)/.test(t)&&/\d/.test(t)&&t.length<40).slice(0,30);
  const title=document.title||""; const h1=norm(document.querySelector("h1")?.textContent);
  return {url:location.href,title,h1,prices,loginHint:/sign in|log in|войти|вход/i.test(text),antibotHint:/captcha|robot|verify|punish|blocked|slide to verify/i.test(text),snippet:text.slice(0,700)};
});}

(async()=>{
  fs.mkdirSync(OUT_DIR,{recursive:true});
  let targets=loadTargets().slice(0,LIMIT); if(!targets.length) throw new Error("Нет целей.");
  const profile=resolveEdgeProfile(); log(`Профиль Edge: ${profile}. Товаров: ${targets.length}`);
  const ctx=await chromium.launchPersistentContext(profile,{...edgeLaunchOptions({headed:HEADED,background:!HEADED}),userAgent:UA});
  const items=[];
  try{
    const page=ctx.pages()[0]||await ctx.newPage();
    for(let i=0;i<targets.length;i++){
      const t=targets[i]; let url=t.url;
      if(!url && t.sku && /^ali:(\d+)$/.test(String(t.sku))) url=`https://aliexpress.ru/item/${String(t.sku).replace(/^ali:/,"")}.html`;
      if(!url){ items.push({marketplace:"ali",sku:t.sku,url:null,error:"no url"}); continue; }
      log(`[${i+1}/${targets.length}] ${url}`);
      await page.goto(url,{waitUntil:"domcontentloaded",timeout:60000}).catch(e=>log(`goto: ${e.message}`));
      await page.waitForTimeout(5000);
      const ex=await extract(page);
      const rub=(ex.prices||[]).map(parsePrice).filter(n=>Number.isFinite(n));
      items.push({marketplace:"ali",sku:t.sku||null,url,capturedAt:new Date().toISOString(),personalPrice:rub.length?Math.min(...rub):null,prices:ex.prices||[],title:ex.title,h1:ex.h1,loginHint:!!ex.loginHint,antibotHint:!!ex.antibotHint,pageUrl:ex.url});
      if(i<targets.length-1) await page.waitForTimeout(DELAY);
    }
  } finally { await ctx.close().catch(()=>{}); }
  const stamp=ts(); const payload={marketplace:"ali",kind:"personal-prices",exportedAt:new Date().toISOString(),count:items.length,notice:"Локальный снимок цен AliExpress. Не коммитить.",items};
  fs.writeFileSync(path.join(OUT_DIR,`personal-prices-${stamp}.json`),JSON.stringify(payload,null,2)+"\n","utf8");
  fs.writeFileSync(path.join(OUT_DIR,"personal-prices-latest.json"),JSON.stringify(payload,null,2)+"\n","utf8");
  const header=["marketplace","sku","personalPrice","loginHint","antibotHint","url","title"];
  fs.writeFileSync(path.join(OUT_DIR,`personal-prices-${stamp}.csv`),"﻿"+[header.join(","),...items.map(it=>header.map(h=>esc(it[h])).join(","))].join("\n")+"\n","utf8");
  log(`Готово: ${items.length}`);
})().catch(e=>{console.error(e&&e.stack?e.stack:e);process.exit(1);});
