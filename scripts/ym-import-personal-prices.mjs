#!/usr/bin/env node
// Локальный снимок цен Яндекс Маркета из залогиненного профиля (MVP, best-effort). Данные только в .local/.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { resolveEdgeProfile, edgeLaunchOptions } from "./lib/browser-profile.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, ".local", "marketplaces", "ym");
const args = process.argv.slice(2);
function has(n){return args.includes(n);} function getArg(n,d=null){const i=args.indexOf(n); if(i>=0&&args[i+1]&&!args[i+1].startsWith("-")) return args[i+1]; const eq=args.find(x=>x.startsWith(n+"=")); return eq?eq.slice(n.length+1):d;}
if (has("--help")||has("-h")) { console.log(`Персональные цены Яндекс Маркета (локально)\n  --from-products|--from-favorites-latest|--urls <u1,u2>|--skus ym:123,ym:456\n  --limit N --headed --delay-ms N`); process.exit(0); }
const HEADED=has("--headed"), LIMIT=Math.max(1,Number(getArg("--limit","30"))||30), DELAY=Math.max(500,Number(getArg("--delay-ms","3500"))||3500);
const UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const ts=()=>new Date().toISOString().replace(/[:.]/g,"-"); const log=(m)=>console.log(`[${new Date().toISOString()}] ${m}`);
const esc=(v)=>{const s=String(v??""); return /[",\n]/.test(s)?`"${s.replace(/"/g,'""')}"`:s;};
const parsePrice=(t)=>{const m=String(t||"").replace(/\u00a0/g," ").match(/(\d[\d\s]*)\s*₽/); return m?Number(m[1].replace(/[^\d]/g,"")):null;};

function loadTargets(){
  const urls=getArg("--urls"); if(urls) return urls.split(/[\s,]+/).filter(u=>/market\.yandex\./i.test(u)).map(u=>({url:u}));
  const skus=getArg("--skus"); if(skus) return skus.split(/[\s,]+/).map(s=>s.trim()).filter(Boolean).map(s=>({sku:s,url:null}));
  if(has("--from-favorites-latest")){ const j=JSON.parse(fs.readFileSync(path.join(OUT_DIR,"favorites-latest.json"),"utf8")); return (j.items||[]).map(it=>({sku:it.sku,url:it.url})); }
  if(has("--from-products")){ const j=JSON.parse(fs.readFileSync(path.join(ROOT,"public/data/products.json"),"utf8")); return (j||[]).filter(p=>p.marketplace==="ym").map(p=>({sku:p.sku,url:p.url})); }
  throw new Error("Укажите --from-products | --from-favorites-latest | --urls | --skus");
}

async function extract(page){ return await page.evaluate(()=>{ const norm=s=>String(s||"").replace(/\s+/g," ").trim();
  const text=norm(document.body?.innerText||"").slice(0,14000);
  const prices=Array.from(document.querySelectorAll("span,div,h3")).map(e=>norm(e.textContent)).filter(t=>/^\d[\d\s\u00a0]*\s*₽$/.test(t)).slice(0,25);
  const title=document.title||""; const h1=norm(document.querySelector("h1")?.textContent);
  return {url:location.href,title,h1,prices,loginHint:/войти|вход/i.test(text),antibotHint:/smartcaptcha|робот|подтвердите/i.test(text),plusHint:/плюс|балл/i.test(text),snippet:text.slice(0,700)};
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
      if(!url && t.sku && /^ym:(\d+)$/.test(String(t.sku))) url=`https://market.yandex.ru/search?text=${encodeURIComponent(String(t.sku).replace(/^ym:/,""))}`; // fallback; лучше явный url
      if(!url){ items.push({marketplace:"ym",sku:t.sku,url:null,error:"no url"}); continue; }
      log(`[${i+1}/${targets.length}] ${url}`);
      await page.goto(url,{waitUntil:"domcontentloaded",timeout:60000}).catch(e=>log(`goto: ${e.message}`));
      await page.waitForTimeout(4000);
      const ex=await extract(page);
      const nums=(ex.prices||[]).map(parsePrice).filter(Boolean);
      items.push({marketplace:"ym",sku:t.sku||null,url,capturedAt:new Date().toISOString(),personalPrice:nums.length?Math.min(...nums):null,prices:ex.prices||[],title:ex.title,h1:ex.h1,loginHint:!!ex.loginHint,antibotHint:!!ex.antibotHint,plusHint:!!ex.plusHint,pageUrl:ex.url});
      if(i<targets.length-1) await page.waitForTimeout(DELAY);
    }
  } finally { await ctx.close().catch(()=>{}); }
  const stamp=ts(); const payload={marketplace:"ym",kind:"personal-prices",exportedAt:new Date().toISOString(),count:items.length,notice:"Локальный снимок цен Яндекс Маркета. Не коммитить.",items};
  fs.writeFileSync(path.join(OUT_DIR,`personal-prices-${stamp}.json`),JSON.stringify(payload,null,2)+"\n","utf8");
  fs.writeFileSync(path.join(OUT_DIR,"personal-prices-latest.json"),JSON.stringify(payload,null,2)+"\n","utf8");
  const header=["marketplace","sku","personalPrice","loginHint","antibotHint","plusHint","url","title"];
  fs.writeFileSync(path.join(OUT_DIR,`personal-prices-${stamp}.csv`),"﻿"+[header.join(","),...items.map(it=>header.map(h=>esc(it[h])).join(","))].join("\n")+"\n","utf8");
  log(`Готово: ${items.length}`);
})().catch(e=>{console.error(e&&e.stack?e.stack:e);process.exit(1);});
