// GitHub Actions: опрос Telegram-бота, создание Issue из новых сообщений, сохранение offset.
// Запускается по расписанию (каждые 5 мин) и вручную.
//
// offset сохраняется после каждого успешно обработанного сообщения: если на следующем
// сообщении API упадёт, при повторном запуске дубликатов уже созданных Issues не будет.
import * as https from "node:https";
import * as fs from "node:fs";

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
  const make = async (labels) => {
    const payload = { title, body };
    if (labels && labels.length) payload.labels = labels;
    const data = JSON.stringify(payload);
    return http("POST", `https://api.github.com/repos/${OWNER}/${REPO}/issues`, {
      Authorization: `Bearer ${GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(data),
    }, data);
  };
  let r = await make(["telegram-task"]);
  if (r.status === 422 && /label/i.test(r.raw || "")) {
    console.log("telegram-task label missing, retrying without label");
    r = await make([]);
  }
  if (r.status < 200 || r.status >= 300) throw new Error("createIssue failed: " + r.raw);
  return r.body;
}

function readOffset() {
  try {
    const data = JSON.parse(fs.readFileSync(OFFSET_FILE, "utf8"));
    return Number(data.last_update_id) || 0;
  } catch {
    return 0;
  }
}

function saveOffset(lastUpdateId) {
  fs.mkdirSync(P, { recursive: true });
  fs.writeFileSync(
    OFFSET_FILE,
    JSON.stringify({ last_update_id: lastUpdateId, updated_at: new Date().toISOString() }, null, 2) + "\n",
  );
}

(async () => {
  if (!BOT_TOKEN) { console.log("no BOT_TOKEN, skip"); return; }

  const lastSaved = readOffset();
  const offset = lastSaved ? lastSaved + 1 : 0;
  // offset semantics: getUpdates offset = last_update_id + 1, чтобы пропустить обработанные
  const updates = await tgGetUpdates(offset);
  console.log(`updates: ${updates.length}, offset: ${offset}`);

  let processed = lastSaved;
  let errors = 0;

  for (const u of updates.slice().sort((a, b) => a.update_id - b.update_id)) {
    const msg = u.message;
    // Нетекстовые апдейты (фото, стикеры и т.п.) просто подтверждаем.
    if (!msg || !msg.text) { processed = u.update_id; continue; }

    if (String(msg.chat.id) !== String(ALLOWED_CHAT)) {
      console.log("skip chat", msg.chat.id);
      processed = u.update_id;
      continue;
    }

    const text = msg.text.trim();
    if (!text) { processed = u.update_id; continue; }
    if (text.startsWith("/start") || text.startsWith("/help")) { processed = u.update_id; continue; }

    const title = (text.split("\n")[0].trim() || "Задача из Telegram").slice(0, 80);
    const from = [msg.from && msg.from.first_name, msg.from && msg.from.username ? `(@${msg.from.username})` : ""]
      .filter(Boolean).join(" ");
    const body = [
      `**От:** ${from || "Telegram"}`,
      `**Дата:** ${new Date(msg.date * 1000).toISOString()}`,
      "",
      text,
      "",
      "---",
      "_Создано автоматически из Telegram-бота._",
      `<!-- telegram-update-id: ${u.update_id} -->`,
    ].join("\n");

    try {
      const issue = await ghCreateIssue(title, body);
      console.log("created issue:", issue.number, issue.html_url);
      processed = u.update_id;
      // Фиксируем прогресс сразу: сбой на следующем сообщении не приведёт к дубликатам.
      saveOffset(processed);
    } catch (e) {
      // Не двигаем offset за неудачное сообщение — повторим при следующем запуске.
      console.error(`failed update ${u.update_id}:`, e && e.message ? e.message : String(e));
      errors++;
      break;
    }
  }

  if (processed > lastSaved) {
    saveOffset(processed);
    console.log("offset updated to", processed);
  } else {
    console.log("offset unchanged", processed);
  }

  if (errors) process.exitCode = 1;
})().catch((e) => {
  console.error(e && e.stack ? e.stack : String(e));
  process.exit(1);
});
