// GitHub Actions: опрос Telegram-бота, создание Issue из новых сообщений, сохранение offset.
// Запускается по расписанию (каждые 5 мин) и вручную.
const https = require("https");
const fs = require("fs");

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GH_TOKEN = process.env.GITHUB_TOKEN;
const OWNER = process.env.GH_OWNER || "avovka0-spec";
const REPO = process.env.GH_REPO || "price-radar";
const ALLOWED_CHAT = process.env.TELEGRAM_CHAT_ID || "1782021699";

const P = "public/data";
const OFFSET_FILE = `${P}/telegram-offset.json`;

function http(method, url, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method,
      headers: { "User-Agent": "price-radar-tg", ...(headers || {}) },
    }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => {
        let parsed = null;
        try { parsed = buf ? JSON.parse(buf) : null; } catch {}
        resolve({ status: res.statusCode, body: parsed, raw: buf });
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function tgGetUpdates(offset) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${offset}&timeout=0&limit=20`;
  const r = await http("GET", url);
  if (!r.body || !r.body.ok) throw new Error("getUpdates failed: " + r.raw);
  return r.body.result || [];
}

async function ghCreateIssue(title, body) {
  const data = JSON.stringify({ title, body, labels: ["telegram-task"] });
  const r = await http("POST", `https://api.github.com/repos/${OWNER}/${REPO}/issues`, {
    Authorization: `Bearer ${GH_TOKEN}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(data),
  }, data);
  if (r.status < 200 || r.status >= 300) throw new Error("createIssue failed: " + r.raw);
  return r.body;
}

(async () => {
  if (!BOT_TOKEN) { console.log("no BOT_TOKEN, skip"); process.exit(0); }

  let offsetData = { offset: 0 };
  try { offsetData = JSON.parse(fs.readFileSync(OFFSET_FILE, "utf8")); } catch {}
  let offset = (offsetData.offset || 0) + (offsetData.offset ? 1 : 0);
  // offset semantics: getUpdates offset = last_update_id + 1 to skip processed
  if (offsetData.last_update_id) offset = offsetData.last_update_id + 1;

  const updates = await tgGetUpdates(offset);
  console.log("updates:", updates.length);

  let maxId = offsetData.last_update_id || 0;
  let changed = false;

  for (const u of updates) {
    if (u.update_id > maxId) maxId = u.update_id;
    const msg = u.message;
    if (!msg || !msg.text) continue;
    if (String(msg.chat.id) !== String(ALLOWED_CHAT)) {
      console.log("skip chat", msg.chat.id);
      continue;
    }
    const text = msg.text.trim();
    if (!text) continue;
    // команда /start, /help — пропускаем
    if (text.startsWith("/start") || text.startsWith("/help")) continue;

    const title = text.split("\n")[0].slice(0, 80) || "Задача из Telegram";
    const body = `**От:** ${msg.from.first_name || ""} ${msg.from.username ? "(@" + msg.from.username + ")" : ""}\n**Дата:** ${new Date(msg.date * 1000).toISOString()}\n\n${text}\n\n---\n_Создано автоматически из Telegram-бота._`;
    const issue = await ghCreateIssue(title, body);
    console.log("created issue:", issue.number, issue.html_url);
    changed = true;
  }

  if (maxId > (offsetData.last_update_id || 0)) {
    fs.writeFileSync(OFFSET_FILE, JSON.stringify({ last_update_id: maxId, updated_at: new Date().toISOString() }, null, 2));
    changed = true;
  }

  if (changed) console.log("offset updated to", maxId);
  else console.log("no changes");
  process.exit(0);
})();
