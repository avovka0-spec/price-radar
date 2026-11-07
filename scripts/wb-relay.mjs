// Мини-relay для Wildberries API. Запускать на сервере с российским IP.
//
//   WB_RELAY_KEY=<случайная строка> PORT=8787 node scripts/wb-relay.mjs
//
// URL для секрета WB_PROXY_URL:
//   https://<домен>/wb/<ключ>        (relay сам добавит ?nm=...)
//   или http://<ip>:8787/wb/<ключ>
//
// Проверка: https://<домен>/wb/<ключ>?nm=1545780372
import * as http from "node:http";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";
const KEY = process.env.WB_RELAY_KEY || "";
const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile Safari/604.1";

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");

  if (url.pathname === "/" || url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("ok");
  }
  if (!url.pathname.startsWith("/wb")) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("not found");
  }

  const pathKey = url.pathname.startsWith("/wb/") ? decodeURIComponent(url.pathname.slice(4)) : "";
  const key = url.searchParams.get("key") || pathKey;
  if (KEY && key !== KEY) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("forbidden");
  }

  const nm = url.searchParams.get("nm") || "";
  if (!/^\d{4,15}$/.test(nm)) {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ error: "nm required" }));
  }

  try {
    const r = await fetch(
      `https://card.wb.ru/cards/v2/detail?appType=1&curr=rub&dest=-1257786&spp=30&nm=${nm}`,
      { headers: { "User-Agent": UA, Accept: "*/*" }, signal: AbortSignal.timeout(15000) },
    );
    const body = await r.text();
    res.writeHead(r.status, {
      "Content-Type": r.headers.get("content-type") || "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(body);
  } catch (e) {
    res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: e && e.message ? e.message : String(e) }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`WB relay: http://${HOST}:${PORT}/wb/<key>`);
  if (!KEY) console.log("! WB_RELAY_KEY не задан — relay открыт всем, задайте ключ");
});
