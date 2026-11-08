#!/usr/bin/env node
// Локальный watcher: принимает открытые GitHub Issues с меткой telegram-task
// и запускает OpenCode для их выполнения.
//
// Запуск (вручную):
//   node scripts/opencode-issues-watcher.mjs
//   node scripts/opencode-issues-watcher.mjs --dry-run
//
// Планировщик Windows: каждые 5-10 минут, "выполнять только для вошедшего пользователя"
// (нужен рабочий стол/OpenCode background service). Скрипт использует lock-файл,
// поэтому параллельные запуски безопасно пропускаются.
//
// Переменные (.env или окружение):
//   GH_TOKEN / GITHUB_TOKEN  — доступ к GitHub API (fallback: git credential fill)
//   GH_OWNER                 — по умолчанию avovka0-spec
//   GH_REPO                  — по умолчанию price-radar
//   TELEGRAM_CHAT_ID         — по умолчанию 1782021699
//   OPENCODE_CLI             — путь к opencode-cli.exe (автопоиск, если не задан)
//   OPENCODE_ISSUES_MODEL    — модель для opencode run (если не задана — дефолт OpenCode)
//   OPENCODE_ISSUES_TIMEOUT_MS — таймаут на задачу, по умолчанию 1800000 (30 мин)
import * as fs from "node:fs";
import * as path from "node:path";
import * as https from "node:https";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL = path.join(ROOT, ".local");
const LOGS = path.join(ROOT, "logs");
const STATE_FILE = path.join(LOCAL, "opencode-issues.json");
const LOCK_FILE = path.join(LOCAL, "opencode-issues.lock");
const LOCK_STALE_MS = 2 * 60 * 60 * 1000;
const RUNNING_STALE_MS = 2 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 2;
const DRY_RUN = process.argv.includes("--dry-run");

function nowIso() {
  return new Date().toISOString();
}

function log(msg) {
  const line = `[${nowIso()}] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(LOGS, { recursive: true });
    fs.appendFileSync(path.join(LOGS, "opencode-issues.log"), line + "\n", "utf8");
  } catch {}
}

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
      ) value = value.slice(1, -1);
      if (!process.env[m[1]]) process.env[m[1]] = value;
    }
  } catch {}
}

function getGhTokenFromGit() {
  try {
    const r = spawnSync("git", ["credential", "fill"], {
      input: "protocol=https\nhost=github.com\n\n",
      encoding: "utf8",
      cwd: ROOT,
      env: { ...process.env, GCM_INTERACTIVE: "Never" },
      windowsHide: true,
      timeout: 15000,
    });
    const out = String(r.stdout || "");
    const m = out.match(/^password=(.*)$/m);
    return m ? m[1].trim() : "";
  } catch {
    return "";
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
          "User-Agent": "price-radar-opencode-watcher",
          ...(body ? { "Content-Length": Buffer.byteLength(body) } : {}),
          ...(headers || {}),
        },
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          let json = null;
          try { json = buf ? JSON.parse(buf) : null; } catch {}
          resolve({ status: res.statusCode || 0, body: buf, json });
        });
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { issues: {} };
  }
}

function writeState(state) {
  fs.mkdirSync(LOCAL, { recursive: true });
  const tmp = STATE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, STATE_FILE);
}

function acquireLock() {
  fs.mkdirSync(LOCAL, { recursive: true });
  try {
    fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, at: nowIso() }), { flag: "wx" });
    return true;
  } catch {
    try {
      const age = Date.now() - fs.statSync(LOCK_FILE).mtimeMs;
      if (age < LOCK_STALE_MS) return false;
      fs.unlinkSync(LOCK_FILE);
      fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, at: nowIso() }), { flag: "wx" });
      return true;
    } catch {
      return false;
    }
  }
}

function releaseLock() {
  try { fs.unlinkSync(LOCK_FILE); } catch {}
}

function findOpencodeCli() {
  if (process.env.OPENCODE_CLI && fs.existsSync(process.env.OPENCODE_CLI)) {
    return process.env.OPENCODE_CLI;
  }
  const base = path.join(process.env.APPDATA || "", "ai.opencode.desktop", "cli");
  try {
    const dirs = fs.readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
      .reverse();
    for (const d of dirs) {
      const p = path.join(base, d, "opencode-cli.exe");
      if (fs.existsSync(p)) return p;
    }
  } catch {}
  const bundled = path.join(
    process.env.LOCALAPPDATA || "",
    "Programs", "ai.opencode.desktop", "resources", "opencode-cli.exe",
  );
  if (fs.existsSync(bundled)) return bundled;
  return "";
}

async function notify(token, owner, repo, chatId, text) {
  const body = JSON.stringify({ ref: "main", inputs: { chat_id: String(chatId), text } });
  const r = await http(
    "POST",
    `https://api.github.com/repos/${owner}/${repo}/actions/workflows/telegram-notify.yml/dispatches`,
    ghHeaders(token),
    body,
  );
  if (r.status === 204) return;
  if ([403, 404, 422].includes(r.status)) {
    const f = await http(
      "POST",
      `https://api.github.com/repos/${owner}/${repo}/dispatches`,
      ghHeaders(token),
      JSON.stringify({ event_type: "telegram-notify", client_payload: { chat_id: String(chatId), text } }),
    );
    if (f.status !== 204) log(`notify fallback failed: ${f.status} ${f.body.slice(0, 200)}`);
    return;
  }
  log(`notify failed: ${r.status} ${r.body.slice(0, 200)}`);
}

