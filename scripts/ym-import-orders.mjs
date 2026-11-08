#!/usr/bin/env node
// Локальный импорт заказов Яндекс Маркета (MVP, best-effort). Данные только в .local/.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { resolveEdgeProfile, edgeLaunchOptions } from "./lib/browser-profile.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, ".local", "marketplaces", "ym");
const args = process.argv.slice(2);
function has(n){return args.includes(n);} function getArg(n,d=null){const i=args.indexOf(n); if(i>=0&&args[i+1]&&!args[i+1].startsWith("-")) return args[i+1]; const eq=args.find(x=>x.startsWith(n+"=")); return eq?eq.slice(n.length+1):d;}
if (has("--help")||has("-h")) { console.log(`Импорт заказов Яндекс Маркета (локально)\n  --url <url> (по умолчанию /my/orders) --headed --scrolls N --wait-ms N`); process.exit(0); }
const HEADED=has("--headed"), SCROLLS=Math.max(0,Number(getArg("--scrolls","8"))||8), WAIT=Math.max(500,Number(getArg("--wait-ms","3000"))||3000);
const START_URL=getArg("--url","https://market.yandex.ru/my/orders");
const UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const ts=()=>new Date().toISOString().replace(/[:.]/g,"-"); const log=(m)=>console.log(`[${new Date().toISOString()}] ${m}`);
const esc=(v)=>{const s=String(v??""); return /[",\n]/.test(s)?`"${s.replace(/"/g,'""')}"`:s;};
const parsePrice=(t)=>{const m=String(t||"").replace(/\u00a0/g," ").match(/(\d[\d\s]*)\s*₽/); return m?Number(m[1].replace(/[^\d]/g,"")):null;};

async function extract(page){ return await page.evaluate(()=>{ const norm=s=>String(s||"").replace(/\s+/g," ").trim();
  const out=[]; const seen=new Set();
  for (const el of Array.from(document.querySelectorAll("section,article,li,div,[data-zone-name],[data-auto]"))){
    const t=norm(el.textContent); if(t.length<30||t.length>5000) continue;
    if(!/заказ|достав|получ|оплачен|отмен|₽/i.test(t)) continue;
    if(el.querySelectorAll("section,article,li").length>12) continue;
    const links=[...new Set(Array.from(el.querySelectorAll('a[href]')).map(a=>a.href).filter(h=>/market\.yandex\.ru\/(product|card)|productId=/.test(h)))].slice(0,15);
    const ids=[...new Set(links.map(h=>{let m=h.match(/\/product--[^/]*\/(\d{5,})/); if(m) return m[1]; m=h.match(/\/card\/[^/]*\/(\d{5,})/); if(m) return m[1]; m=h.match(/[?&](?:productId|sku|id)=(\d{5,})/); return m?m[1]:null;}).filter(Boolean))];
    const prices=(t.match(/(\d[\d\s\u00a0]*)\s*₽/g)||[]).slice(0,12);
    const dates=(t.match(/\d{1,2}\s+[а-яё]{3,}\.?|(?:\d{1,2}\s+)?[а-яё]+\s+\d{4}|\d{2}\.\d{2}\.\d{2,4}/giu)||[]).slice(0,8);
    if(!ids.length && !/заказ/i.test(t)) continue;
    const key=(ids.join(",")||"")+(prices[0]||"")+t.slice(0,90); if(seen.has(key)) continue; seen.add(key);
    out.push({text:t.slice(0,2000),links,productIds:ids,pricesText:prices,dates});
    if(out.length>=150) break;
  }
  const body=norm(document.body?.innerText||"");
  return {url:location.href,title:document.title,loginHint:/войти|вход/i.test(body)&&out.length===0,antibotHint:/smartcaptcha|робот|подтвердите/i.test(body),orders:out};
});}

(async()=>{
  fs.mkdirSync(OUT_DIR,{recursive:true});
  const profile=resolveEdgeProfile(); log(`Профиль Edge: ${profile}. ${START_URL}`);
  const ctx=await chromium.launchPersistentContext(profile,{...edgeLaunchOptions({headed:HEADED,background:!HEADED}),userAgent:UA});
  try{
    const page=ctx.pages()[0]||await ctx.newPage();
    await page.goto(START_URL,{waitUntil:"domcontentloaded",timeout:60000}).catch(e=>log(`goto: ${e.message}`));
    await page.waitForTimeout(WAIT+1500);
    for(let i=0;i<SCROLLS;i++){ await page.evaluate(()=>window.scrollTo(0,document.body.scrollHeight)).catch(()=>{}); await page.waitForTimeout(WAIT); }
    const snap=await extract(page);
    const orders=(snap.orders||[]).map((o,i)=>({index:i+1,marketplace:"ym",kind:"order-item",...o,prices:(o.pricesText||[]).map(parsePrice).filter(Boolean),totalGuess:Math.max(0,...(o.pricesText||[]).map(parsePrice).filter(Boolean))||null,importedAt:new Date().toISOString()}));
    const stamp=ts(); const payload={marketplace:"ym",kind:"orders",exportedAt:new Date().toISOString(),sourceUrl:snap.url,pageTitle:snap.title,loginHint:!!snap.loginHint,antibotHint:!!snap.antibotHint,count:orders.length,notice:"Локальный экспорт заказов Яндекс Маркета (ПДн). Не коммитить.",orders};
    fs.writeFileSync(path.join(OUT_DIR,`orders-${stamp}.json`),JSON.stringify(payload,null,2)+"\n","utf8");
    fs.writeFileSync(path.join(OUT_DIR,"orders-latest.json"),JSON.stringify(payload,null,2)+"\n","utf8");
    const header=["index","productIds","pricesText","dates","totalGuess","links","text"];
    fs.writeFileSync(path.join(OUT_DIR,`orders-${stamp}.csv`),"﻿"+[header.join(","),...orders.map(o=>header.map(h=>esc(Array.isArray(o[h])?o[h].join(" | "):o[h])).join(","))].join("\n")+"\n","utf8");
    log(`Готово: ${orders.length}. Debug antibot=${!!snap.antibotHint} login=${!!snap.loginHint}`);
  } finally { await ctx.close().catch(()=>{}); }
})().catch(e=>{console.error(e&&e.stack?e.stack:e);process.exit(1);});
