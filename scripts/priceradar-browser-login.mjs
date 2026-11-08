#!/usr/bin/env node
// Открывает отдельный профиль Edge для ЦенРадара, чтобы вы могли войти в маркетплейсы.
// Профиль изолирован от вашего обычного Edge и используется всеми локальными скриптами.
//
// Запуск:
//   node scripts/priceradar-browser-login.mjs
//   node scripts/priceradar-browser-login.mjs --url https://www.ozon.ru/
//   node scripts/priceradar-browser-login.mjs --all   # откроет вкладки WB/Ozon/Я.Маркет/AliExpress
import path from "node:path";
import { chromium } from "playwright-core";
import { resolveEdgeProfile, edgeLaunchOptions, ROOT_DIR } from "./lib/browser-profile.mjs";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(`Открыть профиль Edge ЦенРадара для входа в маркетплейсы
  node scripts/priceradar-browser-login.mjs [--url <url>] [--all]

Профиль: ${resolveEdgeProfile()}
Переменная PRICERADAR_EDGE_PROFILE может переопределить путь.`);
  process.exit(0);
}

function getArg(name, def = null) {
  const i = args.indexOf(name);
  if (i >= 0 && args[i + 1] && !args[i + 1].startsWith("--")) return args[i + 1];
  const eq = args.find((x) => x.startsWith(name + "="));
  return eq ? eq.slice(name.length + 1) : def;
}

const URLS = args.includes("--all")
  ? [
      "https://www.wildberries.ru/",
      "https://www.ozon.ru/",
      "https://market.yandex.ru/",
      "https://www.aliexpress.com/",
    ]
  : [getArg("--url", "https://www.wildberries.ru/lk/favorites")];

const profile = resolveEdgeProfile();
console.log(`[priceradar] Профиль Edge: ${profile}`);
console.log("[priceradar] Войдите в нужные маркетплейсы. После входа закройте окно браузера — сессия сохранится в профиле.");

const ctx = await chromium.launchPersistentContext(profile, {
  ...edgeLaunchOptions({ headed: true }),
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
});

const pages = [ctx.pages()[0] || (await ctx.newPage())];
for (let i = 0; i < URLS.length; i++) {
  const p = i === 0 ? pages[0] : await ctx.newPage();
  await p.goto(URLS[i], { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
}
await new Promise((resolve) => ctx.on("close", resolve));
console.log("[priceradar] Профиль сохранён.");
