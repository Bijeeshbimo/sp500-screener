/* Screener tab, its filter sheet, and the stock detail page (chart, checklist, your position). */
"use strict";

const activeFilterCount = m => {
  const f = filters(m), d = defaultFilters(m), all = ((MD[m] && MD[m].meta.indices) || []).length;
  let n = 0;
  for (const k of ["adv", "px", "cap"]) if (+f[k] !== +d[k]) n++;
  for (const k of ["rmin", "rmax", "ext", "rv", "rs"]) if (f[k] !== "" && f[k] != null) n++;
  if (f.idx.length < all) n++;
  return n;
};

function scanList() {
  const d = MD[M], f = filters(M), sc = screened(M);
  if (sc.bad) return `<div class="card empty"><b>Lookback too short</b>Use at least ${d.meta.minLookback} sessions.</div>`;
  if (!sc.list.length) return emptyBox("🔍", "No stocks match", `Nothing broke out above its ${f.N}-session high with these filters. Try a shorter lookback or relax the liquidity filter.`, `<button class="btn sm brand" data-act="filters">Change filters</button>`);
  const more = sc.matched > sc.list.length;
  return `<div class="card flush">${sc.list.map(k => stockRow(k, M)).join("")}</div>` +
    (more ? `<button class="btn ghost block" data-act="showmore" style="margin-top:12px">Show 20 more (${sc.matched - sc.list.length} left)</button>` : "");
}

Views.scan = function () {
  const d = MD[M];
  if (!d) return notices() + skeletons(6);
  const f = filters(M), sc = screened(M), n = activeFilterCount(M);
  const chips = SC.PRESETS.map(p => `<button class="chip" aria-pressed="${f.N === p}" data-act="setN" data-v="${p}">${p}</button>`).join("") +
    (SC.PRESETS.includes(f.N) ? "" : `<button class="chip" aria-pressed="true" data-act="filters">${esc(f.N)}</button>`) + `<button class="chip" data-act="filters">Custom</button>`;
  return notices() + `<div style="display:flex;gap:10px">
      <label class="fld" style="flex:1"><input data-in="q" type="search" placeholder="Search symbol or name" value="${esc(f.q)}" autocomplete="off" style="height:44px"></label>
      <button class="ibtn" data-act="filters" aria-label="Filters" style="width:44px;height:44px">${icon("filter")}${n ? `<span class="dot"></span>` : ""}</button></div>
    <div><div class="mut" style="font-size:12px;font-weight:600;margin-bottom:6px">Breakout above the previous ___ session high</div><div class="chips">${chips}</div></div>
    <div class="sortbar"><span id="scan-count">${sc.matched.toLocaleString()} match${sc.matched === 1 ? "" : "es"} · ${esc(d.meta.date)} close${n ? ` · ${n} filter${n > 1 ? "s" : ""} on` : ""}</span>
      <span style="display:flex;gap:6px;align-items:center"><select data-in="sort" aria-label="Sort by">${SC.SORTS.map(s => `<option value="${s.k}"${f.sort === s.k ? " selected" : ""}>${s.t}</option>`).join("")}</select>
      <button class="ibtn" data-act="toggleasc" aria-label="Reverse order" style="width:34px;height:34px;border-radius:10px">${f.asc ? "↑" : "↓"}</button></span></div>
    <div id="scan-list">${scanList()}</div>
    <div class="card note">Bars show the 1-month return, one per session (green above where it was a month ago, red below). Dots count positive / caution / warning checks. Tap a stock for its chart and checklist.</div>`;
};

document.addEventListener("input", e => {
  const el = e.target.closest("[data-in]"); if (!el || TAB !== "scan") return;
  const f = filters(M);
  if (el.dataset.in === "q") { f.q = el.value; saveFilters(); $("#scan-list").innerHTML = scanList(); $("#scan-count").textContent = screened(M).matched.toLocaleString() + " matches"; Charts.bind($("#scan-list")); }
});
document.addEventListener("change", e => {
  const el = e.target.closest("[data-in]"); if (!el || TAB !== "scan") return;
  if (el.dataset.in === "sort") { const f = filters(M); f.sort = el.value; f.asc = el.value === "sym"; saveFilters(); render(); }
});
ACT.setN = el => { const f = filters(M); f.N = +el.dataset.v; saveFilters(); render(); refreshLayers(); };
ACT.toggleasc = () => { const f = filters(M); f.asc = !f.asc; saveFilters(); render(); };
ACT.showmore = () => { const f = filters(M); f.top = (f.top || 0) + 20; saveFilters(); $("#scan-list").innerHTML = scanList(); };

