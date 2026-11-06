// Работа с GitHub Contents API из браузера: чтение/запись data-файлов репозитория

export interface GhConfig {
  owner: string;
  repo: string;
  token: string;
  branch: string;
}

function headers(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
  };
}

async function ghJson<T>(cfg: GhConfig, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(
    `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${path}?ref=${cfg.branch}`,
    { ...init, headers: { ...headers(cfg.token), ...(init?.headers ?? {}) } }
  );
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/** Читает JSON-файл из репозитория (свежая версия, с обходом кэша Pages). */
export async function readRepoJson<T>(cfg: GhConfig, path: string): Promise<T | null> {
  try {
    const j = await ghJson<any>(cfg, path);
    return JSON.parse(atob(j.content)) as T;
  } catch (e: any) {
    if (e?.message?.includes("404")) return null;
    throw e;
  }
}

/** Записывает JSON-файл в репозиторий одним коммитом. */
export async function writeRepoJson(cfg: GhConfig, path: string, data: unknown, message: string) {
  let sha: string | undefined;
  try {
    sha = (await ghJson<any>(cfg, path)).sha;
  } catch {
    /* файла ещё нет */
  }
  await fetch(`https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${path}`, {
    method: "PUT",
    headers: headers(cfg.token),
    body: JSON.stringify({
      message,
      content: btoa(unescape(encodeURIComponent(JSON.stringify(data, null, 2)))),
      branch: cfg.branch,
      ...(sha ? { sha } : {}),
    }),
  }).then((r) => {
    if (!r.ok) throw new Error(`commit failed: ${r.status} ${r.text()}`);
  });
}
