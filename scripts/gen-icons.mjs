// Генерация PNG-иконок приложения без зависимостей (zlib + ручной PNG-энкодер).
// Дизайн: скруглённый квадрат с вертикальным градиентом (бирюза→синий),
// белая «свеча цены» — нисходящая линия графика с точкой.
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";

const crcTable = new Uint32Array(256).map((_, i) => {
  let c = i;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bufWithCrcRemoved) {
  let c = 0xffffffff;
  for (const b of bufWithCrcRemoved) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePng(w, h, rgba) {
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function makeIcon(size, { maskable = false } = {}) {
  const px = Buffer.alloc(size * size * 4);
  const R = size * 0.225; // радиус скругления углов
  const half = size / 2;
  const at = (x, y, cr, cg, cb, alpha = 1) => {
    const i = (y * size + x) * 4;
    px[i] = cr; px[i + 1] = cg; px[i + 2] = cb; px[i + 3] = Math.max(px[i + 3], alpha * 255) | 0;
  };
  // фон: диагональный градиент #10c98f → #007aff
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let a = 1;
    if (!maskable) { // скругление с 1px сглаживанием
      const dx = Math.max(0, R - x, x - (size - 1 - R));
      const dy = Math.max(0, R - y, y - (size - 1 - R));
      const d = Math.hypot(dx, dy);
      a = d <= R ? 1 : d >= R + 1.5 ? 0 : 1 - (d - R) / 1.5;
      if (a <= 0) continue;
    }
    const k = (x + y) / (2 * size);
    at(x, y,
      Math.min(255, Math.round(16 + 0xb0 * (1 - k))),
      201,
      Math.min(255, Math.round(143 + 136 * k)),
      a);
  }
  // ломаная «цена падает» — staircase вниз
  const pts = [[0.18, 0.28], [0.38, 0.28], [0.38, 0.52], [0.60, 0.52], [0.60, 0.72], [0.84, 0.72]];
  const lw = size * 0.055;
  const stroke = (x, y, r, g, b, alpha) => {
    if (maskable) { if (Math.hypot(x - half, y - half) > size * 0.44) return; }
    at(Math.round(x), Math.round(y), r, g, b, alpha);
  };
  for (let i = 0; i < pts.length - 1; i++) {
    const [x1n, y1n] = pts[i], [x2n, y2n] = pts[i + 1];
    const x1 = x1n * size, y1 = y1n * size, x2 = x2n * size, y2 = y2n * size;
    const steps = Math.ceil(Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1)));
    for (let s = 0; s <= steps; s++) {
      const t = s / Math.max(1, steps);
      const X = x1 + (x2 - x1) * t, Y = y1 + (y2 - y1) * t;
      for (let oy = -lw; oy <= lw; oy++) for (let ox = -lw; ox <= lw; ox++) {
        if (ox * ox + oy * oy <= lw * lw) stroke(X + ox, Y + oy, 255, 255, 255, 1);
      }
    }
  }
  // белая точка в конце линии
  const [ex, ey] = [pts[pts.length - 1][0] * size, pts[pts.length - 1][1] * size];
  const br = lw * 2.1;
  for (let oy = -br; oy <= br; oy++) for (let ox = -br; ox <= br; ox++) {
    const d = Math.hypot(ox, oy);
    if (d <= br) stroke(ex + ox, ey + oy, 255, 255, 255, d > br - 1.5 ? 0.55 : 1);
  }
  return encodePng(size, size, px);
}

mkdirSync("public/icons", { recursive: true });
writeFileSync("public/icons/icon-512.png", makeIcon(512));
writeFileSync("public/icons/icon-192.png", makeIcon(192));
writeFileSync("public/icons/apple-touch-180.png", makeIcon(180));
// бейдж уведомлений — маленькая белая точка на прозрачном фоне, монотонный Альфа шаблон не обязателен
writeFileSync("public/icons/badge-96.png", makeIcon(96, { maskable: true }));
console.log("icons OK → public/icons/");
