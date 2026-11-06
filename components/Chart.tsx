"use client";
import { useMemo } from "react";
import type { History } from "@/lib/types";

const MAXH = 180 * 24 * 3600 * 1000;

export function fmt(n: number) {
  return n.toLocaleString("ru-RU", { maximumFractionDigits: 0 }) + " ₽";
}

/** SVG-график динамики цены за до 180 дней, iOS-стиль */
export default function Chart({ history, sku, height = 220 }: { history?: History; sku: string; height?: number }) {
  const W = 400;
  const H = height;
  const PT = { l: 4, r: 52, t: 14, b: 22 };

  const pts = useMemo(() => {
    const raw = history?.[sku] ?? [];
    const now = Date.now();
    return raw
      .filter((x) => now - x.t <= MAXH)
      .map((x) => ({ t: x.t, p: x.p, m: x.m }))
      .sort((a, b) => a.t - b.t);
  }, [history, sku]);

  if (pts.length < 2) {
    return (
      <div className="empty" style={{ padding: "20px 8px" }}>
        Пока одна точка цены — график появится после второй проверки Actions.
      </div>
    );
  }

  const lo = Math.min(...pts.map((x) => x.p));
  const hi = Math.max(...pts.map((x) => x.p));
  const pad = Math.max((hi - lo) * 0.08, hi * 0.01, 10);
  const y0 = lo - pad, y1 = hi + pad;
  const t0 = Math.min(pts[0].t, pts[0].t);
  const t1 = Math.max(Date.now(), pts[pts.length - 1].t);
  const X = (t: number) => PT.l + ((t - t0) / Math.max(1, t1 - t0)) * (W - PT.l - PT.r);
  const Y = (p: number) => PT.t + (1 - (p - y0) / Math.max(1, y1 - y0)) * (H - PT.t - PT.b);

  const path = pts.map((x, i) => `${i ? "L" : "M"}${X(x.t).toFixed(1)},${Y(x.p).toFixed(1)}`).join(" ");
  const area = `${path} L${X(pts[pts.length - 1].t).toFixed(1)},${H - PT.b} L${PT.l},${H - PT.b} Z`;
  const last = pts[pts.length - 1];
  const first = t0 === pts[0].t;
  const fmtD = (t: number) => new Date(t).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });

  const grid = [0.25, 0.5, 0.75].map((k) => y0 + k * (y1 - y0));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={height} role="img" aria-label="График цены" data-pts={pts.length}>
      <defs>
        <linearGradient id="ga" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.25" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {grid.map((g, i) => (
        <line key={i} x1={PT.l} x2={W - PT.r} y1={Y(g)} y2={Y(g)} stroke="var(--sep)" strokeWidth="0.5" />
      ))}
      <path d={area} fill="url(#ga)" />
      <path d={path} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={X(last.t)} cy={Y(last.p)} r="3.5" fill="var(--accent)" />
      {/* полые маркеры — цены, введённые вручную */}
      {pts.filter((x) => x.m).map((x, i) => (
        <circle key={"m" + i} cx={X(x.t)} cy={Y(x.p)} r="3.2" fill="var(--card)" stroke="var(--accent)" strokeWidth="1.5" />
      ))}
      {/* подписи цен по правой оси */}
      <text x={W - 2} y={Y(hi + 0) + 4} textAnchor="end" fontSize="10" fill="var(--text2)">{Math.round(hi)}</text>
      <line x1={PT.l} x2={W - PT.r} y1={Y(hi)} y2={Y(hi)} stroke="var(--sep)" strokeWidth="0.5" />
      <text x={W - 2} y={Y(lo) - 3} textAnchor="end" fontSize="10" fill="var(--text2)">{Math.round(lo)}</text>
      <text x={PT.l} y={H - 6} fontSize="10" fill="var(--text2)">{fmtD(t0)}</text>
      <text x={W - PT.r} y={H - 6} textAnchor="end" fontSize="10" fill="var(--text2)">{fmtD(last.t)}</text>
    </svg>
  );
}