/* ------------------------------------------------------------ filter sheet -- */
ACT.filters = () => {
  const d = MD[M]; if (!d) return toast("Data is still loading");
  const cfg = d.meta.cfg, f = filters(M);
  const L = openSheet(`${sheetHead("Screener filters", esc(cfg.name))}<form id="ff" class="sheet-in g1" novalidate>
    <label class="fld"><span>Lookback (sessions, minimum ${d.meta.minLookback})</span><input name="N" type="number" inputmode="numeric" value="${esc(f.N)}"></label>
    <div class="g2"><label class="fld"><span>${esc(cfg.advLabel)}</span><input name="adv" type="number" step="any" inputmode="decimal" value="${esc(f.adv)}"></label>
      <label class="fld"><span>${esc(cfg.pxLabel)}</span><input name="px" type="number" step="any" inputmode="decimal" value="${esc(f.px)}"></label></div>
    <label class="fld"><span>Max one-day move (%), filters out data glitches. Blank = no cap</span><input name="cap" type="number" step="any" inputmode="decimal" value="${esc(f.cap)}"></label>
    <div class="grp">Entry quality (optional)</div>
    <div class="g2"><label class="fld"><span>RSI(14) at least</span><input name="rmin" type="number" step="any" inputmode="decimal" value="${esc(f.rmin)}"></label>
      <label class="fld"><span>RSI(14) at most</span><input name="rmax" type="number" step="any" inputmode="decimal" value="${esc(f.rmax)}"></label>
      <label class="fld"><span>Max % above 20 EMA</span><input name="ext" type="number" step="any" inputmode="decimal" value="${esc(f.ext)}"></label>
      <label class="fld"><span>Min relative volume (×)</span><input name="rv" type="number" step="any" inputmode="decimal" value="${esc(f.rv)}"></label>
      <label class="fld"><span>Min RS rank (0–99)</span><input name="rs" type="number" step="any" inputmode="decimal" value="${esc(f.rs)}"></label>
      <label class="fld"><span>Show top</span><select name="top">${[10, 20, 50, 100, 0].map(v => `<option value="${v}"${+f.top === v ? " selected" : ""}>${v || "All"}</option>`).join("")}</select></label></div>
    <div class="grp">Indices</div>
    <div class="chipwrap">${d.meta.indices.map(i => `<button type="button" class="chip wrap" aria-pressed="${f.idx.includes(i.code)}" data-act="toggleidx" data-v="${esc(i.code)}">${esc(i.label)}</button>`).join("")}</div>
    <div class="err" role="alert"></div></form>
    <div class="sheet-ft btnrow"><button class="btn ghost" data-act="resetfilters">Reset</button><button class="btn brand" data-act="applyfilters">Apply</button></div>`);
  L.idx = new Set(f.idx);
};
ACT.toggleidx = el => {
  const L = topLayer(), v = el.dataset.v; if (!L.idx) return;
  if (L.idx.has(v)) L.idx.delete(v); else L.idx.add(v);
  el.setAttribute("aria-pressed", L.idx.has(v));
};
ACT.resetfilters = () => { const keep = filters(M).q; FL[M] = Object.assign(defaultFilters(M), { q: keep }); saveFilters(); closeTop(); render(); refreshLayers(); toast("Filters reset"); };
ACT.applyfilters = () => {
  const L = topLayer(), f = $("#ff", L.el), cur = filters(M), d = MD[M];
  const N = parseInt(val(f, "N"), 10);
  if (!(N >= d.meta.minLookback)) return errBox(f, `Enter a lookback of at least ${d.meta.minLookback} sessions.`);
  if (!L.idx.size) return errBox(f, "Pick at least one index.");
  const keep = k => (val(f, k) === "" ? "" : +val(f, k));
  Object.assign(cur, { N, adv: keep("adv") === "" ? 0 : keep("adv"), px: keep("px") === "" ? 0 : keep("px"), cap: keep("cap"), rmin: keep("rmin"), rmax: keep("rmax"), ext: keep("ext"), rv: keep("rv"), rs: keep("rs"), top: +val(f, "top"), idx: [...L.idx] });
  saveFilters(); closeTop(); render(); refreshLayers();
};

