// Генерация VAPID-ключей для Web Push. Результат кладём в GitHub Secrets,
// а публичную часть — в public/data/config.json.
import webPush from "web-push";
import { readFileSync, writeFileSync } from "node:fs";

const keys = webPush.generateVAPIDKeys();
console.log(`\nVAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}\n`);
console.log("1) Задайте оба значения как GitHub Secrets: Settings → Secrets and variables → Actions");
console.log("2) Добавьте VAPID_SUBJECT (например, mailto:you@example.com) — опционально");

try {
  const p = "public/data/config.json";
  const cfg = JSON.parse(readFileSync(p, "utf8"));
  if (cfg.vapidPublicKey !== keys.publicKey) {
    cfg.vapidPublicKey = keys.publicKey;
    writeFileSync(p, JSON.stringify(cfg, null, 2));
    console.log("3) Публичный ключ записан в public/data/config.json (этот файл можно коммитить — он публичный по определению)");
  }
} catch {
  console.log("(config.json обновить не удалось — впишите publicKey вручную)");
}
