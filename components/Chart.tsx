"use client";
import { useMemo } from "react";
import type { History } from "@/lib/types";

const MAXH = 180 * 24 * 3600 * 1000;

export function fmt(n: number) {
  return n.toLocaleString("ru-RU", { maximumFractionDigits: 0 }) + " ₽";
}

function short(n: number) {
  if (Math.abs(n) >= 100000) return (n / 1000).toLocaleString("ru-RU", { maximumFractionDigits: 0 }) + "k";
  return Math.round(n).toLocaleString("ru-RU");
}

/** SVG-график динамики цены за до 180 дней */
export default function Chart({ history, sku, height = 220 }: { history?: History; sku: string; height?: number }) {
  const W = 400;
  const H = height;
  const PT = { l: 6, r: 54, t: 16, b: 24 };

  const pts = useMemo(() => {
    const raw = history?.[sku] ?? [];
    const now = Date.now();
    return raw
      .filter((x) => now - x.t <= MAXH)
      .map((x) => ({ t: x.t, p: x.p, m: x.m }))
      .sort((a, b) => a.t - b.t);
  }, [history, sku]);

  const fmtD = (t: number) => new Date(t).toLocaleDateString("ru-RU", { day: "numeric", month: "short" });

  if (pts.length === 0) {
    return <div className="empty" style={{ padding: "20px 8px" }}>Нет истории цен — появится после первой проверки.</div>;
  }
  if (pts.length === 1) {
    const p = pts[0];
    return (
      <div className="card" style={{ padding: "14px 12px", margin: "8px 0" }}>
        <div style={{ fontSize: 22, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{fmt(p.p)}</div>
        <div className="sub" style={{ marginTop: 4 }}>1 точка · {fmtD(p.t)} · график динамики появится после следующих проверок</div>
      </div>
    );
  }

  const prices = pts.map((x) => x.p);
  const lo = Math.min(...prices), hi = Math.max(...prices);
  const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
  const pad = Math.max((hi - lo) * 0.1, hi * 0.012, 10);
  const y0 = Math.max(0, lo - pad), y1 = hi + pad;
  const t0 = pts[0].t;
  const t1 = Math.max(Date.now(), pts[pts.length - 1].t);
  const X = (t: number) => PT.l + ((t - t0) / Math.max(1, t1 - t0)) * (W - PT.l - PT.r);
  const Y = (p: number) => PT.t + (1 - (p - y0) / Math.max(1, y1 - y0)) * (H - PT.t - PT.b);

  const path = pts.map((x, i) => `${i ? "L" : "M"}${X(x.t).toFixed(1)},${Y(x.p).toFixed(1)}`).join(" ");
  const area = `${path} L${X(pts[pts.length - 1].t).toFixed(1)},${H - PT.b} L${X(pts[0].t).toFixed(1)},${H - PT.b} Z`;
  const last = pts[pts.length - 1];
  const first = pts[0];
  const delta = last.p - first.p;
  const deltaPct = first.p ? (delta / first.p) * 100 : 0;
  const trendColor = delta < 0 ? "var(--down, #37c871)" : delta > 0 ? "var(--up, #ff5d6c)" : "var(--accent)";
  const grid = [0.25, 0.5, 0.75].map((k) => y0 + k * (y1 - y0));
  const manual = pts.filter((x) => x.m);
  const minPt = pts.find(x => x.p === lo) || last;
  const maxPt = pts.find(x => x.p === hi) || last;

  return (
    <div style={{ margin: "8px 0" }}>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "baseline", marginBottom: 4, fontSize: 12 }}>
        <span style={{ color: trendColor, fontWeight: 600 }}>
          {delta === 0 ? "без изменений" : `${delta < 0 ? "▼" : "▲"} ${Math.abs(Math.round(delta)).toLocaleString("ru-RU")} ₽ (${deltaPct > 0 ? "+" : ""}${deltaPct.toFixed(1)}%)`}
        </span>
        <span className="sub">за период · {pts.length} точек{manual.length ? `, вручную: ${manual.length}` : ""}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={height} role="img" aria-label="График цены" data-pts={pts.length} style={{ display: "block" }}>
        <defs>
          <linearGradient id="ga" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {grid.map((g, i) => (
          <line key={i} x1={PT.l} x2={W - PT.r} y1={Y(g)} y2={Y(g)} stroke="var(--sep, #263258)" strokeWidth="0.6" />
        ))}
        {hi !== lo && <line x1={PT.l} x2={W - PT.r} y1={Y(avg)} y2={Y(avg)} stroke="var(--sep, #263258)" strokeWidth="0.8" strokeDasharray="3 3" opacity="0.8" />}
        <path d={area} fill="url(#ga)" />
        <path d={path} fill="none" stroke="var(--accent)" strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" />
        {hi !== lo && minPt !== maxPt && (
          <>
            <circle cx={X(minPt.t)} cy={Y(minPt.p)} r="2.6" fill="var(--down, #37c871)" opacity="0.9" />
            <circle cx={X(maxPt.t)} cy={Y(maxPt.p)} r="2.6" fill="var(--up, #ff5d6c)" opacity="0.9" />
          </>
        )}
        {manual.map((x, i) => (
          <circle key={"m" + i} cx={X(x.t)} cy={Y(x.p)} r="3.2" fill="var(--card, #141c33)" stroke="var(--accent)" strokeWidth="1.5"><title>Вручную: {fmt(x.p)} · {fmtD(x.t)}</title></circle>
        ))}
        <circle cx={X(last.t)} cy={Y(last.p)} r="4" fill="var(--accent)" />
        <text x={W - 2} y={Math.max(PT.t + 8, Y(hi) + 4)} textAnchor="end" fontSize="10" fill="var(--text2, #93a0c6)">{short(hi)}</text>
        {hi !== lo && <text x={W - 2} y={Math.min(H - PT.b - 2, Y(lo) - 3)} textAnchor="end" fontSize="10" fill="var(--text2, #93a0c6)">{short(lo)}</text>}
        <text x={PT.l} y={H - 6} fontSize="10" fill="var(--text2, #93a0c6)">{fmtD(t0)}</text>
        <text x={W - PT.r} y={H - 6} textAnchor="end" fontSize="10" fill="var(--text2, #93a0c6)">{fmtD(last.t)}</text>
      </svg>
    </div>
  );
}