async function commentIssue(token, owner, repo, number, body) {
  const r = await http(
    "POST",
    `https://api.github.com/repos/${owner}/${repo}/issues/${number}/comments`,
    ghHeaders(token),
    JSON.stringify({ body }),
  );
  if (r.status < 200 || r.status >= 300) {
    log(`comment #${number} failed: ${r.status} ${r.body.slice(0, 200)}`);
  }
}

async function closeIssue(token, owner, repo, number) {
  const r = await http(
    "PATCH",
    `https://api.github.com/repos/${owner}/${repo}/issues/${number}`,
    ghHeaders(token),
    JSON.stringify({ state: "closed", state_reason: "completed" }),
  );
  if (r.status < 200 || r.status >= 300) {
    throw new Error(`close #${number} failed: ${r.status} ${r.body.slice(0, 200)}`);
  }
}

function buildPrompt(issue) {
  const body = String(issue.body || "").slice(0, 12000);
  return [
    `Выполни задачу из GitHub Issue #${issue.number} в репозитории price-radar.`,
    `Заголовок: ${issue.title || ""}`,
    ``,
    `Текст Issue:`,
    body,
    ``,
    `Требования:`,
    `- Работай в текущем репозитории (D:\\Prog_dev\\ai\\price-radar).`,
    `- Следуй правилам из AGENTS.md. Не печатай токены/секреты.`,
    `- Если задача требует правок кода/документов — внеси изменения, проверь их разумно, сделай git commit и git push.`,
    `- Если задача — просто сообщение/вопрос без правок в репозитории — ответь по делу и не делай лишних коммитов.`,
    `- Статусы в Telegram отправляй через: node scripts/notify-telegram.mjs "..." (при наличии GH_TOKEN). Не спамь.`,
    `- В конце дай краткий итог: что сделано, какие файлы/коммиты, есть ли ограничения.`,
    `- Не закрывай Issue сам и не меняй метки — это сделает watcher после проверки результата.`,
  ].join("\n");
}

