import * as fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const LOCAL = path.join(ROOT, ".local");

export function loadDotEnv(root = ROOT) {
  try {
    const raw = fs.readFileSync(path.join(root, ".env"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim() || /^\s*#/.test(line)) continue;
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      let value = m[2];
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!process.env[m[1]]) process.env[m[1]] = value;
    }
  } catch {}
}

export function resolveEdgeProfile() {
  loadDotEnv();
  const explicit = process.env.PRICERADAR_EDGE_PROFILE;
  if (explicit) return path.isAbsolute(explicit) ? explicit : path.join(ROOT, explicit);
  const preferred = path.join(LOCAL, "edge-profile-priceradar");
  const legacy = path.join(LOCAL, "edge-profile");
  if (fs.existsSync(preferred)) return preferred;
  if (fs.existsSync(legacy)) return legacy; // совместимость с существующим профилем
  return preferred;
}

export function edgeLaunchOptions({ headed = false, background = false } = {}) {
  loadDotEnv();
  const headless = process.env.PRICERADAR_BROWSER_HEADLESS === "1"; // экспериментально: WB может блокировать
  // "background": не headless (для WB), но стараемся не мелькать окном.
  const args = ["--disable-blink-features=AutomationControlled"];
  if (headed) {
    args.push("--start-maximized");
  } else if (background) {
    // Окно вне экрана + минимизировано: меньше визуального шума, но остаётся headed-браузер.
    args.push("--window-position=-32000,-32000", "--window-size=1280,900", "--start-minimized");
  } else {
    args.push("--start-minimized");
  }
  return {
    channel: "msedge",
    headless,
    locale: "ru-RU",
    viewport: null,
    args,
    ignoreDefaultArgs: ["--enable-automation"],
  };
}

export const ROOT_DIR = ROOT;
export const LOCAL_DIR = LOCAL;
