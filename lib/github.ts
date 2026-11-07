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
  return `GitHub API ${status}: ${body.slice(0, 200)}`;
}

async function ghJson<T>(cfg: GhConfig, path: string, init?: RequestInit): Promise<T> {
  const url = `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${path}?ref=${cfg.branch}`;
  const request = (token: string) =>
    fetch(url, { ...init, headers: { ...headers(token), ...(init?.headers ?? {}) } });

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

/** Проверяет токен и возвращает login пользователя (кнопка «Проверить токен»). */
export async function checkToken(cfg: GhConfig): Promise<string> {
  if (!cfg.token) throw new Error("Токен не задан");
  const res = await fetch("https://api.github.com/user", { headers: headers(cfg.token) });
  if (!res.ok) throw new GhError(res.status, apiError(res.status, await res.text()));
  const user = (await res.json()) as { login?: string };
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

/** Записывает JSON-файл в репозиторий одним коммитом. */
export async function writeRepoJson(cfg: GhConfig, path: string, data: unknown, message: string) {
  let sha: string | undefined;
  try {
    sha = (await ghJson<any>(cfg, path)).sha;
  } catch {
    /* файла ещё нет — создадим; ошибку токена покажет PUT ниже */
  }
  const res = await fetch(`https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${path}`, {
    method: "PUT",
    headers: { ...headers(cfg.token), "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      content: btoa(unescape(encodeURIComponent(JSON.stringify(data, null, 2)))),
      branch: cfg.branch,
      ...(sha ? { sha } : {}),
    }),
  });
  if (!res.ok) throw new GhError(res.status, apiError(res.status, await res.text()));
}