/* ------------------------------------------------------------ stock detail -- */
function storedCandles(yf, K) {
  const c = CANDLES[yf]; if (!c || !c.d || c.d.length < 2) return null;
  const ema = n => { const k = 2 / (n + 1); let e = c.c[0]; return c.c.map(v => (e = v * k + e * (1 - k))); };
  const e1 = ema(20), e2 = ema(50), s = Math.max(0, c.d.length - (K || 126));
  return { o: c.o.slice(s), h: c.h.slice(s), l: c.l.slice(s), c: c.c.slice(s), e1: e1.slice(s), e2: e2.slice(s), dates: c.d.slice(s) };
}
function positionLevels(p, stop, so) {
  const pbo = pbFor(p.symbol), nt = pbo && pbo.pb_state.targets && pbo.pb_state.targets[0], t = nt ? { price: nt.price } : targetOrderFor(p.symbol);
  return [{ name: "Entry", color: "#4f8cff", v: p.avg }, stop != null ? { name: so ? "Stop-loss" : "Planned stop", color: "#e5484d", v: +stop } : null, t ? { name: "Target", color: "#0a9a6a", v: +t.price } : null].filter(Boolean);
}
function stopInfo(p) {
  const so = stopOrderFor(p.symbol), pbo = pbFor(p.symbol), pbs = pbo && pbo.pb_state, stop = pbs ? pbs.stop : so ? +so.price : p.stop;
  return { so, pbo, pbs, stop, dist: stop != null && p.price ? (p.price - stop) / p.price * 100 : null };
}

