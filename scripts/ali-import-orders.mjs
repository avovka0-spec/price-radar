#!/usr/bin/env node
// Локальный импорт заказов AliExpress (MVP, best-effort). Данные только в .local/.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { resolveEdgeProfile, edgeLaunchOptions } from "./lib/browser-profile.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, ".local", "marketplaces", "ali");
const args = process.argv.slice(2);
function has(n){return args.includes(n);} function getArg(n,d=null){const i=args.indexOf(n); if(i>=0&&args[i+1]&&!args[i+1].startsWith("-")) return args[i+1]; const eq=args.find(x=>x.startsWith(n+"=")); return eq?eq.slice(n.length+1):d;}
if (has("--help")||has("-h")) { console.log(`Импорт заказов AliExpress (локально)\n  --url <url> (по умолчанию /p/order/index.html) --headed --scrolls N --wait-ms N`); process.exit(0); }
const HEADED=has("--headed"), SCROLLS=Math.max(0,Number(getArg("--scrolls","8"))||8), WAIT=Math.max(500,Number(getArg("--wait-ms","3500"))||3500);
const START_URL=getArg("--url","https://www.aliexpress.com/p/order/index.html");
const UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const ts=()=>new Date().toISOString().replace(/[:.]/g,"-"); const log=(m)=>console.log(`[${new Date().toISOString()}] ${m}`);
const esc=(v)=>{const s=String(v??""); return /[",\n]/.test(s)?`"${s.replace(/"/g,'""')}"`:s;};
const parsePrice=(t)=>{ const s=String(t||"").replace(/\u00a0/g," ").replace(/,/g,"."); const m=s.match(/(\d[\d\s]*[.,]?\d*)\s*(₽|руб|RUB)/i)||s.match(/(₽|руб|RUB)\s*(\d[\d\s]*[.,]?\d*)/i); if(!m) return null; const n=Number(String(m[1]||m[2]).replace(/[^\d.]/g,"")); return Number.isFinite(n)?Math.round(n):null; };

async function extract(page){ return await page.evaluate(()=>{ const norm=s=>String(s||"").replace(/\s+/g," ").trim();
  const out=[]; const seen=new Set();
  for (const el of Array.from(document.querySelectorAll("section,article,li,div,[class*='order']"))){
    const t=norm(el.textContent); if(t.length<30||t.length>5000) continue;
    if(!/order|заказ|достав|shipped|delivered|paid|оплачен|₽|RUB|\$/i.test(t)) continue;
    if(el.querySelectorAll("section,article,li").length>15) continue;
    const links=[...new Set(Array.from(el.querySelectorAll('a[href]')).map(a=>a.href).filter(h=>/\/item\/\d+\.html|productId=|\/order\//.test(h)))].slice(0,20);
    const ids=[...new Set(links.map(h=>{let m=h.match(/\/item\/(\d{6,})\.html/); if(m) return m[1]; m=h.match(/[?&](?:productId|product_id)=(\d{6,})/); return m?m[1]:null;}).filter(Boolean))];
    const orderIds=(t.match(/\b\d{12,}\b/g)||[]).slice(0,5);
    const prices=(t.match(/(?:₽|руб|RUB)\s*\d[\d\s.,]*|\d[\d\s.,]*\s*(?:₽|руб|RUB)|US\s*\$\s*[\d.,]+|\$\s*[\d.,]+/gi)||[]).slice(0,12);
    if(!ids.length && !orderIds.length && !/order|заказ/i.test(t)) continue;
    const key=(ids.join(",")||orderIds.join(",")||"")+prices[0]+t.slice(0,90); if(seen.has(key)) continue; seen.add(key);
    out.push({text:t.slice(0,2000),links,productIds:ids,orderIds,pricesText:prices});
    if(out.length>=150) break;
  }
  const body=norm(document.body?.innerText||"");
  return {url:location.href,title:document.title,loginHint:/sign in|log in|войти|вход/i.test(body)&&out.length===0,antibotHint:/captcha|robot|verify|punish|blocked/i.test(body)||/captcha|punish/i.test(document.documentElement.innerHTML),orders:out};
});}

(async()=>{
  fs.mkdirSync(OUT_DIR,{recursive:true});
  const profile=resolveEdgeProfile(); log(`Профиль Edge: ${profile}. ${START_URL}`);
  const ctx=await chromium.launchPersistentContext(profile,{...edgeLaunchOptions({headed:HEADED,background:!HEADED}),userAgent:UA});
  try{
    const page=ctx.pages()[0]||await ctx.newPage();
    await page.goto(START_URL,{waitUntil:"domcontentloaded",timeout:60000}).catch(e=>log(`goto: ${e.message}`));
    await page.waitForTimeout(WAIT+2000);
    for(let i=0;i<SCROLLS;i++){ await page.evaluate(()=>window.scrollTo(0,document.body.scrollHeight)).catch(()=>{}); await page.waitForTimeout(WAIT); }
    const snap=await extract(page);
    const orders=(snap.orders||[]).map((o,i)=>({index:i+1,marketplace:"ali",kind:"order-item",...o,prices:(o.pricesText||[]).map(parsePrice).filter(n=>Number.isFinite(n)),totalGuess:(()=>{const p=(o.pricesText||[]).map(parsePrice).filter(n=>Number.isFinite(n)); return p.length?Math.max(...p):null;})(),importedAt:new Date().toISOString()}));
    const stamp=ts(); const payload={marketplace:"ali",kind:"orders",exportedAt:new Date().toISOString(),sourceUrl:snap.url,pageTitle:snap.title,loginHint:!!snap.loginHint,antibotHint:!!snap.antibotHint,count:orders.length,notice:"Локальный экспорт заказов AliExpress (ПДн). Не коммитить.",orders};
    fs.writeFileSync(path.join(OUT_DIR,`orders-${stamp}.json`),JSON.stringify(payload,null,2)+"\n","utf8");
    fs.writeFileSync(path.join(OUT_DIR,"orders-latest.json"),JSON.stringify(payload,null,2)+"\n","utf8");
    const header=["index","productIds","orderIds","pricesText","totalGuess","links","text"];
    fs.writeFileSync(path.join(OUT_DIR,`orders-${stamp}.csv`),"﻿"+[header.join(","),...orders.map(o=>header.map(h=>esc(Array.isArray(o[h])?o[h].join(" | "):o[h])).join(","))].join("\n")+"\n","utf8");
    log(`Готово: ${orders.length}. antibot=${!!snap.antibotHint} login=${!!snap.loginHint}`);
  } finally { await ctx.close().catch(()=>{}); }
})().catch(e=>{console.error(e&&e.stack?e.stack:e);process.exit(1);});
