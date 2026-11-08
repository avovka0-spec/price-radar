#!/usr/bin/env node
// Общий CLI локального импорта данных маркетплейсов (MVP).
// Делегирует в marketplace-специфичные скрипты, сохраняя их поведение.
//
// Примеры:
//   node scripts/import.mjs --marketplace wb --kind favorites --headed --add-candidates
//   node scripts/import.mjs -m wb -k orders --headed --scrolls 12
//   node scripts/import.mjs -m wb -k prices --from-products --limit 20
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);

function getArg(names) {
  for (const name of names) {
    const i = argv.indexOf(name);
    if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("-")) return argv[i + 1];
    const eq = argv.find((x) => x.startsWith(name + "="));
    if (eq) return eq.slice(name.length + 1);
  }
  return null;
}

function stripArgs(args, names) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (names.includes(a)) { i++; continue; }
    if (names.some((n) => a.startsWith(n + "="))) continue;
    out.push(a);
  }
  return out;
}

const MARKETPLACES = {
  wb: "Wildberries",
  wildberries: "Wildberries",
  ozon: "Ozon",
  ym: "Яндекс Маркет",
  "yandex-market": "Яндекс Маркет",
  market: "Яндекс Маркет",
  ali: "AliExpress",
  aliexpress: "AliExpress",
};

const ROUTES = {
  wb: {
    favorites: "scripts/wb-import-favorites.mjs",
    favourite: "scripts/wb-import-favorites.mjs",
    orders: "scripts/wb-import-orders.mjs",
    prices: "scripts/wb-import-personal-prices.mjs",
    "personal-prices": "scripts/wb-import-personal-prices.mjs",
    personal: "scripts/wb-import-personal-prices.mjs",
    normalize: "scripts/normalize-prices.mjs",
    norm: "scripts/normalize-prices.mjs",
  },
  ozon: {
    favorites: "scripts/ozon-import-favorites.mjs",
    favourite: "scripts/ozon-import-favorites.mjs",
    orders: "scripts/ozon-import-orders.mjs",
    prices: "scripts/ozon-import-personal-prices.mjs",
    "personal-prices": "scripts/ozon-import-personal-prices.mjs",
    personal: "scripts/ozon-import-personal-prices.mjs",
    normalize: "scripts/normalize-prices.mjs",
    norm: "scripts/normalize-prices.mjs",
  },
};

function help(code = 0) {
  const lines = [
    "Общий CLI импорта (локально, данные ЛК в .local/marketplaces/)",
    "",
    "Использование:",
    "  node scripts/import.mjs --marketplace <wb|ozon|ym|ali> --kind <favorites|orders|prices> [опции скрипта]",
    "",
    "Маркетплейсы:",
    "  wb / wildberries      — реализовано: favorites, orders, prices, normalize",
    "  ozon                  — MVP (best-effort): favorites, orders, prices, normalize",
    "  ym / yandex-market    — планируется",
    "  ali / aliexpress      — планируется",
    "",
    "Примеры:",
    "  node scripts/import.mjs -m wb -k favorites --headed --add-candidates",
    "  node scripts/import.mjs -m wb -k orders --headed --scrolls 12",
    "  node scripts/import.mjs -m wb -k prices --from-products --limit 20",
    "  node scripts/import.mjs -m ozon -k favorites --headed",
    "  node scripts/import.mjs -m ozon -k orders --headed --scrolls 8",
    "  node scripts/import.mjs -m ozon -k normalize",
    "",
    "Переменные: PRICERADAR_EDGE_PROFILE, PRICERADAR_BROWSER_HEADLESS (эксперимент).",
  ];
  console.log(lines.join("\n"));
  process.exit(code);
}

const marketplaceRaw = (getArg(["--marketplace", "-m"]) || "").toLowerCase();
const kindRaw = (getArg(["--kind", "-k"]) || "").toLowerCase();
if (!argv.length || ((argv.includes("--help") || argv.includes("-h")) && (!marketplaceRaw || !kindRaw))) help(0);
if (!marketplaceRaw || !kindRaw) {
  console.error("Нужны параметры --marketplace и --kind. См. --help.");
  help(1);
}

const marketplace = MARKETPLACES[marketplaceRaw] ? (marketplaceRaw === "wildberries" ? "wb" : marketplaceRaw === "yandex-market" || marketplaceRaw === "market" ? "ym" : marketplaceRaw === "aliexpress" ? "ali" : marketplaceRaw) : null;
if (!marketplace) {
  console.error(`Неизвестный маркетплейс: ${marketplaceRaw}. Поддерживаются: ${Object.keys(MARKETPLACES).join(", ")}`);
  process.exit(1);
}

const route = ROUTES[marketplace]?.[kindRaw];
if (!route) {
  const kinds = ROUTES[marketplace] ? Object.keys(ROUTES[marketplace]).filter((k, i, a) => a.indexOf(k) === i).join(", ") : "(нет)";
  console.error(`Сценарий "${kindRaw}" не реализован для ${MARKETPLACES[marketplace] || marketplace}. Доступно: ${kinds}.`);
  process.exit(1);
}

let forwarded = stripArgs(argv, ["--marketplace", "-m", "--kind", "-k"]);
// normalize-prices.mjs принимает --marketplace; прокидываем его, если не указан явно
if ((kindRaw === "normalize" || kindRaw === "norm") && !forwarded.some((a) => a === "--marketplace" || a.startsWith("--marketplace="))) {
  forwarded = ["--marketplace", marketplace, ...forwarded];
}
const script = path.join(ROOT, route);
console.log(`[import] ${marketplace}:${kindRaw} -> ${route}`);
const child = spawn(process.execPath, [script, ...forwarded], {
  cwd: ROOT,
  stdio: "inherit",
  env: process.env,
});
child.on("exit", (code, signal) => {
  if (signal) process.exit(1);
  process.exit(code ?? 0);
});
child.on("error", (e) => {
  console.error(e && e.message ? e.message : e);
  process.exit(1);
});