function stockHtml(sym, m) {
  const d = MD[m], r = rowsOf(m).find(x => x.sym === sym), p = ACC.positions.find(x => x.symbol === sym);
  const cfg = d ? d.meta.cfg : null, N = filters(m).N;
  const ins = r && cfg ? SC.insights(r, N, cfg) : null;
  const name = r ? r.name + (r.sector ? " · " + r.sector : "") : (p ? "Your position" : "");
  const close = r ? r.close : p ? p.price : null, chg = r ? r.chg : null;
  let body = "";
  body += `<div class="card"><div style="display:flex;justify-content:space-between;align-items:flex-end"><div><div class="mut" style="font-size:12px">${r ? "Last close · " + esc(d.meta.date) : p && p.priceDate ? "Last close · " + esc(p.priceDate) : "Last price"}</div>
      <div style="font-size:30px;font-weight:800;letter-spacing:-.02em">${money(close, m)}</div></div>${chg != null ? `<span class="pill ${chg >= 0 ? "up" : "dn"}" style="font-size:14px;padding:4px 10px">${pct(chg)}</span>` : ""}</div></div>`;

  // chart
  let chart = "";
  const si = p ? stopInfo(p) : null;
  if (r) {
    const lv = SC.levelFor(r.lv, N), levels = [];
    if (lv !== null) levels.push({ name: N + "-session high", color: "#8a8fa8", v: lv });
    if (p) { levels.push({ name: "Entry", color: "#4f8cff", v: p.avg }); if (si.stop != null) levels.push({ name: "Stop", color: "#e5484d", v: si.stop }); }
    chart = Charts.candles(r.cx, { levels, label: sym + " daily chart" });
  } else if (p) {
    const sc = storedCandles(p.yf);
    chart = sc ? Charts.candles(sc, { levels: positionLevels(p, si.stop, si.so || si.pbs), vol: false, label: sym + " daily chart" }) : posLineChart(p, si);
  }
  if (chart) body += `<div class="card"><div class="sec" style="padding:0 0 8px"><h2>Daily chart</h2><span class="mut" style="font-size:12px">drag to read values</span></div>${chart}</div>`;

  // your position
  if (p) {
    const dc = dayChange(p);
    body += `<div class="card"><div class="sec" style="padding:0 0 10px"><h2>Your position</h2><span class="pill ${p.pnl >= 0 ? "up" : "dn"}">${pct(p.pct)}</span></div><div class="kv">
      <div><small>Quantity</small><b>${num(p.qty)}</b></div><div><small>Average cost</small><b>${money(p.avg, m)}</b></div>
      <div><small>Value</small><b>${money(p.value, m)}</b></div><div><small>P&amp;L</small><b class="${sgn(p.pnl)}">${sgnm(p.pnl, m)}</b></div>
      ${dc ? `<div><small>Today</small><b class="${sgn(dc.abs)}">${sgnm(dc.abs, m)} (${pct(dc.pct)})</b></div>` : ""}<div><small>Held</small><b>${p.days} day${p.days === 1 ? "" : "s"}</b></div>
      <div><small>Stop</small><b>${si.stop != null ? money(si.stop, m) : "none"}</b><small>${si.pbs ? "playbook" + (si.pbs.be ? " · at cost" : "") : si.so ? "stop order" : si.stop != null ? "planned" : ""}${si.dist != null ? " · " + si.dist.toFixed(1) + "% below" : ""}</small></div>
      ${si.pbs && si.pbs.ema != null ? `<div><small>Playbook exit</small><b>${si.pbs.exit_next ? "next open" : "close < " + money(si.pbs.ema, m)}</b></div>` : ""}</div></div>`;
  }

  // checklist
  if (ins) {
    body += `<div class="card"><div class="sec" style="padding:0 0 10px"><h2>Checklist</h2><span class="mut" style="font-size:12px">${N}-session breakout</span></div>
      <div class="tally"><div class="g"><b>${ins.good}</b>positive</div><div class="w"><b>${ins.warn}</b>caution</div><div class="b"><b>${ins.bad}</b>warning</div></div>
      ${ins.stop ? `<div class="stopbox" style="margin:14px 0 4px"><div><small>Reference stop (higher of the breakout level and the day's low)</small><b>${money(ins.stop.px, m)}</b></div>
        <div style="text-align:right"><span class="pill dn">${ins.stop.risk.toFixed(1)}% below</span>${ins.stop.atrMult != null ? `<small style="display:block;margin-top:4px">${ins.stop.atrMult.toFixed(1)}× daily range</small>` : ""}</div></div>` : ""}
      ${["Breakout", "Trend", "Risk", "Data check"].map(g => { const it = ins.items.filter(i => i.g === g); return it.length ? `<div class="grp">${g === "Risk" ? "Risk &amp; timing" : g}</div><ul class="ins">${it.map(i => `<li class="${i.l}">${esc(i.t)}</li>`).join("")}</ul>` : ""; }).join("")}
      <p class="hint">Observations that summarise a chart, not signals to buy or sell.</p></div>`;
  } else if (!p) body += `<div class="card note">This stock is not in the latest screener results, so there is no checklist or chart. You can still place an order.</div>`;

  body += `<div class="card flush"><a class="row" href="${tvUrl(sym, m)}" target="_blank" rel="noopener"><div class="mid"><b>TradingView</b></div>${icon("ext", "chev")}</a>
    <a class="row" href="${yahooUrl(sym, m)}" target="_blank" rel="noopener"><div class="mid"><b>Yahoo Finance</b></div>${icon("ext", "chev")}</a></div>`;

  const foot = p
    ? `<div class="page-ft"><button class="btn sell" data-act="sellpos" data-sym="${esc(sym)}">Sell</button><button class="btn ghost" data-act="setstop" data-sym="${esc(sym)}">${si.so ? "Move stop" : "Set stop"}</button><button class="btn buy" data-act="buystock" data-sym="${esc(sym)}">Buy</button></div>`
    : `<div class="page-ft"><button class="btn buy" data-act="buystock" data-sym="${esc(sym)}">Paper trade this · Buy</button></div>`;
  return pageHead(sym, esc(name), `<span class="pill brand">${esc(MKT[m].name)}</span>`) + `<div class="page-in">${body}</div>` + foot;
}
function posLineChart(p, si) {
  const px = (PM[p.yf] || []).filter(x => x.date >= addDays(p.since, -14));
  if (px.length < 2) return `<p class="hint">The chart needs two or more daily closes; it fills in after the next daily job.</p>`;
  const a = px[0].date, z = px[px.length - 1].date, ln = (name, color, v) => ({ name: name + " " + money(v), color, w: 1.5, dash: true, pts: [{ x: a, y: v }, { x: z, y: v }] });
  const series = [{ name: "Close", color: "var(--brand)", area: true, pts: px.map(x => ({ x: x.date, y: x.close })) }, ln("Entry", "#4f8cff", p.avg)];
  if (si && si.stop != null) series.push(ln("Stop", "#e5484d", si.stop));
  return Charts.line(series, v => money(v));
}

function openStock(sym) {
  const m = M;
  const L = openPage(stockHtml(sym, m), { sym, m });
  L.opts.render = () => { if (M !== m) return; L.el.querySelector(".page-body").innerHTML = stockHtml(sym, m); Charts.bind(L.el); };
}
ACT.stock = el => openStock(el.dataset.sym);
ACT.buystock = el => {
  const sym = el.dataset.sym, r = rowsOf(M).find(x => x.sym === sym), N = filters(M).N, ins = r ? SC.insights(r, N, MD[M].meta.cfg) : null;
  openTicket({ sym, side: "BUY", type: "STOP", px: r ? r.close : refPrice(sym), stop: ins && ins.stop ? ins.stop.px : "", tag: r ? "screener" : "", note: r ? `From the screener (close ${r.close})` : "" });
};
ACT.sellpos = el => { const p = ACC.positions.find(x => x.symbol === el.dataset.sym); if (p) openTicket({ sym: p.symbol, side: "SELL", qty: p.qty, type: "MARKET" }); };
