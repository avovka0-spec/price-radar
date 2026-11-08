// Cloudflare Worker: Telegram webhook -> GitHub Issue + команды статуса.
//
// Переменные окружения (Settings -> Variables and Secrets в Cloudflare):
//   GH_TOKEN             (secret) fine-grained PAT: Issues Read/Write + Metadata Read
//   GH_OWNER             (text)   avovka0-spec
//   GH_REPO              (text)   price-radar
//   TELEGRAM_CHAT_ID     (text)   1782021699 — кому разрешено ставить задачи
//   WEBHOOK_SECRET       (secret) тот же secret_token, что в setWebhook
//   TELEGRAM_BOT_TOKEN   (secret) опционально: ответы в Telegram
//
// Инструкция по деплою: docs/telegram-webhook.md
const GITHUB_API = "https://api.github.com";

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const secret = (request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "").trim();
    const expected = String(env.WEBHOOK_SECRET || "").trim();
    if (!expected || secret !== expected) {
      return new Response("Forbidden", { status: 403 });
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("Bad Request", { status: 400 });
    }

    const msg = update.message;
    if (!msg) return ok();

    const chatId = String(msg.chat && msg.chat.id);
    const allowedChat = String(env.TELEGRAM_CHAT_ID || "1782021699");
    if (chatId !== allowedChat) return ok();

    const text = (msg.text || "").trim();
    if (!text) return ok();

    const cmd = text.split(/\s+/)[0].toLowerCase();
    if (cmd === "/start" || cmd === "/help") {
      await reply(
        env,
        chatId,
        "Отправьте задачу текстом — я создам GitHub Issue (telegram-task).\n" +
          "Локальный OpenCode на вашем ПК подхватывает задачу автоматически, обычно в течение ~5 минут (ПК должен быть включён).\n\n" +
          "Команды:\n" +
          "/status — последние задачи и их состояние\n" +
          "/status 7 — состояние Issue #7\n" +
          "/help — эта справка",
      );
      return ok();
    }
    if (cmd === "/status" || cmd === "/st" || cmd === "/tasks") {
      try {
        const arg = text.split(/\s+/)[1];
        const report = await buildStatus(env, arg);
        await reply(env, chatId, report);
      } catch (e) {
        console.error("status error:", e && e.stack ? e.stack : String(e));
        await reply(env, chatId, "Не удалось получить статус. Проверьте GH_TOKEN/логи Worker.");
      }
      return ok();
    }

    const updateId = update.update_id;
    try {
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
      await reply(
        env,
        chatId,
        `✅ Задача принята в очередь: Issue #${issue.number}\n` +
          `${issue.html_url}\n` +
          `Локальный OpenCode подхватит её автоматически, обычно в течение ~5 минут.\n` +
          `Проверка: /status ${issue.number}`,
      );
      return ok();
    } catch (e) {
      console.error("webhook error:", e && e.stack ? e.stack : String(e));
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

function ownerRepo(env) {
  return { owner: env.GH_OWNER || "avovka0-spec", repo: env.GH_REPO || "price-radar" };
}

async function ghGet(env, path) {
  const { owner, repo } = ownerRepo(env);
  const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}${path}`, { headers: ghHeaders(env) });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  return { res, text, data };
}

async function findIssueByUpdate(env, updateId) {
  const { data } = await ghGet(
    env,
    "/issues?state=all&labels=telegram-task&sort=created&direction=desc&per_page=100",
  );
  if (!Array.isArray(data)) return null;
  const marker = `telegram-update-id: ${updateId}`;
  return data.find((i) => !i.pull_request && typeof i.body === "string" && i.body.includes(marker)) || null;
}

async function createIssue(env, title, body) {
  const { owner, repo } = ownerRepo(env);
  const url = `${GITHUB_API}/repos/${owner}/${repo}/issues`;

  const post = async (payload) => {
    const res = await fetch(url, {
      method: "POST",
      headers: ghHeaders(env),
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch {}
    return { res, text, data };
  };

  let r = await post({ title, body, labels: ["telegram-task"] });
  if (r.res.status === 422 && /label/i.test(r.text)) {
    r = await post({ title, body });
  }
  if (!r.res.ok) throw new Error(`GitHub ${r.res.status}: ${r.text.slice(0, 300)}`);
  return r.data;
}

function shortTitle(s, n = 48) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

function inferStage(issue, comments) {
  const bodies = (comments || []).map((c) => String(c.body || ""));
  const joined = bodies.join("\n");
  if (issue.state === "closed") {
    if (/✅|завершил выполнение|успеш/i.test(joined)) return "✅ готово";
    if (/❌|ошибка|failed|таймаут/i.test(joined)) return "❌ ошибка";
    return "закрыто";
  }
  if (/watcher принял задачу|🤖 OpenCode watcher/i.test(joined)) return "🚀 выполняется (watcher подхватил)";
  return "⏳ в очереди (ждёт локальный watcher, до ~5 мин)";
}

async function issueStatusLine(env, issue, fetchComments = false) {
  let comments = [];
  if (fetchComments || issue.state === "open") {
    const { data } = await ghGet(env, `/issues/${issue.number}/comments?per_page=20`);
    if (Array.isArray(data)) comments = data;
  }
  const stage = inferStage(issue, comments);
  const when = issue.updated_at ? String(issue.updated_at).replace("T", " ").replace("Z", " UTC") : "";
  return `#${issue.number} ${stage}\n${shortTitle(issue.title)}\n${when}\n${issue.html_url}`;
}

async function buildStatus(env, arg) {
  const num = arg && /^\d+$/.test(arg) ? Number(arg) : null;
  if (num) {
    const { res, data } = await ghGet(env, `/issues/${num}`);
    if (!res.ok || !data || data.pull_request) return `Issue #${num} не найден.`;
    return await issueStatusLine(env, data, true);
  }

  const { res, data } = await ghGet(
    env,
    "/issues?state=all&labels=telegram-task&sort=updated&direction=desc&per_page=8",
  );
  if (!res.ok || !Array.isArray(data)) return "Не удалось получить список задач.";
  const issues = data.filter((i) => i && !i.pull_request);
  if (!issues.length) return "Задач telegram-task пока нет. Отправьте текст — создам Issue.";

  const lines = [];
  for (const issue of issues.slice(0, 6)) {
    let comments = [];
    if (issue.state === "open") {
      const c = await ghGet(env, `/issues/${issue.number}/comments?per_page=20`);
      if (Array.isArray(c.data)) comments = c.data;
    } else {
      // для закрытых достаточно заголовка состояния; комментарии подтянем только если нужно позже
      const c = await ghGet(env, `/issues/${issue.number}/comments?per_page=10&direction=desc`);
      if (Array.isArray(c.data)) comments = c.data;
    }
    const stage = inferStage(issue, comments);
    lines.push(`#${issue.number} ${stage} — ${shortTitle(issue.title, 42)}`);
  }
  lines.push("", "Подробно: /status <номер>, например /status " + issues[0].number);
  return lines.join("\n");
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
    console.error("telegram reply failed:", e && e.message ? e.message : String(e));
  }
}