function runOpencode(cli, prompt, timeoutMs, logFile) {
  return new Promise((resolve) => {
    fs.mkdirSync(LOGS, { recursive: true });
    const out = fs.createWriteStream(logFile, { flags: "a" });
    const header = `\n=== ${nowIso()} opencode run ===\n`;
    out.write(header);

    const args = ["run", "--auto"];
    // Дефолт OpenCode может упираться в лимиты подписки; для автоматики нужен явный free/доступный model.
    const model = process.env.OPENCODE_ISSUES_MODEL || "opencode-go/iceman-contributor-free";
    args.push("-m", model);
    args.push(prompt);

    const child = spawn(cli, args, {
      cwd: ROOT,
      env: { ...process.env, GCM_INTERACTIVE: "Never" },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let killedByTimeout = false;
    const timer = setTimeout(() => {
      killedByTimeout = true;
      try { child.kill(); } catch {}
      setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 5000).unref?.();
    }, timeoutMs);

    child.stdout.on("data", (d) => out.write(d));
    child.stderr.on("data", (d) => out.write(d));
    child.on("error", (err) => {
      clearTimeout(timer);
      out.write(`\n[spawn error] ${err && err.stack ? err.stack : err}\n`);
      out.end();
      resolve({ code: 1, killedByTimeout, error: err });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      out.write(`\n[exit] code=${code} signal=${signal || ""} timeout=${killedByTimeout}\n`);
      out.end();
      resolve({ code: code == null ? 1 : code, killedByTimeout, signal });
    });
  });
}

function tailFile(file, maxChars = 1200) {
  try {
    const s = fs.readFileSync(file, "utf8");
    return s.length > maxChars ? "…" + s.slice(-maxChars) : s;
  } catch {
    return "";
  }
}

async function main() {
  loadDotEnv();
  fs.mkdirSync(LOCAL, { recursive: true });
  fs.mkdirSync(LOGS, { recursive: true });

  const owner = process.env.GH_OWNER || "avovka0-spec";
  const repo = process.env.GH_REPO || "price-radar";
  const chatId = process.env.TELEGRAM_CHAT_ID || "1782021699";
  const timeoutMs = Number(process.env.OPENCODE_ISSUES_TIMEOUT_MS || 1800000);
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || getGhTokenFromGit();
  if (!token) throw new Error("GH_TOKEN не найден (env/.env/git credential)");

  const cli = findOpencodeCli();
  if (!cli) throw new Error("opencode-cli.exe не найден. Задайте OPENCODE_CLI.");

  if (!acquireLock()) {
    log("lock active, skip");
    return;
  }

  try {
    const state = readState();
    state.issues = state.issues || {};

    const issuesRes = await http(
      "GET",
      `https://api.github.com/repos/${owner}/${repo}/issues?state=open&labels=telegram-task&sort=created&direction=asc&per_page=20`,
      ghHeaders(token),
    );
    if (issuesRes.status < 200 || issuesRes.status >= 300) {
      throw new Error(`list issues failed: ${issuesRes.status} ${issuesRes.body.slice(0, 300)}`);
    }
    const issues = (issuesRes.json || []).filter((i) => i && !i.pull_request);
    log(`open telegram-task issues: ${issues.length}${DRY_RUN ? " (dry-run)" : ""}`);

    for (const issue of issues) {
      const key = String(issue.number);
      const prev = state.issues[key] || {};
      const age = prev.at ? Date.now() - Date.parse(prev.at) : Infinity;
      if (prev.status === "done") continue;
      if (prev.status === "running" && age < RUNNING_STALE_MS) continue;
      if (prev.status === "failed" && Number(prev.attempts || 0) >= MAX_ATTEMPTS && age < 24 * 60 * 60 * 1000) continue;

      const attempt = Number(prev.attempts || 0) + 1;
      const logFile = path.join(LOGS, `opencode-issue-${key}.log`);
      log(`pick #${key} attempt ${attempt}: ${issue.title || ""}`);

      if (DRY_RUN) {
        console.log(JSON.stringify({ number: issue.number, title: issue.title, logFile }, null, 2));
        continue;
      }

      state.issues[key] = { status: "running", at: nowIso(), attempt, title: issue.title || "" };
      writeState(state);

      await notify(token, owner, repo, chatId, `🚀 OpenCode принял задачу: Issue #${key}\n${issue.title || ""}`);
      await commentIssue(token, owner, repo, key,
        `🤖 OpenCode watcher принял задачу (попытка ${attempt}).\nЛог на ПК: \`logs/opencode-issue-${key}.log\`.`);

      const prompt = buildPrompt(issue);
      const result = await runOpencode(cli, prompt, timeoutMs, logFile);
      const ok = result.code === 0 && !result.killedByTimeout;

      if (ok) {
        state.issues[key] = { status: "done", at: nowIso(), attempt, title: issue.title || "" };
        writeState(state);
        await commentIssue(token, owner, repo, key,
          `✅ OpenCode завершил выполнение (попытка ${attempt}, exit 0).\nВремя: ${nowIso()}.`);
        try { await closeIssue(token, owner, repo, key); } catch (e) { log(String(e && e.message || e)); }
        await notify(token, owner, repo, chatId, `✅ OpenCode выполнил Issue #${key}\n${issue.title || ""}\n${issue.html_url || ""}`);
        log(`done #${key}`);
      } else {
        const tail = tailFile(logFile).replace(/`/g, "'").slice(0, 900);
        state.issues[key] = {
          status: "failed", at: nowIso(), attempt, title: issue.title || "",
          error: result.killedByTimeout ? "timeout" : `exit ${result.code}`,
        };
        writeState(state);
        await commentIssue(token, owner, repo, key,
          `❌ OpenCode завершился с ошибкой (попытка ${attempt}).\n` +
          `Причина: ${result.killedByTimeout ? `таймаут ${Math.round(timeoutMs/60000)} мин` : `exit code ${result.code}`}.\n` +
          `Проверьте \`logs/opencode-issue-${key}.log\` на ПК.`);
        await notify(token, owner, repo, chatId,
          `❌ OpenCode ошибка по Issue #${key} (попытка ${attempt})\n${issue.title || ""}\n` +
          `${result.killedByTimeout ? "Таймаут" : `Exit ${result.code}`}. Лог: logs/opencode-issue-${key}.log`);
        log(`failed #${key}: ${result.killedByTimeout ? "timeout" : result.code}\n${tail}`);
      }
      // По одному Issue за запуск — чтобы не держать Task Scheduler долго и не путать логи.
      break;
    }
  } finally {
    releaseLock();
  }
}

main().catch((e) => {
  log(`fatal: ${e && e.stack ? e.stack : e}`);
  releaseLock();
  process.exit(1);
});
