// Wildberries: разбор ссылки и открытый API цены =====

export function parseWbLink(url: string): { sku: string; url: string } | null {
  const s = url.trim();
  // https://www.wildberries.ru/catalog/12345678/detail.aspx
  // https://wb.ru/catalog/12345678/detail.aspx · ?nm=...
  const m = s.match(/(?:catalog|nm)=(\d{4,})/) || s.match(/^(\d{4,})$/);
  if (!m) return null;
  const sku = m[1];
  return { sku, url: `https://www.wildberries.ru/catalog/${sku}/detail.aspx` };
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
