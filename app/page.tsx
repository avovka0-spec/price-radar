"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Chart, { fmt } from "@/components/Chart";
import { parseProductLink, wbImageUrl, fetchWbCard, extractProductName } from "@/lib/wb";
import type { Product, History, PushSub, AppConfig } from "@/lib/types";
import { GhConfig, readRepoJson, writeRepoJson, updateRepoJson, checkToken } from "@/lib/github";
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
  const pullStartYRef = useRef(0);
  const pullStartXRef = useRef(0);
  const pullingRef = useRef(false);
  const pullYRef = useRef(0);
  useEffect(() => {
    const onStart = (e: TouchEvent) => {
      if (window.scrollY <= 2 && e.touches.length === 1) {
        pullStartYRef.current = e.touches[0].clientY;
        pullStartXRef.current = e.touches[0].clientX;
        pullingRef.current = true;
      }
    };
    const onMove = (e: TouchEvent) => {
      if (!pullingRef.current) return;
      const dy = e.touches[0].clientY - pullStartYRef.current;
      const dx = e.touches[0].clientX - pullStartXRef.current;
      // Горизонтальный жест — не перехватывать (свайп для удаления)
      if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 8) {
        pullingRef.current = false;
        pullYRef.current = 0;
        setPullY(0);
        return;
      }
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

  // Дебаунс коммитов настроек товара: onChange обновляет UI сразу, в GitHub пишем раз в паузу,
  // чтобы не плодить параллельные PUT по products.json (это давало конфликт SHA при удалении).
  const patchCommitRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingProductsRef = useRef<Product[] | null>(null);
  const flushPatchCommit = useCallback(async () => {
    if (patchCommitRef.current) { clearTimeout(patchCommitRef.current); patchCommitRef.current = null; }
    const next = pendingProductsRef.current;
    pendingProductsRef.current = null;
    if (!next || !cfg) return;
    try {
      await updateRepoJson<Product[]>(cfg, "public/data/products.json", "Настройки товаров", (cur) => {
        const fresh = Array.isArray(cur) ? cur : (cur as any)?.products ?? next;
        // Применяем локальные правки настроек поверх свежих данных, чтобы не потерять
        // параллельные обновления цен. ВАЖНО: не добавляем товары из локального снапшота,
        // которых нет в свежих данных репозитория — иначе можно «воскресить» товар,
        // удалённый пользователем (удаление идёт отдельным коммитом/очередью).
        const localBySku = new Map(next.map((p) => [p.sku, p]));
        return fresh.map((p: Product) => {
          const l = localBySku.get(p.sku);
          return l ? { ...p, targetPrice: l.targetPrice, thresholdPct: l.thresholdPct, notify: l.notify } : p;
        });
      });
    } catch { /* тихо: не мешаем UX, при следующем изменении повторим */ }
  }, [cfg]);
  useEffect(() => { if (detail === null) void flushPatchCommit(); }, [detail, flushPatchCommit]);

  // Очередь постепенного удаления: быстрые параллельные операции по GitHub Contents API
  // дают конфликты SHA/таймауты, поэтому удаляем товары последовательно с паузами.
  const deleteQueueRef = useRef<{ sku: string }[]>([]);
  const deleteBusyRef = useRef(false);
  const cfgRef = useRef<LocalCfg | null>(null);
  const loadRepoRef = useRef(loadRepo);
  const showRef = useRef(show);
  useEffect(() => { cfgRef.current = cfg; }, [cfg]);
  useEffect(() => { loadRepoRef.current = loadRepo; }, [loadRepo]);
  useEffect(() => { showRef.current = show; }, [show]);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const processDeleteQueue = useCallback(async () => {
    if (deleteBusyRef.current) return;
    deleteBusyRef.current = true;
    try {
      while (deleteQueueRef.current.length) {
        const job = deleteQueueRef.current.shift();
        if (!job) break;
        const c = cfgRef.current;
        if (!c) continue;
        const sku = job.sku;
        try {
          await updateRepoJson<{ products?: Product[] } | Product[]>(c, "public/data/products.json", `Удалён ${sku}`, (cur) => {
            const list = Array.isArray(cur) ? cur : cur?.products ?? [];
            return list.filter((p) => p.sku !== sku);
          });
          await sleep(500);
          await updateRepoJson<History>(c, "public/data/history.json", `История: удалён ${sku}`, (cur) => {
            const h = { ...(cur ?? {}) };
            delete h[sku];
            return h;
          });
          showRef.current(deleteQueueRef.current.length ? `Удалено: ${sku} (в очереди: ${deleteQueueRef.current.length})` : "Удалено");
        } catch (err: any) {
          const msg = err?.message ? String(err.message) : "ошибка записи";
          showRef.current(`Не сохранено в GitHub: ${msg.slice(0, 140)}`);
          await loadRepoRef.current(c, false).catch(() => {});
        }
        if (deleteQueueRef.current.length) await sleep(700);
      }
    } finally {
      deleteBusyRef.current = false;
      if (deleteQueueRef.current.length) void processDeleteQueue();
    }
  }, []);

  // --- добавление товара ---
  const addProduct = async (overrideUrl?: string) => {
    setAddErr("");
    if (!cfg && !demo) return setShowOnboard(true);
    await flushPatchCommit();
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
      // Ozon/Яндекс Маркет/AliExpress: имя из slug/ссылки; если нет — пробуем вытащить из текста (share/промо)
      if (!name || /^(Товар (Ozon|AliExpress|Яндекс Маркета)|[-—])$/i.test(name)) {
        const inferred = extractProductName(input);
        if (inferred) name = inferred;
      }
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
      const point = currentPrice ? { t: Date.now(), p: currentPrice } : null;
      const his = { ...history, [parsed.sku]: point ? [...(history[parsed.sku] ?? []), point] : (history[parsed.sku] ?? []) };
      setHistory(his);
      if (cfg) {
        await updateRepoJson<{ products?: Product[] } | Product[]>(cfg, "public/data/products.json", `Добавлен ${parsed.marketplace.toUpperCase()} ${parsed.sku}`, (cur) => {
          const list = Array.isArray(cur) ? cur : cur?.products ?? [];
          return list.some((p) => p.sku === parsed.sku) ? list : [...list, created];
        });
        await updateRepoJson<History>(cfg, "public/data/history.json", `История: ${parsed.sku}`, (cur) => {
          const base = { ...(cur ?? {}) };
          const arr = [...(base[parsed.sku] ?? [])];
          if (point && !arr.some((x) => x.p === point.p && Math.abs(x.t - point.t) < 5000)) arr.push(point);
          base[parsed.sku] = arr;
          return base;
        });
      }
      show(parsed.marketplace === "wb" && currentPrice ? "Добавлено, цена получена" : "Добавлено. Цену уточним при следующей проверке (или введите вручную)");
    } catch (e: any) {
      setAddErr(`Не удалось закоммитить в репо: ${e?.message}. Проверьте токен/ветку в настройках.`);
      if (cfg) await loadRepo(cfg, false).catch(() => {});
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
    setProducts(next);
    if (cfg) {
      pendingProductsRef.current = next;
      if (patchCommitRef.current) clearTimeout(patchCommitRef.current);
      patchCommitRef.current = setTimeout(() => { void flushPatchCommit(); }, 900);
    }
  };

  const toggleFavorite = (sku: string) => {
    const p = products.find((x) => x.sku === sku);
    if (!p) return;
    patch(sku, { favorite: !p.favorite });
    setRevealedSku(null);
    show(p.favorite ? "Убрано из отложенных" : "В отложенные");
  };

  const remove = (sku: string) => {
    // Отменяем отложенный коммит настроек и убираем удаляемый товар из pending-патча,
    // иначе дебаунс может перезаписать products.json после удаления.
    if (patchCommitRef.current) { clearTimeout(patchCommitRef.current); patchCommitRef.current = null; }
    if (pendingProductsRef.current) pendingProductsRef.current = pendingProductsRef.current.filter((p) => p.sku !== sku);

    setProducts((prev) => prev.filter((p) => p.sku !== sku));
    setHistory((prev) => {
      const h = { ...prev };
      delete h[sku];
      return h;
    });
    setDetail(null);
    setRevealedSku(null);

    if (cfgRef.current || cfg) {
      if (!deleteQueueRef.current.some((j) => j.sku === sku)) deleteQueueRef.current.push({ sku });
      if (deleteQueueRef.current.length > 1) show(`В очереди удаления: ${deleteQueueRef.current.length}`);
      void processDeleteQueue();
    } else {
      show("Удалено");
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
  const [revealedSku, setRevealedSku] = useState<string | null>(null);
  const [tab, setTab] = useState<"cart" | "search" | "favorites" | "settings">("cart");
  const [armedDelete, setArmedDelete] = useState(false);
  const [manualVal, setManualVal] = useState("");
  useEffect(() => { setArmedDelete(false); setManualVal(""); }, [detail]);

  // Свайп вниз по «ползунку»/шапке для сворачивания bottom-sheet.
  const detailSheetRef = useRef<HTMLDivElement | null>(null);
  const settingsSheetRef = useRef<HTMLDivElement | null>(null);
  const sheetDrag = useRef<{ y: number; t: number; active: boolean; moved: boolean }>({ y: 0, t: 0, active: false, moved: false });
  const bindSheetDrag = (ref: React.MutableRefObject<HTMLDivElement | null>, onClose: () => void) => ({
    onTouchStart: (e: React.TouchEvent) => {
      const el = ref.current;
      if (!el) return;
      sheetDrag.current = { y: e.touches[0].clientY, t: Date.now(), active: true, moved: false };
      el.style.transition = "none";
    },
    onTouchMove: (e: React.TouchEvent) => {
      const el = ref.current;
      if (!el || !sheetDrag.current.active) return;
      const dy = e.touches[0].clientY - sheetDrag.current.y;
      if (dy <= 0) {
        el.style.transform = "translateY(0px)";
        return;
      }
      sheetDrag.current.moved = true;
      el.style.transform = `translateY(${dy}px)`;
      e.preventDefault();
    },
    onTouchEnd: (e: React.TouchEvent) => {
      const el = ref.current;
      if (!el || !sheetDrag.current.active) return;
      const dy = Math.max(0, e.changedTouches[0].clientY - sheetDrag.current.y);
      const dt = Math.max(1, Date.now() - sheetDrag.current.t);
      const velocity = dy / dt;
      sheetDrag.current.active = false;
      el.style.transition = "";
      if (dy > 90 || (dy > 35 && velocity > 0.45)) {
        el.style.transform = "";
        onClose();
      } else {
        el.style.transform = "";
      }
    },
    onTouchCancel: () => {
      const el = ref.current;
      sheetDrag.current.active = false;
      if (el) { el.style.transition = ""; el.style.transform = ""; }
    },
  });
  const touchStartX = useRef(0);
  const touchStartY = useRef(0);
  const addManualPoint = async () => {
    if (!dProduct) return;
    const price = Number(manualVal.replace(",", "."));
    if (!price || price <= 0) return show("Введите цену числом, например 4990");
    const pts = [...(history[dProduct.sku] ?? [])];
    const last = pts[pts.length - 1];
    if (last?.p === price && Date.now() - last.t < 6 * 3600e3) return show("Такая точка уже есть за последние 6 часов");
    const point = { t: Date.now(), p: price, m: 1 as const };
    pts.push(point);
    setHistory({ ...history, [dProduct.sku]: pts });
    setManualVal("");
    if (cfg) {
      try {
        await updateRepoJson<History>(cfg, "public/data/history.json", `История: ручная точка ${dProduct.sku}`, (cur) => {
          const base = { ...(cur ?? {}) };
          const arr = [...(base[dProduct.sku] ?? [])];
          if (!arr.some((x) => x.p === point.p && Math.abs(x.t - point.t) < 5000)) arr.push(point);
          base[dProduct.sku] = arr;
          return base;
        });
        show("Цена добавлена в график, попадёт в историю при следующей синхронизации");
      } catch (e: any) {
        show(`Точка сохранена локально, но коммит не удался: ${e?.message}`);
        await loadRepo(cfg, false).catch(() => {});
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

  const listForTab = (t: typeof tab) => (t === "favorites" ? products.filter((p) => p.favorite) : products);

  const renderList = (items: Product[], emptyText: string) => (
    <>
      {items.length === 0 && <div className="empty">{emptyText}</div>}
      {items.map((p) => {
        const hist = history[p.sku] ?? [];
        const autos = hist.filter((x) => !x.m);
        const prev = autos.length > 1 ? autos[autos.length - 2].p : p.currentPrice;
        const delta = p.currentPrice && prev ? ((p.currentPrice - prev) / prev) * 100 : null;
        const s = stats(p.sku);
        const revealed = revealedSku === p.sku;
        return (
          <div className={`swipe-wrap${revealed ? " revealed" : ""}`} key={p.sku}>
            <div className="swipe-actions" aria-hidden={!revealed}>
              <button className="act-fav" aria-label={p.favorite ? "Убрать из отложенных" : "В отложенные"} onClick={(e) => { e.stopPropagation(); toggleFavorite(p.sku); }}>{p.favorite ? "♥" : "♡"}</button>
              <button className="act-del" aria-label="Удалить" onClick={(e) => { e.stopPropagation(); remove(p.sku); }}>🗑</button>
            </div>
            <div
              className="swipe-content"
              onTouchStart={(e) => { touchStartX.current = e.touches[0].clientX; touchStartY.current = e.touches[0].clientY; }}
              onTouchEnd={(e) => {
                const dx = e.changedTouches[0].clientX - touchStartX.current;
                const dy = e.changedTouches[0].clientY - touchStartY.current;
                if (Math.abs(dx) > Math.abs(dy) * 1.2) {
                  if (dx < -55) setRevealedSku(p.sku);
                  else if (dx > 40) setRevealedSku(null);
                }
              }}
              onClick={() => { if (revealed) setRevealedSku(null); else setDetail(p.sku); }}
            >
              <div className="pcard">
                {p.image ? <img src={p.image} alt="" onError={(e) => ((e.target as HTMLImageElement).style.visibility = "hidden")} /> : <div style={{ width: 56 }} />}
                <div className="pinfo">
                  <div className="pname">{p.name}{p.favorite ? <span className="fav-star">★</span> : null}</div>
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
          </div>
        );
      })}
    </>
  );

  return (
    <>
      <main className="wrap has-tabs" onClick={() => { if (revealedSku) setRevealedSku(null); }}>
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

        {demo && (
          <div className="bnr">
            <b>Демо-режим</b> — синтетические данные. Настройте GitHub во вкладке «Настройки».
          </div>
        )}
        {cfgLoadErr && <div className="err">{cfgLoadErr}</div>}

        {tab === "cart" && (
          <>
            <p className="sub">Отслеживание цен · свайп влево — избранное/удалить</p>
            {renderList(products, "Пока пусто. Добавьте товар во вкладке «Поиск».")}
          </>
        )}

        {tab === "search" && (
          <>
            <p className="sub">Добавить товар по ссылке или артикулу</p>
            <div className="addrow">
              <input value={link} onChange={(e) => setLink(e.target.value)} placeholder="Ссылка WB/Ozon/ЯМ/AliExpress (в т.ч. ali.click) или артикул"
                inputMode="url" autoCapitalize="none" autoCorrect="off" onKeyDown={(e) => e.key === "Enter" && addProduct()} />
              <button onClick={() => addProduct()}>＋</button>
            </div>
            {addErr && <div className="err">{addErr}</div>}
            <div className="sub" style={{ marginTop: 8 }}>Можно вставить текст «Поделиться» целиком — название попробуем извлечь автоматически. После добавления товар появится в «Корзине».</div>
            {products.length > 0 && <div className="card" style={{ padding: 12, marginTop: 12 }}><div className="pbrand">Отслеживается товаров: <b>{products.length}</b> · отложено: <b>{products.filter(p=>p.favorite).length}</b></div></div>}
          </>
        )}

        {tab === "favorites" && (
          <>
            <p className="sub">Отложенные товары</p>
            {renderList(products.filter((p) => p.favorite), "Нет отложенных. Смахните товар влево в «Корзине» и нажмите «В избранное».")}
          </>
        )}

        {tab === "settings" && (
          <>
            <p className="sub">Репозиторий, токен, уведомления</p>
            <SettingsTabView
              cfg={cfg}
              isIos={isIos}
              vapid={vapid}
              onSave={(c) => saveCfg(c)}
              onRefresh={() => cfg && loadRepo(cfg, true)}
              onPush={enablePush}
            />
          </>
        )}

        {/* ---------- Детальная карточка ---------- */}
        {dProduct && (
          <>
            <div className="overlay show" onClick={() => setDetail(null)} />
            <div className="sheet show" ref={detailSheetRef}>
              <div style={{ padding: "8px 0 2px", touchAction: "none", cursor: "grab" }} aria-label="Свернуть карточку свайпом вниз" {...bindSheetDrag(detailSheetRef, () => setDetail(null))}>
                <div className="grab" />
              </div>
              <div className="inner">
                <div className="sheettitle" style={{ touchAction: "none" }} {...bindSheetDrag(detailSheetRef, () => setDetail(null))}>
                  <span className="t">
                    {dProduct.marketplace === "wb" && <span className="mpbadge wb" style={{ marginRight: 6, verticalAlign: "middle" }}>WB</span>}
                    {dProduct.marketplace === "ozon" && <span className="mpbadge ozon" style={{ marginRight: 6, verticalAlign: "middle" }}>Ozon</span>}
                    {dProduct.marketplace === "ym" && <span className="mpbadge ym" style={{ marginRight: 6, verticalAlign: "middle" }}>ЯМ</span>}
                    {dProduct.marketplace === "ali" && <span className="mpbadge ali" style={{ marginRight: 6, verticalAlign: "middle" }}>Ali</span>}
                    {dProduct.brand && <b>{dProduct.brand} · </b>}{dProduct.name}{dProduct.favorite ? <span className="fav-star"> ★</span> : null}
                  </span>
                  <button className="ghost small" onClick={(e) => { e.stopPropagation(); setDetail(null); }}>Готово</button>
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
                <button className="ghost" style={{ width: "100%", marginBottom: 8 }} onClick={() => toggleFavorite(dProduct.sku)}>{dProduct.favorite ? "★ Убрать из отложенных" : "☆ В избранное (отложенные)"}</button>
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

        {toast && <div className="toast">{toast}</div>}
      </main>

      <nav className="tabbar" aria-label="Навигация">
        <button className={tab === "cart" ? "active" : ""} onClick={() => setTab("cart")}><span className="ico">🛒</span>Корзина</button>
        <button className={tab === "search" ? "active" : ""} onClick={() => setTab("search")}><span className="ico">🔍</span>Поиск</button>
        <button className={tab === "favorites" ? "active" : ""} onClick={() => setTab("favorites")}><span className="ico">♡</span>Отложенные</button>
        <button className={tab === "settings" ? "active" : ""} onClick={() => setTab("settings")}><span className="ico">⚙️</span>Настройки</button>
      </nav>
    </>
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

/* ---- Настройки (вкладка) ---- */
type Theme = "light" | "dark" | "pink";
const THEME_KEY = "pradar.theme";
function applyTheme(t: Theme) {
  try { localStorage.setItem(THEME_KEY, t); } catch {}
  document.documentElement.dataset.theme = t;
}

function SettingsTabView({ cfg, onSave, onRefresh, onPush, vapid, isIos }: {
  cfg: LocalCfg | null; onSave: (c: LocalCfg) => void; onRefresh: () => void; onPush: () => void; vapid: string; isIos: boolean;
}) {
  const [view, setView] = useState<"main" | "repo">("main");
  const [owner, setOwner] = useState(cfg?.owner ?? "");
  const [repo, setRepo] = useState(cfg?.repo ?? "");
  const [token, setToken] = useState(cfg?.token ?? "");
  const [branch, setBranch] = useState(cfg?.branch ?? "main");
  const [tokenCheck, setTokenCheck] = useState("");
  const [theme, setTheme] = useState<Theme>(() => {
    try { const t = localStorage.getItem(THEME_KEY) as Theme; if (t === "light" || t === "dark" || t === "pink") return t; } catch {}
    return "light";
  });
  useEffect(() => { if (cfg) { setOwner(cfg.owner); setRepo(cfg.repo); setToken(cfg.token); setBranch(cfg.branch); } }, [cfg]);
  useEffect(() => { applyTheme(theme); }, [theme]);

  const testToken = async () => {
    setTokenCheck("Проверяю…");
    try {
      const login = await checkToken({ owner: owner.trim(), repo: repo.trim(), token: token.trim(), branch: branch.trim() || "main" });
      setTokenCheck(`✅ Токен работает (${login})`);
    } catch (e: any) {
      setTokenCheck(`❌ ${e?.message ?? "Ошибка проверки токена"}`);
    }
  };

  if (view === "repo") {
    return (
      <div className="card" style={{ padding: 16 }}>
        <button className="ghost small" onClick={() => setView("main")} style={{ marginBottom: 10 }}>← Настройки</button>
        <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 12 }}>Репозиторий и GitHub</div>
        <div className="row2">
          <div className="field"><label>Владелец репо</label><input value={owner} onChange={(e) => setOwner(e.target.value)} autoCapitalize="none" /></div>
          <div className="field"><label>Репозиторий</label><input value={repo} onChange={(e) => setRepo(e.target.value)} autoCapitalize="none" /></div>
        </div>
        <div className="field"><label>Ветка</label><input value={branch} onChange={(e) => setBranch(e.target.value)} autoCapitalize="none" /></div>
        <div className="field"><label>GitHub-токен (Contents: Read and write)</label><input value={token} onChange={(e) => setToken(e.target.value)} type="password" autoCapitalize="none" autoCorrect="off" /></div>
        <div className="sub" style={{ marginTop: -4, marginBottom: 8 }}>Токен нужен для добавления/изменения/удаления товаров. Чтение публичного репозитория работает и без него.</div>
        <button className="ghost" style={{ width: "100%" }} disabled={!token} onClick={testToken}>Проверить токен</button>
        {tokenCheck && <div className="sub" style={{ marginTop: 6 }}>{tokenCheck}</div>}
        <div style={{ height: 8 }} />
        <button style={{ width: "100%" }} onClick={() => onSave({ owner: owner.trim(), repo: repo.trim(), token: token.trim(), branch: branch.trim() || "main" })}>Сохранить конфигурацию</button>
        <div style={{ height: 12 }} />
        <button className="ghost" style={{ width: "100%" }} onClick={onRefresh}>🔄 Обновить цены из репозитория</button>
        <a className="linkrow" href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">Создать GitHub-токен ↗</a>
      </div>
    );
  }

  return (
    <div className="card" style={{ padding: 16 }}>
      {isIos && (
        <div className="bnr" style={{ marginBottom: 14 }}>
          <b>iPhone:</b> для push установите PWA на экран «Домой» (Safari → «Поделиться» → «На экран Домой»).
        </div>
      )}
      <div style={{ fontSize: 13, color: "var(--text2)", marginBottom: 6, textTransform: "uppercase", letterSpacing: ".4px" }}>Оформление</div>
      <div className="theme-row">
        <button className={theme === "light" ? "active" : ""} onClick={() => setTheme("light")}>Светлая</button>
        <button className={theme === "dark" ? "active" : ""} onClick={() => setTheme("dark")}>Тёмная</button>
        <button className={theme === "pink" ? "active" : ""} onClick={() => setTheme("pink")}>Розовая</button>
      </div>
      <button className="ghost" style={{ width: "100%", marginBottom: 12 }} onClick={() => setView("repo")}>📦 Repo / GitHub</button>
      <button style={{ width: "100%" }} onClick={onPush}>{vapid ? "🔔 Включить push-уведомления" : "🔔 Push: ключ не задан (README)"}</button>
    </div>
  );
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
  useEffect(() => { if (open && sheetRef.current) sheetRef.current.style.transform = ""; }, [open]);

  const testToken = async () => {
    setTokenCheck("Проверяю…");
    try {
      const login = await checkToken({ owner: owner.trim(), repo: repo.trim(), token: token.trim(), branch: branch.trim() || "main" });
      setTokenCheck(`✅ Токен работает (${login})`);
    } catch (e: any) {
      setTokenCheck(`❌ ${e?.message ?? "Ошибка проверки токена"}`);
    }
  };
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ y: number; t: number; active: boolean }>({ y: 0, t: 0, active: false });
  const dragBind = {
    onTouchStart: (e: React.TouchEvent) => {
      const el = sheetRef.current; if (!el) return;
      drag.current = { y: e.touches[0].clientY, t: Date.now(), active: true };
      el.style.transition = "none";
    },
    onTouchMove: (e: React.TouchEvent) => {
      const el = sheetRef.current; if (!el || !drag.current.active) return;
      const dy = e.touches[0].clientY - drag.current.y;
      if (dy <= 0) { el.style.transform = "translateY(0px)"; return; }
      el.style.transform = `translateY(${dy}px)`;
      e.preventDefault();
    },
    onTouchEnd: (e: React.TouchEvent) => {
      const el = sheetRef.current; if (!el || !drag.current.active) return;
      const dy = Math.max(0, e.changedTouches[0].clientY - drag.current.y);
      const dt = Math.max(1, Date.now() - drag.current.t);
      drag.current.active = false;
      el.style.transition = "";
      if (dy > 90 || (dy > 35 && dy / dt > 0.45)) { el.style.transform = ""; onClose(); }
      else el.style.transform = "";
    },
    onTouchCancel: () => { const el = sheetRef.current; drag.current.active = false; if (el) { el.style.transition = ""; el.style.transform = ""; } },
  };

  return (
    <>
      {open && <div className="overlay show" onClick={onClose} />}
      <div className={`sheet${open ? " show" : ""}`} ref={sheetRef}>
        <div style={{ padding: "8px 0 2px", touchAction: "none", cursor: "grab" }} aria-label="Свернуть настройки свайпом вниз" {...dragBind}>
          <div className="grab" />
        </div>
        <div className="inner">
          <div className="sheettitle" style={{ touchAction: "none" }} {...dragBind}>
            <span className="t">⚙️ Настройки</span>
            <button className="ghost small" onClick={(e) => { e.stopPropagation(); onClose(); }}>Готово</button>
          </div>

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
