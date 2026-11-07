#!/usr/bin/env node
// Отправка статуса/отчёта в Telegram через GitHub Actions (workflow telegram-notify).
// Токен бота не нужен: сообщение уходит через ретранслятор в Actions.
//
// Использование:
//   node scripts/notify-telegram.mjs "✅ Готово: задача выполнена"
//   node scripts/notify-telegram.mjs --file report.md
//   echo "текст" | node scripts/notify-telegram.mjs
//
// Переменные (можно положить в .env в корне репозитория):
//   GH_TOKEN         — classic PAT со scope repo (+ workflow для workflow_dispatch)
//   GH_OWNER         — по умолчанию avovka0-spec
//   GH_REPO          — по умолчанию price-radar
//   TELEGRAM_CHAT_ID — по умолчанию 1782021699
import * as fs from "node:fs";
import * as path from "node:path";
import * as https from "node:https";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadDotEnv() {
  try {
    const raw = fs.readFileSync(path.join(ROOT, ".env"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim() || /^\s*#/.test(line)) continue;
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      let value = m[2];
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!process.env[m[1]]) process.env[m[1]] = value;
    }
  } catch {
    // .env не обязателен — переменные могут быть заданы в окружении
  }
}

function http(method, url, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method,
        headers: {
          "User-Agent": "price-radar-tg-status",
          ...(body ? { "Content-Length": Buffer.byteLength(body) } : {}),
          ...(headers || {}),
        },
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => resolve({ status: res.statusCode, raw: buf }));
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function readText() {
  const args = process.argv.slice(2);
  const fileIdx = args.indexOf("--file");
  if (fileIdx >= 0) {
    const file = args[fileIdx + 1];
    if (!file) throw new Error("после --file нужен путь к файлу");
    return fs.readFileSync(file, "utf8");
  }
  if (args.length) return args.join(" ");
  if (!process.stdin.isTTY) return fs.readFileSync(0, "utf8");
  return "";
}

loadDotEnv();

const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const OWNER = process.env.GH_OWNER || "avovka0-spec";
const REPO = process.env.GH_REPO || "price-radar";
const CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || "1782021699");
const MAX_LEN = 4000;

const jsonHeaders = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: "application/vnd.github+json",
  "Content-Type": "application/json",
};

async function main() {
  if (!TOKEN) {
    throw new Error("GH_TOKEN не задан — добавьте его в .env или переменные окружения");
  }

  let text = readText().trim();
  if (!text) {
    throw new Error("пустой текст: передайте сообщение аргументом, через --file или stdin");
  }
  if (text.length > MAX_LEN) text = text.slice(0, MAX_LEN) + "\n… (обрезано)";

  // Основной путь: workflow_dispatch (нужен scope workflow).
  const dispatch = await http(
    "POST",
    `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/telegram-notify.yml/dispatches`,
    jsonHeaders,
    JSON.stringify({ ref: "main", inputs: { chat_id: CHAT_ID, text } }),
  );
  if (dispatch.status === 204) {
    console.log("sent via workflow_dispatch");
    return;
  }

  // Fallback: repository_dispatch (достаточно scope repo).
  if ([403, 404, 422].includes(dispatch.status)) {
    const fallback = await http(
      "POST",
      `https://api.github.com/repos/${OWNER}/${REPO}/dispatches`,
      jsonHeaders,
      JSON.stringify({ event_type: "telegram-notify", client_payload: { chat_id: CHAT_ID, text } }),
    );
    if (fallback.status === 204) {
      console.log("sent via repository_dispatch");
      return;
    }
    throw new Error(
      `dispatch failed: workflow_dispatch ${dispatch.status} ${dispatch.raw}; repository_dispatch ${fallback.status} ${fallback.raw}`,
    );
  }

  throw new Error(`dispatch failed: ${dispatch.status} ${dispatch.raw}`);
}

main().catch((e) => {
  console.error(e && e.message ? e.message : String(e));
  process.exit(1);
});
