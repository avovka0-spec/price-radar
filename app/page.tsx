"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Chart, { fmt } from "@/components/Chart";
import { parseProductLink, wbImageUrl, fetchWbCard } from "@/lib/wb";
import type { Product, History, PushSub, AppConfig } from "@/lib/types";
import { GhConfig, readRepoJson, writeRepoJson, checkToken } from "@/lib/github";
import { registerPush, subToJson } from "@/lib/push";

const LS = "pradar.cfg.v1";
interface LocalCfg extends GhConfig {
  pushOn?: boolean;
}

/* Демо-данные: ?demo — синтетическая история 180 дней, чтобы увидеть UI без настройки */
function demoData(): { products: Product[]; history: History } {
  const rnd = (a: number, b: number) => a + Math.random() * (b - a);
  const hist: History = {};
  const ps: Product[] = [];
  for (const [sku, name, brand, base] of [
    ["14893201", "Кроссовки мужские повседневные, 42 размер", "DEMO", 5490],
    ["207364019", "Умные часы, AMOLED, силиконовый ремешок", "DEMO", 8990],
  ] as [string, string, string, number][]) {
    const pts: { t: number; p: number }[] = [];
    let p = base;
    const now = Date.now();
    for (let d = 180; d >= 0; d -= 0.5) {
      p = Math.max(base * 0.55, p + rnd(-40, 40));
      // «распродажа» в середине периода
      if (Math.abs(d - 90) < 6) p = base * 0.78;
      if (pts.length === 0 || Math.abs(pts[pts.length - 1].p - p) > base * 0.003 || d < 1) {
        pts.push({ t: now - d * 864e5, p: Math.round(p) });
      }
    }
    hist[sku] = pts;
    ps.push({
      id: `demo-${sku}`, sku, url: `https://www.wildberries.ru/catalog/${sku}/detail.aspx`,
      name, brand, image: undefined, marketplace: "wb", currentPrice: pts[pts.length - 1].p,
      targetPrice: Math.round(base * 0.8), thresholdPct: 8, notify: true, addedAt: now - 180 * 864e5,
    });
  }
  return { products: ps, history: hist };
}

