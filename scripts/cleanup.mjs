#!/usr/bin/env node
/**
 * Очистка локального мусора price-radar (кэши, логи, артефакты сборки).
 * Не трогает исходники, data/products.json, public/data/*, .env, git-историю.
 *
 * Использование:
 *   node scripts/cleanup.mjs            # сухой прогон (показывает, что будет удалено)
 *   node scripts/cleanup.mjs --apply    # удалить
 *   node scripts/cleanup.mjs --apply --logs-days 14 --keep-issue-logs 20
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APPLY = process.argv.includes("--apply");
const args = process.argv.slice(2);
function numArg(name, def) {
  const i = args.indexOf(name);
  if (i === -1) return def;
  const v = Number(args[i + 1]);
  return Number.isFinite(v) && v >= 0 ? v : def;
}
const LOGS_DAYS = numArg("--logs-days", 30);
const KEEP_ISSUE_LOGS = numArg("--keep-issue-logs", 30);
const MAX_MAIN_LOG_MB = numArg("--max-main-log-mb", 5);

let bytes = 0;
let files = 0;
let dirs = 0;

function fmt(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function statSafe(p) { try { return fs.statSync(p); } catch { return null; } }

function rmFile(p, reason) {
  const s = statSafe(p);
  if (!s || !s.isFile()) return;
  console.log(`${APPLY ? "rm" : "would rm"}  ${path.relative(ROOT, p)}  (${fmt(s.size)})  — ${reason}`);
  bytes += s.size; files++;
  if (APPLY) try { fs.unlinkSync(p); } catch (e) { console.log(`  ! ${e.message}`); }
}

function rmDir(p, reason) {
  const s = statSafe(p);
  if (!s || !s.isDirectory()) return;
  let size = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const fp = path.join(d, e.name);
      if (e.isDirectory()) walk(fp); else { try { size += fs.statSync(fp).size; } catch {} }
    }
  };
  try { walk(p); } catch {}
  console.log(`${APPLY ? "rmdir" : "would rmdir"} ${path.relative(ROOT, p)}  (${fmt(size)})  — ${reason}`);
  bytes += size; dirs++;
  if (APPLY) try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { console.log(`  ! ${e.message}`); }
}

function pruneLogs() {
  const logsDir = path.join(ROOT, "logs");
  if (!fs.existsSync(logsDir)) return;
  const now = Date.now();
  const issueLogs = [];
  for (const name of fs.readdirSync(logsDir)) {
    const p = path.join(logsDir, name);
    const s = statSafe(p);
    if (!s || !s.isFile()) continue;
    if (/^opencode-issue-\d+\.log$/i.test(name)) {
      issueLogs.push({ p, name, mtime: s.mtimeMs, size: s.size });
      continue;
    }
    if (name === "opencode-issues.log" || name === "check-prices.log") {
      if (s.size > MAX_MAIN_LOG_MB * 1024 * 1024) {
        console.log(`${APPLY ? "truncate" : "would truncate"} logs/${name}  (${fmt(s.size)} > ${MAX_MAIN_LOG_MB} MB)`);
        bytes += s.size - 1024; files++;
        if (APPLY) {
          try {
            const fd = fs.openSync(p, "r");
            const keep = Math.min(1024 * 1024, s.size);
            const buf = Buffer.alloc(keep);
            fs.readSync(fd, buf, 0, keep, s.size - keep);
            fs.closeSync(fd);
            fs.writeFileSync(p, `[truncated by cleanup at ${new Date().toISOString()}]\n` + buf.toString("utf8"));
          } catch (e) { console.log(`  ! ${e.message}`); }
        }
      }
      continue;
    }
    if (now - s.mtimeMs > LOGS_DAYS * 24 * 3600 * 1000) rmFile(p, `старше ${LOGS_DAYS} дн.`);
  }
  issueLogs.sort((a, b) => b.mtime - a.mtime);
  issueLogs.slice(KEEP_ISSUE_LOGS).forEach((f) => rmFile(f.p, `старые issue-логи (keep ${KEEP_ISSUE_LOGS})`));
  issueLogs.forEach((f) => {
    if (now - f.mtime > LOGS_DAYS * 24 * 3600 * 1000) rmFile(f.p, `старше ${LOGS_DAYS} дн.`);
  });
}

function pruneLocal() {
  const localDir = path.join(ROOT, ".local");
  if (!fs.existsSync(localDir)) return;
  const metricsDir = path.join(localDir, "edge-profile", "BrowserMetrics");
  if (fs.existsSync(metricsDir)) {
    for (const name of fs.readdirSync(metricsDir)) {
      if (/\.pma$/i.test(name)) rmFile(path.join(metricsDir, name), "BrowserMetrics .pma (кэш)");
    }
  }
  const crashpad = path.join(localDir, "edge-profile", "Crashpad", "reports");
  if (fs.existsSync(crashpad)) rmDir(crashpad, "crash reports");
  for (const rel of [
    "edge-profile/Default/Cache",
    "edge-profile/Default/Code Cache",
    "edge-profile/Default/GPUCache",
    "edge-profile/Default/Service Worker/CacheStorage",
    "edge-profile/Default/Service Worker/ScriptCache",
    "edge-profile/GrShaderCache",
    "edge-profile/ShaderCache",
  ]) {
    const p = path.join(localDir, rel);
    if (fs.existsSync(p)) rmDir(p, "браузерный кэш профиля (пересоздаётся)");
  }
}

function pruneBuildArtifacts() {
  for (const rel of [".next/cache", "out", "tsconfig.tsbuildinfo", ".tsbuildinfo"]) {
    const p = path.join(ROOT, rel);
    const s = statSafe(p);
    if (!s) continue;
    if (s.isDirectory()) rmDir(p, "артефакт сборки/кэш (пересобирается)");
    else rmFile(p, "артефакт сборки (пересобирается)");
  }
}

console.log(`cleanup ${APPLY ? "APPLY" : "DRY-RUN"}  (root: ${ROOT})`);
console.log(`  logs-days=${LOGS_DAYS} keep-issue-logs=${KEEP_ISSUE_LOGS} max-main-log-mb=${MAX_MAIN_LOG_MB}\n`);
pruneLogs();
pruneLocal();
pruneBuildArtifacts();
console.log(`\nИтого: ${files} файлов, ${dirs} папок, ~${fmt(bytes)} ${APPLY ? "освобождено" : "можно освободить"}`);
if (!APPLY) console.log("Запусти с --apply для фактической очистки.");
