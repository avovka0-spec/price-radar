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
if (has("--help")||has("-h")) { console.log(`Импорт заказов AliExpress/aliexpress.ru (локально)\n  --url <url> (по умолчанию aliexpress.ru orders) --headed --scrolls N --wait-ms N\n  Если URL заказов отличается, укажите --url.`); process.exit(0); }
const HEADED=has("--headed"), SCROLLS=Math.max(0,Number(getArg("--scrolls","8"))||8), WAIT=Math.max(500,Number(getArg("--wait-ms","3500"))||3500);
const START_URL=getArg("--url","https://aliexpress.ru/p/order/index.html");
if(!getArg("--url")) log("Внимание: дефолтный URL aliexpress.ru может не совпадать с вашим аккаунтом. Если откроется не заказы/будет редирект — запустите с --url \"<ваш фактический URL заказов на aliexpress.ru>\".");
const UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const ts=()=>new Date().toISOString().replace(/[:.]/g,"-"); const log=(m)=>console.log(`[${new Date().toISOString()}] ${m}`);
const esc=(v)=>{const s=String(v??""); return /[",\n]/.test(s)?`"${s.replace(/"/g,'""')}"`:s;};
const parsePrice=(t)=>{ const s=String(t||"").replace(/\u00a0/g," ").replace(/,/g,"."); const m=s.match(/(\d[\d\s]*[.,]?\d*)\s*(₽|руб|RUB)/i)||s.match(/(₽|руб|RUB)\s*(\d[\d\s]*[.,]?\d*)/i); if(!m) return null; const n=Number(String(m[1]||m[2]).replace(/[^\d.]/g,"")); return Number.isFinite(n)?Math.round(n):null; };

async function extract(page){ return await page.evaluate(()=>{ const norm=s=>String(s||"").replace(/\s+/g," ").trim();
  const out=[]; const seen=new Set();
  for (const el of Array.from(document.querySelectorAll("section,article,li,div,[class*='order'],[data-spm]"))){
    const t=norm(el.textContent); if(t.length<25||t.length<6000?false:false){} // noop
    if(t.length<25||t.length>6000) continue;
    if(!/order|заказ|достав|shipped|delivered|paid|оплачен|отмен|возврат|₽|RUB|\$/i.test(t)) continue;
    if(el.querySelectorAll("section,article,li,div").length>45) continue;
    const links=[...new Set(Array.from(el.querySelectorAll('a[href]')).map(a=>a.href).filter(h=>/aliexpress\.(ru|com)\/item|\/item\/\d+\.html|\/product\/\d+\.html|productId=|\/order\/detail|\/order-list/i.test(h)))].slice(0,25);
    const ids=[...new Set(links.map(h=>{let m=h.match(/\/item\/(\d{6,})\.html/); if(m) return m[1]; m=h.match(/\/product\/(\d{6,})\.html/); if(m) return m[1]; m=h.match(/[?&](?:productId|product_id|sku_id)=(\d{6,})/); return m?m[1]:null;}).filter(Boolean))];
    const orderIds=[...new Set((t.match(/(?:Заказ|Order)\s*[№#:]?\s*(\d{8,})/gi)||[]).map(s=>(s.match(/(\d{8,})/)||[])[1]).filter(Boolean))];
    const prices=(t.match(/(?:₽|руб|RUB)\s*\d[\d\s.,]*|\d[\d\s.,]*\s*(?:₽|руб|RUB)|US\s*\$\s*[\d.,]+|\$\s*[\d.,]+/gi)||[]).slice(0,15);
    const hasOrderSignal=/Заказ\s*[№#:]?\s*\d|Order\s*(ID|No\.?|#)|Отправлен|Доставлен|Получен|Оплачен|Ожидает|В пути|Отмен[её]н|Shipped|Delivered|Paid/i.test(t);
    if(!ids.length && !orderIds.length && !hasOrderSignal) continue;
    if(/Хиты распродажи|Покупайте самое классное|Вам может понравиться|Рекомендуем/i.test(t) && !hasOrderSignal) continue;
    const key=(orderIds.join(",")||ids.join(",")||"")+prices[0]+t.slice(0,110); if(seen.has(key)) continue; seen.add(key);
    out.push({text:t.slice(0,2200),links,productIds:ids,orderIds,pricesText:prices,hasOrderSignal});
    if(out.length>=150) break;
  }
  const body=norm(document.body?.innerText||"");
  return {url:location.href,title:document.title,loginHint:/sign in|log in|войти|вход/i.test(body)&&out.length===0,antibotHint:/captcha|robot|verify|punish|blocked/i.test(body)||/captcha|punish/i.test(document.documentElement.innerHTML),orders:out,noActiveOrders:/У вас нет активных заказов|Нет активных заказов|No active orders/i.test(body)};
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
    const raw=(snap.orders||[]).map((o)=>({...o,prices:(o.pricesText||[]).map(parsePrice).filter(n=>Number.isFinite(n)),totalGuess:(()=>{const p=(o.pricesText||[]).map(parsePrice).filter(n=>Number.isFinite(n)); return p.length?Math.max(...p):null;})()}));
    const filtered=raw.filter(o=>{
      const t=String(o.text||"");
      if(/ИзбранноеВойти|Любимые магазины|Мои отзывы|Служба поддержки|Справка AliExpress/i.test(t.replace(/\s/g,""))) return false;
      if(/АктивныеАрхивЖдут отзываСпорыПоиск по заказам/i.test(t.replace(/\s/g,""))) return false;
      if(/Добавьте паспорт|Ускорьте доставку/i.test(t) && !o.hasOrderSignal && !o.prices.length) return false;
      if(/У вас нет активных заказов|Нет активных заказов|No active orders/i.test(t)) return true; // маркер состояния
      if(/Хиты распродажи|Покупайте самое классное|Вам может понравиться|Рекомендуем/i.test(t) && !o.hasOrderSignal) return false;
      if(!o.hasOrderSignal && (o.productIds||[]).length===0 && (o.orderIds||[]).length===0) return false;
      return true;
    });
    const byKey=new Map();
    for(const o of filtered){ const k=(o.orderIds||[]).join(",")||((o.productIds||[])[0]?`p:${o.productIds[0]}:${o.totalGuess}`:`t:${o.text.slice(0,120)}`); const p=byKey.get(k); if(!p||o.text.length>p.text.length||(o.productIds||[]).length>(p.productIds||[]).length) byKey.set(k,o); }
    const orders=[...byKey.values()].map((o,i)=>({index:i+1,marketplace:"ali",kind:"order-item",...o,importedAt:new Date().toISOString()}));
    const stamp=ts(); const payload={marketplace:"ali",kind:"orders",exportedAt:new Date().toISOString(),sourceUrl:snap.url,pageTitle:snap.title,loginHint:!!snap.loginHint,antibotHint:!!snap.antibotHint,noActiveOrders:!!snap.noActiveOrders,count:orders.length,notice:"Локальный экспорт заказов AliExpress (ПДн). Не коммитить.",orders};
    fs.writeFileSync(path.join(OUT_DIR,`orders-${stamp}.json`),JSON.stringify(payload,null,2)+"\n","utf8");
    fs.writeFileSync(path.join(OUT_DIR,"orders-latest.json"),JSON.stringify(payload,null,2)+"\n","utf8");
    const header=["index","productIds","orderIds","pricesText","totalGuess","links","text"];
    fs.writeFileSync(path.join(OUT_DIR,`orders-${stamp}.csv`),"﻿"+[header.join(","),...orders.map(o=>header.map(h=>esc(Array.isArray(o[h])?o[h].join(" | "):o[h])).join(","))].join("\n")+"\n","utf8");
    log(`Готово: ${orders.length}. antibot=${!!snap.antibotHint} login=${!!snap.loginHint}`);
  } finally { await ctx.close().catch(()=>{}); }
})().catch(e=>{console.error(e&&e.stack?e.stack:e);process.exit(1);});
