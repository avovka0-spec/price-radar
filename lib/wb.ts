// Wildberries: разбор ссылки и открытый API цены =====

export function parseWbLink(url: string): { sku: string; url: string } | null {
  const s = url.trim();
  const m = s.match(/(?:catalog|nm)=(\d{4,})/) || s.match(/^(\d{4,})$/);
  if (!m) return null;
  const sku = m[1];
  return { sku, url: `https://www.wildberries.ru/catalog/${sku}/detail.aspx` };
}

export function parseOzonLink(url: string): { sku: string; url: string; name: string; marketplace: "ozon" } | null {
  const s = url.trim();
  // https://www.ozon.ru/product/slug-name-123456789/  или  https://ozon.ru/product/...
  const m = s.match(/ozon\.ru\/product\/([^/?#]+)/i);
  if (m) {
    const slug = m[1];
    const idMatch = slug.match(/(\d{6,})$/);
    const id = idMatch ? idMatch[1] : slug;
    // имя из slug: убираем хвостовой артикул и дефисы
    const name = slug
      .replace(/-\d{6,}$/, "")
      .replace(/[-_]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return { sku: `ozon:${id}`, url: `https://www.ozon.ru/product/${slug}/`, name: name || "Товар Ozon", marketplace: "ozon" };
  }
  // короткая ссылка ozon.ru/t/abc
  const t = s.match(/ozon\.ru\/t\/([A-Za-z0-9]+)/i);
  if (t) return { sku: `ozon:t:${t[1]}`, url: s, name: "Товар Ozon", marketplace: "ozon" };
  return null;
}

export type ParsedProduct = { sku: string; url: string; name: string; marketplace: "wb" | "ozon" | "ali" | "ym" };

export function parseAliExpressLink(url: string): { sku: string; url: string; name: string; marketplace: "ali" } | null {
  const s = url.trim();
  // https://www.aliexpress.com/item/1005001234567890.html  /  https://aliexpress.ru/item/...
  const m = s.match(/aliexpress\.(?:com|ru)\/item\/(\d+)/i);
  if (m) {
    return { sku: `ali:${m[1]}`, url: s.split("?")[0], name: "Товар AliExpress", marketplace: "ali" };
  }
  // короткая ссылка a.aliexpress.com/...
  const t = s.match(/a\.aliexpress\.com\/_([A-Za-z0-9]+)/i);
  if (t) return { sku: `ali:short:${t[1]}`, url: s, name: "Товар AliExpress", marketplace: "ali" };
  // партнёрская/короткая ali.click/... (редирект на карточку; агент резолвит по факту)
  const c = s.match(/ali\.click\/([A-Za-z0-9_-]+)/i);
  if (c) {
    const clean = s.replace(/[?#].*$/, "");
    return { sku: `ali:click:${c[1]}`, url: clean || s, name: "Товар AliExpress", marketplace: "ali" };
  }
  // s.click.aliexpress.com и похожие редиректы
  const sc = s.match(/(?:s\.click\.aliexpress\.com|aliexpress\.click)\/\S*?([A-Za-z0-9_-]{6,})(?:[/?#]|$)/i);
  if (sc && /click|aliexpress/i.test(s)) {
    return { sku: `ali:click:${sc[1]}`, url: s, name: "Товар AliExpress", marketplace: "ali" };
  }
  return null;
}

export function parseYandexMarketLink(url: string): ParsedProduct | null {
  const s = url.trim();
  // https://market.yandex.ru/product--slug/123456789 или /card/slug/123456789
  let m = s.match(/market\.yandex\.[a-z]+\/(?:product--|card\/)([^/?#]+)\/(\d{5,})/i);
  if (!m) m = s.match(/market\.yandex\.[a-z]+\/.*?[?&](?:productId|sku|id)=(\d{5,})/i);
  if (!m) return null;
  const id = m[2] || m[1];
  if (!/^\d{5,}$/.test(id)) return null;
  const slug = m[2] ? m[1] : "";
  let name = "";
  try { name = decodeURIComponent(slug).replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim(); } catch { name = slug.replace(/[-_]+/g, " "); }
  if (/^\d+$/.test(name)) name = "";
  const cleanUrl = s.split("?")[0];
  return { sku: `ym:${id}`, url: cleanUrl || s, name: name || "Товар Яндекс Маркета", marketplace: "ym" };
}

export function parseProductLink(url: string): ParsedProduct | null {
  const wb = parseWbLink(url);
  if (wb) return { sku: wb.sku, url: wb.url, name: "", marketplace: "wb" };
  const oz = parseOzonLink(url);
  if (oz) return oz;
  const al = parseAliExpressLink(url);
  if (al) return al;
  const ym = parseYandexMarketLink(url);
  if (ym) return ym;
  return null;
}

/** Эвристика: достаёт название товара из текста "поделиться" (промо + название + цена + ссылка). */
export function extractProductName(raw: string): string {
  let s = String(raw || "").replace(/\r/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return "";
  // убираем URL
  s = s.replace(/https?:\/\/\S+/gi, " ").replace(/\s+/g, " ").trim();
  // частые промо-префиксы до двоеточия
  const promo = s.match(/^.*?(?:распродаже|скидк[аиоуюяеё]*|акци[ия]|предложени[ея]|sale|deal)\s*[:—-]\s*/i);
  if (promo && promo[0].length < 140) s = s.slice(promo[0].length);
  // отрезаем хвост с ценой/скидкой
  s = s.replace(/\s+(?:за|цена|всего|от)\s+\d[\d\s\u00a0]*(?:[.,]\d+)?\s*[₽рrub$€].*$/i, " ");
  s = s.replace(/\s*[-—–]\s*со\s+скидк.*$/i, " ");
  s = s.replace(/\s*скидк[аи].*$/i, " ");
  s = s.replace(/\s+\d[\d\s\u00a0]*(?:[.,]\d+)?\s*[₽р](?:\s|$).*$/i, " ");
  s = s.replace(/^[\s:—\-•!?.]+|[\s:—\-•!?.]+$/g, "").replace(/\s+/g, " ").trim();
  if (s.length < 4 || s.length > 180) return "";
  // слишком общий мусор
  if (/^(вот|такая|только|супер|выгодно|купи|закажи)$/i.test(s)) return "";
  return s;
}

// basket-бакет для картинки (алгоритм WB, может меняться со временем)
export function wbImageUrl(sku: string): string | undefined {
  const n = Number(sku);
  if (!n) return undefined;
  const vol = Math.floor(n / 100000);
  const part = Math.floor(n / 1000);
  const b =
    vol <= 143 ? 1 : vol <= 287 ? 2 : vol <= 431 ? 3 : vol <= 719 ? 4 : vol <= 1007 ? 5 :
    vol <= 1061 ? 6 : vol <= 1115 ? 7 : vol <= 1168 ? 8 : vol <= 1220 ? 9 : vol <= 1273 ? 10 :
    vol <= 1326 ? 11 : vol <= 1379 ? 12 : vol <= 1432 ? 13 : vol <= 2469 ? 14 : vol <= 3129 ? 15 : 16;
  return `https://basket-${String(b).padStart(2, "0")}.wbbasket.ru/vol${vol}/part${part}/${sku}/images/c246x328/1.webp`;
}

export interface WbCard {
  name: string;
  brand: string;
  price: number; // ₽ с учётом скидки
}

// Открытый API карточки (без ключей и капчи). Используется и на клиенте, и в Actions.
export async function fetchWbCard(sku: string): Promise<WbCard | null> {
  const u = `https://card.wb.ru/cards/v2/detail?appType=1&curr=rub&dest=-1257786&spp=30&nm=${sku}`;
  try {
    const res = await fetch(u, {
      headers: { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/605.1.15" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const j = await res.json();
    const p = j?.data?.products?.[0];
    if (!p) return null;
    const price = (p.salePriceU ?? 0) / 100;
    if (!price) return null;
    return { name: p.name ?? "", brand: p.brand ?? "", price };
  } catch {
    return null;
  }
}
