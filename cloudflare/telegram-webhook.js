// Cloudflare Worker: Telegram webhook -> GitHub Issue.
//
// Переменные окружения (Settings -> Variables and Secrets в Cloudflare):
//   GH_TOKEN             (secret) fine-grained PAT: Issues Read/Write + Metadata Read
//   GH_OWNER             (text)   avovka0-spec
//   GH_REPO              (text)   price-radar
//   TELEGRAM_CHAT_ID     (text)   1782021699 — кому разрешено ставить задачи
//   WEBHOOK_SECRET       (secret) тот же secret_token, что в setWebhook
//   TELEGRAM_BOT_TOKEN   (secret) опционально: ответы в Telegram («Issue #N создан»)
//
// Инструкция по деплою: docs/telegram-webhook.md
const GITHUB_API = "https://api.github.com";

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
    if (!env.WEBHOOK_SECRET || secret !== env.WEBHOOK_SECRET) {
      return new Response("Forbidden", { status: 403 });
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("Bad Request", { status: 400 });
    }

    const msg = update.message;
    if (!msg) return ok(); // прочие типы апдейтов игнорируем

    const chatId = String(msg.chat && msg.chat.id);
    const allowedChat = String(env.TELEGRAM_CHAT_ID || "1782021699");
    if (chatId !== allowedChat) return ok();

    const text = (msg.text || "").trim();
    if (!text) return ok();

    if (text.startsWith("/start") || text.startsWith("/help")) {
      await reply(env, chatId, "Отправьте задачу текстом — я создам Issue в репозитории price-radar.");
      return ok();
    }

    const updateId = update.update_id;
    try {
      // Telegram может повторить доставку, если ответ потерялся. Проверяем маркер.
      const existing = await findIssueByUpdate(env, updateId);
      if (existing) {
        await reply(env, chatId, `✅ Уже принято: Issue #${existing.number}\n${existing.html_url}`);
        return ok();
      }

      const title = (text.split("\n")[0].trim() || "Задача из Telegram").slice(0, 80);
      const from = [msg.from && msg.from.first_name, msg.from && msg.from.username ? `(@${msg.from.username})` : ""]
        .filter(Boolean)
        .join(" ");
      const body = [
        `**От:** ${from || "Telegram"}`,
        `**Дата:** ${new Date(msg.date * 1000).toISOString()}`,
        "",
        text,
        "",
        "---",
        "_Создано автоматически из Telegram-бота (Cloudflare Worker)._",
        `<!-- telegram-update-id: ${updateId} -->`,
      ].join("\n");

      const issue = await createIssue(env, title, body);
      console.log(`created issue #${issue.number} for update ${updateId}`);
      await reply(env, chatId, `✅ Задача принята: Issue #${issue.number}\n${issue.html_url}`);
      return ok();
    } catch (e) {
      console.error("webhook error:", e && e.stack ? e.stack : String(e));
      // 5xx — Telegram повторит доставку позже.
      return new Response("GitHub error", { status: 502 });
    }
  },
};

function ok() {
  return new Response("ok", { status: 200 });
}

function ghHeaders(env) {
  return {
    Authorization: `Bearer ${env.GH_TOKEN}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "price-radar-telegram-worker",
  };
}

async function findIssueByUpdate(env, updateId) {
  const owner = env.GH_OWNER || "avovka0-spec";
  const repo = env.GH_REPO || "price-radar";
  const url =
    `${GITHUB_API}/repos/${owner}/${repo}/issues` +
    "?state=all&labels=telegram-task&sort=created&direction=desc&per_page=100";
  const res = await fetch(url, { headers: ghHeaders(env) });
  if (!res.ok) return null; // дедуп best-effort, не блокируем создание
  const issues = await res.json();
  const marker = `telegram-update-id: ${updateId}`;
  return issues.find((i) => !i.pull_request && typeof i.body === "string" && i.body.includes(marker)) || null;
}

async function createIssue(env, title, body) {
  const owner = env.GH_OWNER || "avovka0-spec";
  const repo = env.GH_REPO || "price-radar";
  const url = `${GITHUB_API}/repos/${owner}/${repo}/issues`;

  const post = async (payload) => {
    const res = await fetch(url, {
      method: "POST",
      headers: ghHeaders(env),
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {}
    return { res, text, data };
  };

  let r = await post({ title, body, labels: ["telegram-task"] });
  if (r.res.status === 422 && /label/i.test(r.text)) {
    r = await post({ title, body }); // метки нет — создаём без неё
  }
  if (!r.res.ok) throw new Error(`GitHub ${r.res.status}: ${r.text.slice(0, 300)}`);
  return r.data;
}

async function reply(env, chatId, text) {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(`telegram reply failed: ${res.status} ${detail.slice(0, 200)}`);
    }
  } catch (e) {
    // Ответ в Telegram не должен ломать создание Issue.
    console.error("telegram reply failed:", e && e.message ? e.message : String(e));
  }
}
