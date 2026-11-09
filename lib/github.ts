// Работа с GitHub Contents API из браузера: чтение/запись data-файлов репозитория

export interface GhConfig {
  owner: string;
  repo: string;
  token: string;
  branch: string;
}

export class GhError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function headers(token: string) {
  const h: Record<string, string> = { Accept: "application/vnd.github+json" };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

function apiError(status: number, body: string) {
  if (status === 401) {
    return "GitHub: токен недействителен или отозван. Откройте настройки и вставьте новый fine-grained токен (Contents: Read and write).";
  }
  if (status === 403) {
    return `GitHub: доступ запрещён. Проверьте, что у токена есть право Contents: Read and write на этот репозиторий. ${body.slice(0, 120)}`;
  }
  if (status === 404) {
    return "GitHub: репозиторий, ветка или файл не найдены. Проверьте owner/repo/branch в настройках.";
  }
  if (status === 409) {
    return "GitHub: конфликт версии файла (SHA). Данные изменились параллельно (например, агент цен). Обновите список и повторите.";
  }
  return `GitHub API ${status}: ${body.slice(0, 200)}`;
}

function withTimeout(ms = 25000) {
  try {
    return AbortSignal.timeout(ms);
  } catch {
    return undefined;
  }
}

async function ghJson<T>(cfg: GhConfig, path: string, init?: RequestInit): Promise<T> {
  const url = `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${path}?ref=${cfg.branch}&_ts=${Date.now()}`;
  const request = (token: string) =>
    fetch(url, {
      ...init,
      cache: "no-store",
      signal: init?.signal ?? withTimeout(25000),
      headers: { ...headers(token), ...(init?.headers ?? {}) },
    });

  let res = await request(cfg.token);
  // Публичный репозиторий можно читать без токена. Если токен протух или отозван,
  // не блокируем показ данных — пробуем анонимно (только чтение).
  if (!res.ok && cfg.token && (res.status === 401 || res.status === 403)) {
    const retry = await request("");
    if (retry.ok) res = retry;
  }
  if (!res.ok) throw new GhError(res.status, apiError(res.status, await res.text()));
  return res.json();
}

/** Проверяет токен и доступ к Contents (кнопка «Проверить токен»). */
export async function checkToken(cfg: GhConfig): Promise<string> {
  if (!cfg.token) throw new Error("Токен не задан");
  const res = await fetch("https://api.github.com/user", { headers: headers(cfg.token), signal: withTimeout(15000) });
  if (!res.ok) throw new GhError(res.status, apiError(res.status, await res.text()));
  const user = (await res.json()) as { login?: string };

  // Проверяем именно доступ к файлам: токен с правами только Issues сюда не подойдёт.
  const repoRes = await fetch(
    `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/public/data/products.json?ref=${cfg.branch}`,
    { headers: headers(cfg.token), signal: withTimeout(15000) },
  );
  if (!repoRes.ok) {
    throw new GhError(
      repoRes.status,
      "Токен валиден, но нет доступа к Contents репозитория. Нужен fine-grained токен с правом Contents: Read and write на этот репозиторий.",
    );
  }
  return user.login ?? "ok";
}

/** Читает JSON-файл из репозитория (свежая версия, с обходом кэша Pages). */
export async function readRepoJson<T>(cfg: GhConfig, path: string): Promise<T | null> {
  try {
    const j = await ghJson<any>(cfg, path);
    // atob возвращает binary string (1 байт = 1 char); UTF-8 нужно декодировать через TextDecoder,
    // иначе русский текст превращается в «Ð½Ð°Ð·Ð²Ð°Ð½Ð¸Ðµ».
    const bytes = Uint8Array.from(atob(j.content.replace(/\s/g, "")), (c) => c.charCodeAt(0));
    const text = new TextDecoder("utf-8").decode(bytes);
    return JSON.parse(text) as T;
  } catch (e: any) {
    if (e?.status === 404 || e?.message?.includes("404")) return null;
    throw e;
  }
}

function encodeContent(data: unknown) {
  return btoa(unescape(encodeURIComponent(JSON.stringify(data, null, 2))));
}

async function putContent(cfg: GhConfig, path: string, data: unknown, message: string, sha?: string) {
  return fetch(`https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${path}`, {
    method: "PUT",
    headers: { ...headers(cfg.token), "Content-Type": "application/json" },
    signal: withTimeout(25000),
    body: JSON.stringify({
      message,
      content: encodeContent(data),
      branch: cfg.branch,
      ...(sha ? { sha } : {}),
    }),
  });
}

async function readSha(cfg: GhConfig, path: string): Promise<string | undefined> {
  try {
    return (await ghJson<any>(cfg, path)).sha as string | undefined;
  } catch (e: any) {
    if (e?.status === 404) return undefined;
    throw e;
  }
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Записывает JSON-файл в репозиторий одним коммитом (с повторами при конфликте SHA). */
export async function writeRepoJson(cfg: GhConfig, path: string, data: unknown, message: string, retries = 6) {
  let sha = await readSha(cfg, path);
  for (let attempt = 0; attempt < retries; attempt++) {
    if (attempt > 0) await pause(250 * attempt);
    const res = await putContent(cfg, path, data, message, sha);
    if (res.ok) return;
    if (res.status === 409) {
      sha = await readSha(cfg, path);
      continue;
    }
    throw new GhError(res.status, apiError(res.status, await res.text()));
  }
  throw new GhError(409, apiError(409, ""));
}

/**
 * Атомарно (насколько позволяет Contents API) читает JSON, применяет transform к свежим данным
 * и пишет обратно. При конфликте SHA повторяет весь цикл read→transform→write, чтобы не затирать
 * параллельные изменения (например, обновление цен из Actions).
 */
export async function updateRepoJson<T>(
  cfg: GhConfig,
  path: string,
  message: string,
  transform: (current: T | null) => T,
  retries = 6,
): Promise<T> {
  let lastErr: any = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    if (attempt > 0) await pause(300 * attempt);
    const current = await readRepoJson<T>(cfg, path);
    const next = transform(current);
    let sha = await readSha(cfg, path);
    for (let w = 0; w < 3; w++) {
      if (w > 0) await pause(200 * w);
      const res = await putContent(cfg, path, next, message, sha);
      if (res.ok) return next;
      if (res.status !== 409) throw new GhError(res.status, apiError(res.status, await res.text()));
      lastErr = new GhError(409, apiError(409, ""));
      sha = await readSha(cfg, path);
    }
    // внешний цикл перечитает свежие данные и применит transform заново
  }
  throw lastErr ?? new GhError(409, apiError(409, ""));
}
