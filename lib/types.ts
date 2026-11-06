export interface Product {
  id: string;
  sku: string;
  url: string;
  name: string;
  brand: string;
  image?: string;
  currentPrice?: number; // ₽
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
