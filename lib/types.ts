export interface Product {
  id: string;
  sku: string;
  url: string;
  name: string;
  brand: string;
  marketplace?: "wb" | "ozon" | "ali" | "ym";
  image?: string;
  /** Публичная/трекинговая цена (₽). В public/data хранить только её/нечувствительные данные. */
  currentPrice?: number;
  /** Персональная цена из ЛК. НЕ записывать в public/data/products.json; только локальные/приватные потоки. */
  personalPrice?: number;
  personalPriceCapturedAt?: number;
  priceSource?: "public" | "personal" | "manual";
  lastPrice?: number;
  lastNotifyPrice?: number;
  lastCheckedAt?: number;
  targetPrice?: number; // ₽
  thresholdPct?: number; // % изменения для уведомления
  notify: boolean;
  addedAt: number;
}

export type History = Record<string, { t: number; p: number; m?: 1 }[]>; // m=1 — точка введена вручную

export interface PushSub {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  addedAt: number;
}

export interface AppConfig {
  vapidPublicKey: string;
}