export default function Page() {
  const [cfg, setCfg] = useState<LocalCfg | null>(null);
  const [link, setLink] = useState("");
  const [products, setProducts] = useState<Product[]>([]);
  const [history, setHistory] = useState<History>({});
  const [vapid, setVapid] = useState<string>("");
  const [cfgLoadErr, setCfgLoadErr] = useState("");
  const [addErr, setAddErr] = useState("");
  const [toast, setToast] = useState("");
  const [busyCfg, setBusyCfg] = useState(false);
  const [detail, setDetail] = useState<string | null>(null); // sku в деталке
  const [settingsOpen, settingsSheetOpen] = useState(false); // вкладка настроек
  const [showOnboard, setShowOnboard] = useState(false);
  const [demo, setDemo] = useState(false);
  const [isIos, setIsIos] = useState(false);
  const [booting, setBooting] = useState(true);
  // --- pull-to-refresh ---
  const [pullY, setPullY] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const pullStartRef = useRef(0);
  const pullingRef = useRef(false);
  const pullYRef = useRef(0);
  useEffect(() => {
    const onStart = (e: TouchEvent) => {
      if (window.scrollY <= 2 && e.touches.length === 1) {
        pullStartRef.current = e.touches[0].clientY;
        pullingRef.current = true;
      }
    };
    const onMove = (e: TouchEvent) => {
      if (!pullingRef.current) return;
      const dy = e.touches[0].clientY - pullStartRef.current;
      if (dy > 0 && window.scrollY <= 2) {
        const v = Math.min(dy * 0.5, 90);
        pullYRef.current = v;
        setPullY(v);
        if (dy > 8) e.preventDefault();
      } else {
        pullingRef.current = false;
        pullYRef.current = 0;
        setPullY(0);
      }
    };
    const onEnd = async () => {
      if (!pullingRef.current) return;
      const v = pullYRef.current;
      pullingRef.current = false;
      if (v > 50) {
        setRefreshing(true);
        if (demo) { const d = demoData(); setProducts(d.products); setHistory(d.history); }
        else if (cfg) await loadRepo(cfg, true);
        setRefreshing(false);
      }
      pullYRef.current = 0;
      setPullY(0);
    };
    window.addEventListener("touchstart", onStart, { passive: true });
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend", onEnd, { passive: true });
    window.addEventListener("touchcancel", onEnd, { passive: true });
    return () => {
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
      window.removeEventListener("touchcancel", onEnd);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg, demo]);

  const show = useCallback((m: string) => {
    setToast(m);
    setTimeout(() => setToast(""), 2600);
  }, []);

  // --- загрузка локальной конфигурации + данных репо ---
  useEffect(() => {
    setIsIos(/iP(hone|ad|od)/.test(navigator.userAgent) || /Macintosh.*Mobile Safari/.test(navigator.userAgent));
    const isDemo = new URLSearchParams(window.location.search).has("demo");
    const handleShared = () => {
      const sp = new URLSearchParams(window.location.search);
      const sharedUrl = sp.get("url") || sp.get("text") || "";
      const sharedTitle = sp.get("title") || "";
      if (!sharedUrl) return;
      window.history.replaceState({}, "", window.location.pathname);
      if (sharedTitle) show(`Поделено: ${sharedTitle.slice(0, 60)}`);
      setTimeout(() => { addProduct(sharedUrl); }, 400);
    };

    (async () => {
      try {
        if (isDemo) {
          setDemo(true);
          const d = demoData();
          setProducts(d.products);
          setHistory(d.history);
          handleShared();
          return;
        }
        const raw = localStorage.getItem(LS);
        if (!raw) { setShowOnboard(true); handleShared(); return; }
        const c: LocalCfg = JSON.parse(raw);
        setCfg(c);
        await loadRepo(c, false);
        handleShared();
      } catch (e: any) {
        setCfgLoadErr(e?.message ?? "Ошибка запуска");
        setShowOnboard(true);
      } finally {
        setBooting(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadRepo = useCallback(async (c: LocalCfg, announce: boolean) => {
    try {
      const [p, h, k] = await Promise.all([
        readRepoJson<{ products?: Product[] } | Product[]>(c, "public/data/products.json"),
        readRepoJson<History>(c, "public/data/history.json"),
        readRepoJson<AppConfig>(c, "public/data/config.json"),
      ]);
      const list = Array.isArray(p) ? p : p?.products ?? [];
      setProducts(list);
      setHistory(h ?? {});
      setVapid(k?.vapidPublicKey ?? "");
      if (announce) show("Данные обновлены");
    } catch (e: any) {
      setCfgLoadErr(e?.message ?? "Ошибка загрузки");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveCfg = (c: LocalCfg) => {
    localStorage.setItem(LS, JSON.stringify(c));
    setCfg(c);
    setShowOnboard(false);
    loadRepo(c, true);
  };

  // --- добавление товара ---
  const addProduct = async (overrideUrl?: string) => {
    setAddErr("");
    if (!cfg && !demo) return setShowOnboard(true);
    const input = (overrideUrl ?? link).trim();
    const parsed = parseProductLink(input);
    if (!parsed) return setAddErr("Не похоже на ссылку WB/Ozon/Яндекс Маркет/AliExpress или артикул");
    if (products.some((p) => p.sku === parsed.sku)) {
      if (!overrideUrl) setLink("");
      return show("Товар уже отслеживается");
    }

    let name = parsed.name;
    let brand = "";
    let currentPrice: number | undefined;
    let image: string | undefined;
    if (parsed.marketplace === "wb") {
      const card = await fetchWbCard(parsed.sku);
      if (card) { name = card.name || name; brand = card.brand || brand; currentPrice = card.price; }
      image = wbImageUrl(parsed.sku);
    } else {
      // Ozon/Яндекс Маркет/AliExpress: имя из ссылки/slug если есть; цену уточним вручную или локальным агентом
      if (!name) name = parsed.marketplace === "ym" ? "Товар Яндекс Маркета" : parsed.marketplace === "ali" ? "Товар AliExpress" : "Товар Ozon";
    }

    const created: Product = {
      id: crypto.randomUUID(),
      sku: parsed.sku,
      url: parsed.url,
      name: name || "— название придёт после следующей проверки",
      brand,
      marketplace: parsed.marketplace,
      image,
      currentPrice,
      targetPrice: undefined,
      thresholdPct: 10,
      notify: true,
      addedAt: Date.now(),
    };
    const next = [...products, created];
    setProducts(next);
    if (!overrideUrl) setLink("");
    try {
      const his = { ...history, [parsed.sku]: currentPrice ? [...(history[parsed.sku] ?? []), { t: Date.now(), p: currentPrice }] : (history[parsed.sku] ?? []) };
      setHistory(his);
      if (cfg) {
        await writeRepoJson(cfg, "public/data/products.json", next, `Добавлен ${parsed.marketplace.toUpperCase()} ${parsed.sku}`);
        await writeRepoJson(cfg, "public/data/history.json", his, `История: ${parsed.sku}`);
      }
      show(parsed.marketplace === "wb" && currentPrice ? "Добавлено, цена получена" : "Добавлено. Цену уточним при следующей проверке (или введите вручную)");
    } catch (e: any) {
      setAddErr(`Не удалось закоммитить в репо: ${e?.message}. Проверьте токен/ветку в настройках.`);
    }
  };

  const saveProductList = async (next: Product[], msg: string) => {
    setProducts(next);
    if (cfg) {
      try { await writeRepoJson(cfg, "public/data/products.json", next, msg); } catch (e: any) { show(`Ошибка коммита: ${e?.message}`); }
    }
  };

  const patch = (sku: string, changes: Partial<Product>) => {
    const next = products.map((p) => (p.sku === sku ? { ...p, ...changes } : p));
    if (cfg) {
      // изменим локально, коммит позже в debounce не нужен — пишем сразу
      writeRepoJson(cfg, "public/data/products.json", next, `Настройки ${sku}`).catch(() => {});
    }
    setProducts(next);
  };

  const remove = (sku: string) => {
    const next = products.filter((p) => p.sku !== sku);
    const his = { ...history };
    delete his[sku];
    setProducts(next);
    setHistory(his);
    setDetail(null);
    if (cfg) {
      Promise.allSettled([
        writeRepoJson(cfg, "public/data/products.json", next, `Удалён ${sku}`),
        writeRepoJson(cfg, "public/data/history.json", his, `История: удалён ${sku}`),
      ]).then(([a, b]) => {
        if (a.status === "rejected" || b.status === "rejected") show("Удалено локально, но не удалось сохранить в GitHub — обновите и проверьте");
        else show("Удалено");
      });
    }
  };

  // --- push ---
  const enablePush = async () => {
    if (!cfg) return;
    if (!vapid) return show("VAPID-ключ не задан (README: скрипт vapid → секреты → data/config.json)");
    try {
      const sub = await registerPush(vapid);
      const subs = (await readRepoJson<PushSub[]>(cfg, "public/data/push-subscriptions.json")) ?? [];
      const j = subToJson(sub);
      if (!subs.some((s) => s.endpoint === j.endpoint)) {
        await writeRepoJson(cfg, "public/data/push-subscriptions.json", [...subs, { ...j, addedAt: Date.now() }], "Подписка на push");
      }
      localStorage.setItem(LS, JSON.stringify({ ...cfg, pushOn: true }));
      setCfg({ ...cfg, pushOn: true });
      show("Уведомления включены");
    } catch (e: any) {
      show(`Push: ${e?.message ?? e}`);
    }
  };

  const dProduct = useMemo(() => products.find((p) => p.sku === detail) ?? null, [products, detail]);
  const [confirmDeleteSku, setConfirmDeleteSku] = useState<string | null>(null);
  const [armedDelete, setArmedDelete] = useState(false);
  const [manualVal, setManualVal] = useState("");
  useEffect(() => { setArmedDelete(false); setManualVal(""); }, [detail]);
  const touchStartX = useRef(0);
  const touchStartY = useRef(0);
  const addManualPoint = async () => {
    if (!dProduct) return;
    const price = Number(manualVal.replace(",", "."));
    if (!price || price <= 0) return show("Введите цену числом, например 4990");
    const pts = [...(history[dProduct.sku] ?? [])];
    const last = pts[pts.length - 1];
    if (last?.p === price && Date.now() - last.t < 6 * 3600e3) return show("Такая точка уже есть за последние 6 часов");
    pts.push({ t: Date.now(), p: price, m: 1 });
    setHistory({ ...history, [dProduct.sku]: pts });
    setManualVal("");
    if (cfg) {
      try {
        await writeRepoJson(cfg, "public/data/history.json", { ...history, [dProduct.sku]: pts }, `История: ручная точка ${dProduct.sku}`);
        show("Цена добавлена в график, попадёт в историю при следующей синхронизации");
      } catch (e: any) {
        show(`Точка сохранена локально, но коммит не удался: ${e?.message}`);
      }
    } else {
      show("Точка добавлена на график (демо — сохранена локально)");
    }
  };
  const stats = useCallback((sku: string) => {
    const now = Date.now();
    const pts = (history[sku] ?? []).filter((x) => now - x.t <= 30 * 24 * 3600 * 1000);
    const all = history[sku] ?? [];
    const of = (arr: { p: number }[]) => {
      if (!arr.length) return null;
      const ps = arr.map((x) => x.p);
      return { min: Math.min(...ps), max: Math.max(...ps), avg: ps.reduce((a, b) => a + b, 0) / ps.length };
    };
    return { d30: of(pts), all: of(all), days: all.length ? Math.min(180, Math.round((now - all[0].t) / 864e5)) : 0 };
  }, [history]);

  if (booting) {
    return (
      <main className="wrap" style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "60vh", color: "var(--text2, #93a0c6)" }}>
        Загрузка…
      </main>
    );
  }

  if (!cfg && !demo) {
    return <main className="wrap"><Onboard onSave={saveCfg} open={showOnboard} /></main>;
  }

  return (
    <main className="wrap">
      {(pullY > 0 || refreshing) && (
        <div style={{
          position: "fixed", top: 0, left: 0, right: 0, zIndex: 60,
          display: "flex", justifyContent: "center", alignItems: "center",
          height: 56, transform: `translateY(${Math.max(-20, pullY - 56)}px)`,
          transition: refreshing ? "transform .2s" : "none", pointerEvents: "none",
        }}>
          <div style={{
            width: 34, height: 34, borderRadius: 17,
            background: "var(--card)", boxShadow: "0 2px 8px rgba(0,0,0,.12)",
            display: "flex", alignItems: "center", justifyContent: "center",
            transform: `rotate(${pullY * 3}deg)`,
          }}>
            {refreshing ? "⟳" : "↓"}
          </div>
        </div>
      )}
      <h1 className="h1"><span className="dot" />ЦенРадар</h1>
      <p className="sub">Wildberries · история до 180 дней · push при изменении</p>

      {demo && (
        <div className="bnr">
          <b>Демо-режим</b> — синтетические цены для просмотра интерфейса. Реальные товары подключаются после настройки GitHub в ⚙️.
        </div>
      )}

      {cfgLoadErr && <div className="err">{cfgLoadErr}</div>}

      <div className="addrow">
        <input value={link} onChange={(e) => setLink(e.target.value)} placeholder="Ссылка Ozon/WB или артикул"
          inputMode="url" autoCapitalize="none" autoCorrect="off" onKeyDown={(e) => e.key === "Enter" && addProduct()} />
        <button onClick={() => addProduct()}>＋</button>
      </div>
      {addErr && <div className="err">{addErr}</div>}

      {products.length === 0 && (
        <div className="empty">Пока пусто.<br />Вставьте ссылку на товар WB/Ozon/Яндекс Маркет/AliExpress выше.<br />Проверка цен — по расписанию GitHub Actions/локального агента.</div>
      )}

      {products.map((p) => {
        const hist = history[p.sku] ?? [];
        const autos = hist.filter((x) => !x.m);
        const prev = autos.length > 1 ? autos[autos.length - 2].p : p.currentPrice;
        const delta = p.currentPrice && prev ? ((p.currentPrice - prev) / prev) * 100 : null;
        const s = stats(p.sku);

        if (confirmDeleteSku === p.sku) {
          return (
            <div className="card" key={p.sku} style={{ padding: 12, display: "flex", gap: 8, alignItems: "center" }}>
              <span style={{ flex: 1, fontSize: 14 }}>Удалить «{p.name.slice(0, 40)}»?</span>
              <button className="danger" style={{ width: "auto", padding: "8px 12px" }} onClick={() => { remove(p.sku); setConfirmDeleteSku(null); }}>Удалить</button>
              <button className="ghost small" onClick={() => setConfirmDeleteSku(null)}>Отмена</button>
            </div>
          );
        }

        return (
          <div className="card" key={p.sku}
            onTouchStart={(e) => { touchStartX.current = e.touches[0].clientX; touchStartY.current = e.touches[0].clientY; }}
            onTouchEnd={(e) => {
              const dx = e.changedTouches[0].clientX - touchStartX.current;
              const dy = e.changedTouches[0].clientY - touchStartY.current;
              if (dx < -60 && Math.abs(dx) > Math.abs(dy) * 1.5) setConfirmDeleteSku(p.sku);
            }}>
            <div className="pcard" onClick={() => setDetail(p.sku)}>
              {p.image ? <img src={p.image} alt="" onError={(e) => ((e.target as HTMLImageElement).style.visibility = "hidden")} /> : <div style={{ width: 56 }} />}
              <div className="pinfo">
                <div className="pname">{p.name}</div>
                <div className="pbrand">
                  {p.marketplace === "wb" && <span className="mpbadge wb">WB</span>}
                  {p.marketplace === "ozon" && <span className="mpbadge ozon">Ozon</span>}
                  {p.marketplace === "ym" && <span className="mpbadge ym">ЯМ</span>}
                  {p.marketplace === "ali" && <span className="mpbadge ali">Ali</span>}
                  {p.brand}{s?.days ? ` · ${s.days} дн. наблюдений` : ""}
                </div>
                <div className="prow">
                  {p.currentPrice ? <span className="pprice">{fmt(p.currentPrice)}</span> : <span className="pprice" style={{ color: "var(--text2)" }}>— ₽</span>}
                  {delta !== null && Math.abs(delta) >= 0.5 && (
                    <span className={`pdelta ${delta < 0 ? "down" : "up"}`}>{delta < 0 ? "▼" : "▲"} {Math.abs(delta).toFixed(1)}%</span>
                  )}
                </div>
              </div>
              <div style={{ width: 96, flex: "none", opacity: .9 }}>
                {hist.length > 1 ? <svg viewBox="0 0 100 40"><MiniSpark pts={hist.slice(-60)} /></svg> : null}
              </div>
            </div>
          </div>
        );
      })}

      <div className="card">
        <div className="pcard" onClick={() => settingsSheetOpen(true)}>
          <div className="pinfo">
            <div className="pname" style={{ color: "var(--accent)" }}>⚙️ Настройки · обновить · уведомления</div>
            <div className="pbrand">репозиторий: {cfg ? `${cfg.owner}/${cfg.repo}` : "— (демо)"} · push: {cfg?.pushOn ? "вкл" : "выкл"}</div>
          </div>
        </div>
      </div>

      {/* ---------- Детальная карточка ---------- */}
      {dProduct && (
        <>
          <div className="overlay show" onClick={() => setDetail(null)} />
          <div className="sheet show">
            <div className="grab" />
            <div className="inner">
              <div className="sheettitle">
                <span className="t">
                  {dProduct.marketplace === "wb" && <span className="mpbadge wb" style={{ marginRight: 6, verticalAlign: "middle" }}>WB</span>}
                  {dProduct.marketplace === "ozon" && <span className="mpbadge ozon" style={{ marginRight: 6, verticalAlign: "middle" }}>Ozon</span>}
                  {dProduct.marketplace === "ym" && <span className="mpbadge ym" style={{ marginRight: 6, verticalAlign: "middle" }}>ЯМ</span>}
                  {dProduct.marketplace === "ali" && <span className="mpbadge ali" style={{ marginRight: 6, verticalAlign: "middle" }}>Ali</span>}
                  {dProduct.brand && <b>{dProduct.brand} · </b>}{dProduct.name}
                </span>
                <button className="ghost small" onClick={() => setDetail(null)}>Готово</button>
              </div>
              {dProduct.currentPrice && <div style={{ fontSize: 32, fontWeight: 800, fontVariantNumeric: "tabular-nums" }}>{fmt(dProduct.currentPrice)}</div>}
              <Chart history={history} sku={dProduct.sku} />
              {(() => { const s = stats(dProduct.sku); return (
                <div className="statgrid">
                  <div className="stat"><div className="v">{s?.d30 ? fmt(s.d30.min) : "—"}</div><div className="l">мин 30д</div></div>
                  <div className="stat"><div className="v">{s?.d30 ? fmt(s.d30.avg) : "—"}</div><div className="l">сред 30д</div></div>
                  <div className="stat"><div className="v">{s?.d30 ? fmt(s.d30.max) : "—"}</div><div className="l">макс 30д</div></div>
                  <div className="stat"><div className="v">{s?.all ? fmt(s.all.min) : "—"}</div><div className="l">мин за всё</div></div>
                </div>
              ); })()}
              <div className="row2">
                <div className="field">
                  <label>Целевая цена, ₽</label>
                  <input type="number" inputMode="decimal" value={dProduct.targetPrice ?? ""} placeholder={dProduct.currentPrice ? `напр. ${Math.round(dProduct.currentPrice * .85)}` : "—"}
                    onChange={(e) => patch(dProduct.sku, { targetPrice: e.target.value ? Number(e.target.value) : undefined })} />
                </div>
                <div className="field">
                  <label>Порог изменения, %</label>
                  <input type="number" inputMode="decimal" value={dProduct.thresholdPct ?? ""} placeholder="10"
                    onChange={(e) => patch(dProduct.sku, { thresholdPct: e.target.value ? Number(e.target.value) : undefined })} />
                </div>
              </div>
              <div className="field">
                <label>Ввести цену вручную (полая точка на графике)</label>
                <div className="addrow" style={{ marginBottom: 0 }}>
                  <input inputMode="decimal" placeholder="Цена, которую вы видите, например 4990" value={manualVal} onChange={(e) => setManualVal(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addManualPoint()} />
                  <button style={{ width: 76 }} onClick={addManualPoint}>✓</button>
                </div>
              </div>
              <button className="ghost" style={{ width: "100%" }} onClick={() => patch(dProduct.sku, { notify: !dProduct.notify })}>
                {dProduct.notify ? "🔕 Отключить уведомления" : "🔔 Включить уведомления"}
              </button>
              <a className="linkrow" href={dProduct.url} target="_blank" rel="noreferrer">Открыть на {dProduct.marketplace === "ym" ? "Яндекс Маркете" : dProduct.marketplace === "ozon" ? "Ozon" : dProduct.marketplace === "ali" ? "AliExpress" : "Wildberries"} ↗</a>
              <button className="danger" onClick={() => {
                if (!armedDelete) { setArmedDelete(true); return; }
                remove(dProduct.sku); setArmedDelete(false);
              }}>
                {armedDelete ? "⚠️ Нажмите ещё раз — удалить окончательно" : "Удалить из отслеживания"}
              </button>
              {armedDelete && <button className="ghost small" style={{ width: "100%" }} onClick={() => setArmedDelete(false)}>Отмена</button>}
            </div>
          </div>
        </>
      )}

      {/* ---------- Настройки ---------- */}
      <SettingsSheet open={settingsOpen} onClose={() => settingsSheetOpen(false)} cfg={cfg} onSave={(c) => { saveCfg(c); settingsSheetOpen(false); }} onRefresh={() => cfg && loadRepo(cfg, true)} onPush={enablePush} vapid={vapid} isIos={isIos} />
      {toast && <div className="toast">{toast}</div>}
    </main>
  );
}

/* ---- Мини-спарклайн внутри карточки ---- */
function MiniSpark({ pts }: { pts: { t: number; p: number; m?: 1 }[] }) {
  if (pts.length < 2) return null;
  const y0 = Math.min(...pts.map((x) => x.p)), y1 = Math.max(...pts.map((x) => x.p));
  const X = (i: number) => (i / (pts.length - 1)) * 96 + 2;
  const Y = (p: number) => 38 - ((p - y0) / Math.max(1, y1 - y0)) * 32;
  const d = pts.map((x, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(x.p).toFixed(1)}`).join(" ");
  const color = pts[pts.length - 1].p <= pts[0].p ? "var(--down)" : "var(--up)";
  return <path d={d} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />;
}

/* ---- Онбординг (GitHub-конфигурация) ---- */
function Onboard({ open, onSave }: { open: boolean; onSave: (c: LocalCfg) => void }) {
  const [owner, setOwner] = useState("");
  const [repo, setRepo] = useState("");
  const [token, setToken] = useState("");
  const [branch, setBranch] = useState("main");
  return (
    <div className="card" style={{ padding: 16, marginTop: 40 }}>
      <div className="h1" style={{ fontSize: 22 }}>Добро пожаловать 👋</div>
      <p className="sub" style={{ margin: "0 0 12px" }}>
        Данные хранятся в вашем GitHub-репозитории: история цен пишет Actions, вы читаете и коммитите товары через API.
        Нужен <b>fine-grained токен</b> с правом <b>Contents: Read and write</b> для одного репозитория (см. README, шаг 3).
      </p>
      <div className="field"><label>Владелец репозитория (username или org)</label><input value={owner} onChange={(e) => setOwner(e.target.value)} autoCapitalize="none" /></div>
      <div className="field"><label>Название репозитория</label><input value={repo} onChange={(e) => setRepo(e.target.value)} autoCapitalize="none" /></div>
      <div className="field"><label>Ветка</label><input value={branch} onChange={(e) => setBranch(e.target.value)} autoCapitalize="none" /></div>
      <div className="field"><label>GitHub-токен (github_pat_…)</label><input value={token} onChange={(e) => setToken(e.target.value)} autoCapitalize="none" autoCorrect="off" type="password" /></div>
      <button disabled={!owner || !repo || !token || !open} style={{ width: "100%" }} onClick={() => onSave({ owner: owner.trim(), repo: repo.trim(), token: token.trim(), branch: branch.trim() || "main" })}>
        Сохранить и загрузить
      </button>
    </div>
  );
}

/* ---- Лист настроек ---- */
function SettingsSheet({ open, onClose, cfg, onSave, onRefresh, onPush, vapid, isIos }: {
  open: boolean; onClose: () => void; cfg: LocalCfg | null; onSave: (c: LocalCfg) => void; onRefresh: () => void; onPush: () => void; vapid: string; isIos: boolean;
}) {
  const [owner, setOwner] = useState(cfg?.owner ?? "");
  const [repo, setRepo] = useState(cfg?.repo ?? "");
  const [token, setToken] = useState(cfg?.token ?? "");
  const [branch, setBranch] = useState(cfg?.branch ?? "main");
  const [tokenCheck, setTokenCheck] = useState("");
  useEffect(() => { if (open && cfg) { setOwner(cfg.owner); setRepo(cfg.repo); setToken(cfg.token); setBranch(cfg.branch); setTokenCheck(""); } }, [open, cfg]);

  const testToken = async () => {
    setTokenCheck("Проверяю…");
    try {
      const login = await checkToken({ owner: owner.trim(), repo: repo.trim(), token: token.trim(), branch: branch.trim() || "main" });
      setTokenCheck(`✅ Токен работает (${login})`);
    } catch (e: any) {
      setTokenCheck(`❌ ${e?.message ?? "Ошибка проверки токена"}`);
    }
  };
  return (
    <>
      {open && <div className="overlay show" onClick={onClose} />}
      <div className={`sheet${open ? " show" : ""}`}>
        <div className="grab" />
        <div className="inner">
          <div className="sheettitle"><span className="t">⚙️ Настройки</span><button className="ghost small" onClick={onClose}>Готово</button></div>

          {isIos && (
            <div className="bnr" style={{ marginBottom: 14 }}>
              <b>iPhone:</b> добавьте приложение на экран «Домой» (Safari → «Поделиться» → «На экран Домой»). Только установленное PWA умеет показывать push-уведомления и бейдж иконки.
            </div>
          )}

          <div className="row2">
            <div className="field"><label>Владелец репо</label><input value={owner} onChange={(e) => setOwner(e.target.value)} autoCapitalize="none" /></div>
            <div className="field"><label>Репозиторий</label><input value={repo} onChange={(e) => setRepo(e.target.value)} autoCapitalize="none" /></div>
          </div>
          <div className="field"><label>Ветка</label><input value={branch} onChange={(e) => setBranch(e.target.value)} autoCapitalize="none" /></div>
          <div className="field"><label>GitHub-токен (Contents: Read and write)</label><input value={token} onChange={(e) => setToken(e.target.value)} type="password" autoCapitalize="none" autoCorrect="off" /></div>
          <div className="sub" style={{ marginTop: -4, marginBottom: 8 }}>
            Токен нужен для добавления и изменения товаров. Чтение публичного репозитория работает и без него.
          </div>
          <button className="ghost" style={{ width: "100%" }} disabled={!token} onClick={testToken}>Проверить токен</button>
          {tokenCheck && <div className="sub" style={{ marginTop: 6 }}>{tokenCheck}</div>}
          <div style={{ height: 8 }} />
          <button style={{ width: "100%" }} onClick={() => onSave({ owner: owner.trim(), repo: repo.trim(), token: token.trim(), branch: branch.trim() || "main" })}>Сохранить конфигурацию</button>

          <div style={{ height: 12 }} />
          <button className="ghost" style={{ width: "100%" }} onClick={onRefresh}>🔄 Обновить цены из репозитория</button>
          <div style={{ height: 12 }} />
          <button style={{ width: "100%" }} onClick={onPush}>{vapid ? "🔔 Включить push-уведомления" : "🔔 Push: ключ не задан (README)"}</button>
          <a className="linkrow" href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">Создать GitHub-токен ↗</a>
        </div>
      </div>
    </>
  );
}
