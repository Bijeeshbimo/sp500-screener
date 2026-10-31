/* Shared helpers, state, screen layers (sheets and pages), data loading. Classic scripts share these top-level names. */
"use strict";
const PC = PaperCore, SC = ScreenerCore, CFG = window.PAPER_CONFIG || {}, ACFG = window.APP_CONFIG || {};
const $ = (s, el) => (el || document).querySelector(s);
const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
const esc = Charts.esc;
const ls = { get: k => { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} }, del: k => { try { localStorage.removeItem(k); } catch (e) {} } };
const MKT = {
  IN: { cur: "₹", loc: "en-IN", name: "India", bench: "^NSEI", benchName: "Nifty 50", file: "market_in.json" },
  US: { cur: "$", loc: "en-US", name: "US", bench: "^GSPC", benchName: "S&P 500", file: "market_us.json" },
};

/* ------------------------------------------------------------------ state -- */
let M = ls.get("bd-m") === "US" ? "US" : "IN", TAB = "home";
let STORE = null, S = { ledger: [], orders: [], fills: [], prices: [], settings: PC.mergeSettings({}) };
let PM = {}, CANDLES = {}, ACC = null, BLK = { total: 0, items: {}, unpriced: 0 };
let MD = {}, SESS = {}, FX = null, LOADED_SIG = null, NEWDATA = false, LASTCHK = 0, OFFLINE = false;

/* ---------------------------------------------------------------- formatting -- */
const today = () => new Date().toLocaleDateString("en-CA");
const money = (x, mk, d) => x == null || isNaN(x) ? "–" : (x < 0 ? "-" : "") + MKT[mk || M].cur + Math.abs(x).toLocaleString(MKT[mk || M].loc, { minimumFractionDigits: d == null ? 2 : d, maximumFractionDigits: d == null ? 2 : d });
const num = (x, d) => x == null || isNaN(x) ? "–" : (+x).toLocaleString("en-US", { maximumFractionDigits: d == null ? 4 : d });
const pct = x => x == null || isNaN(x) ? "–" : (x > 0 ? "+" : "") + x.toFixed(2) + "%";
const sgn = x => x > 0.005 ? "up" : x < -0.005 ? "dn" : "";
const sgnm = (x, mk) => (x > 0.005 ? "+" : "") + money(x, mk);
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : "id-" + Date.now() + Math.random().toString(16).slice(2));
const toYf = (sym, m) => m === "IN" ? sym.replace(/\.NS$/i, "") + ".NS" : sym.replace(/\./g, "-");
const initials = s => String(s || "?").replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase();
const addDays = (d, n) => new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10);
const tvUrl = (sym, m) => "https://www.tradingview.com/chart/?symbol=" + encodeURIComponent((m === "IN" ? "NSE:" + sym.replace(/[&-]/g, "_") : sym.replace(/-/g, ".")));
const yahooUrl = (sym, m) => "https://finance.yahoo.com/quote/" + encodeURIComponent(m === "IN" ? sym + ".NS" : sym.replace(".", "-"));
const val = (f, n) => f.elements[n].value.trim();
const nval = (f, n) => { const v = val(f, n); return v === "" ? null : +v; };

const ICONS = {
  home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>',
  scan: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/><path d="M8 13l2.5-2.5 2 2L15 9.5"/>',
  orders: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4h6v3H9z"/><path d="M8.5 12h7M8.5 16h5"/>',
  port: '<path d="M12 3v9h9"/><path d="M20.5 15A9 9 0 1112 3"/>',
  more: '<rect x="4" y="4" width="7" height="7" rx="2"/><rect x="13" y="4" width="7" height="7" rx="2"/><rect x="4" y="13" width="7" height="7" rx="2"/><rect x="13" y="13" width="7" height="7" rx="2"/>',
  refresh: '<path d="M20 11a8 8 0 10-2.3 5.7"/><path d="M20 4v7h-7"/>', back: '<path d="M15 5l-7 7 7 7"/>', close: '<path d="M6 6l12 12M18 6L6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', chev: '<path d="M9 6l6 6-6 6"/>',
  filter: '<path d="M4 6h9M19 6h1M4 12h3M13 12h7M4 18h11M21 18h-1"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  wallet: '<path d="M3 7a2 2 0 012-2h13v4"/><path d="M3 7v11a2 2 0 002 2h15V9H5a2 2 0 01-2-2z"/><circle cx="16.5" cy="14.5" r="1"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
  logout: '<path d="M15 4h3a2 2 0 012 2v12a2 2 0 01-2 2h-3"/><path d="M10 8l-4 4 4 4M6 12h10"/>',
  download: '<path d="M12 4v11M7 11l5 5 5-5M5 20h14"/>', moon: '<path d="M20 14.5A8 8 0 019.5 4 8 8 0 1020 14.5z"/>',
  chart: '<path d="M4 20V4M4 20h16"/><path d="M8 15l3-4 3 2 4-6"/>', info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
  ext: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 13v6H5V6h6"/>', list: '<path d="M5 6h14M5 12h14M5 18h9"/>',
  trend: '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>', globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18"/>',
};
const icon = (n, cls) => `<svg class="${cls || ""}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n] || ""}</svg>`;
const LOGO = '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 17l5-6 4 3 7-8"/><path d="M15 6h5v5"/></svg>';

/* ------------------------------------------------------------------- theme -- */
function applyTheme() {
  const pref = ls.get("bd-theme") || "auto";
  const dark = pref === "dark" || (pref === "auto" && window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  const bg = dark ? "#080b15" : "#f3f5fa";
  const m = $('meta[name="theme-color"]'); if (m) m.setAttribute("content", bg);
  try { const SB = window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.StatusBar; if (SB) { SB.setStyle({ style: dark ? "DARK" : "LIGHT" }); SB.setBackgroundColor({ color: bg }); } } catch (e) {}
}
if (window.matchMedia) matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);

/* ------------------------------------------------------------ toast + layers -- */
function toast(msg) {
  const t = $("#toast"); t.innerHTML = `<div>${esc(msg)}</div>`;
  clearTimeout(toast.h); toast.h = setTimeout(() => { t.innerHTML = ""; }, 3000);
}
const LAYERS = [];
let AFTER_POP = [];
function pushLayer(kind, html, opts) {
  opts = opts || {};
  const el = document.createElement("div");
  el.className = "layer";
  el.innerHTML = kind === "sheet"
    ? `<div class="scrim"></div><div class="sheet-body ${opts.cls || ""}"><div class="grab"></div>${html}</div>`
    : `<div class="page-body">${html}</div>`;
  $("#layers").appendChild(el);
  const L = { el, kind, opts };
  LAYERS.push(L);
  history.pushState({ d: LAYERS.length }, "");
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add("in")));
  const sc = $(".scrim", el); if (sc) sc.addEventListener("click", () => closeLayer(L));
  Charts.bind(el);
  return L;
}
const openSheet = (html, opts) => pushLayer("sheet", html, opts);
const openPage = (html, opts) => pushLayer("page", html, opts);
function removeLayer(L) {
  const i = LAYERS.indexOf(L); if (i < 0) return;
  LAYERS.splice(i, 1); L.el.classList.remove("in");
  setTimeout(() => L.el.remove(), 260);
  if (L.opts.onClose) L.opts.onClose();
}
function closeLayer(L) { if (L === LAYERS[LAYERS.length - 1]) history.back(); else removeLayer(L); }
function closeTop() { if (LAYERS.length) history.back(); }
function closeAll(cb) {                       // close every layer, then run cb once the browser has finished going back
  if (!LAYERS.length) { if (cb) cb(); return; }
  if (cb) AFTER_POP.push(cb);
  history.go(-LAYERS.length);
}
window.addEventListener("popstate", e => {
  const d = (e.state && e.state.d) || 0;
  while (LAYERS.length > d) removeLayer(LAYERS[LAYERS.length - 1]);
  if (!LAYERS.length && AFTER_POP.length) { const f = AFTER_POP; AFTER_POP = []; f.forEach(fn => fn()); }
});
try { history.replaceState({ d: 0 }, ""); } catch (e) {}
const topLayer = () => LAYERS[LAYERS.length - 1];
function sheetHead(title, sub) { return `<div class="sheet-hd"><div><h3>${esc(title)}</h3>${sub ? `<div class="mut" style="font-size:12.5px">${sub}</div>` : ""}</div><button class="ibtn" data-act="back" aria-label="Close">${icon("close")}</button></div>`; }
function pageHead(title, sub, right) { return `<div class="page-hd"><button class="ibtn" data-act="back" aria-label="Back">${icon("back")}</button><div class="t"><b>${esc(title)}</b>${sub ? `<small>${sub}</small>` : ""}</div>${right || ""}</div>`; }

/* --------------------------------------------------------- click router -- */
const ACT = {};
document.addEventListener("click", async ev => {
  const b = ev.target.closest("[data-act]"); if (!b) return;
  const fn = ACT[b.dataset.act];
  if (!fn) return;
  try { await fn(b, ev); } catch (e) { console.error(e); toast(errText(e)); }
});
ACT.back = () => closeTop();
ACT.none = () => {};
const errText = e => (window.Store && Store.errMsg(e)) || (e && e.message) || String(e);
const errBox = (f, m) => { const x = f.querySelector(".err"); if (x) x.textContent = m; return false; };

/* -------------------------------------------------------------- data loading -- */
function dataBase() {
  const o = ls.get("bd-data-base");
  if (o) return o.endsWith("/") ? o : o + "/";
  const native = window.Capacitor && Capacitor.isNativePlatform && Capacitor.isNativePlatform();
  if (native || location.protocol === "file:") return ACFG.pagesUrl;
  return new URL("../", location.href).href;       // served from <your pages site>/app/, so the data is one folder up
}
/* Network first (so numbers are fresh), the last good copy when offline. */
async function getJSON(name, opts) {
  const url = dataBase() + name + (opts && opts.bust ? "?t=" + Date.now() : "");
  let cache = null; try { cache = window.caches ? await caches.open("bd-data-v1") : null; } catch (e) {}
  try {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    if (cache) { try { await cache.put(name, r.clone()); } catch (e) {} }
    OFFLINE = false;
    return await r.json();
  } catch (e) {
    if (cache) { const c = await cache.match(name); if (c) { OFFLINE = true; return await c.json(); } }
    throw e;
  }
}
async function loadMarket(m, force) {
  if (MD[m] && !force) return MD[m];
  const d = await getJSON(MKT[m].file, { bust: force });
  d.rows.forEach(r => { r.sg = null; });
  MD[m] = d; return d;
}
async function loadMeta(force) {
  const [v, f] = await Promise.all([getJSON("version.json", { bust: true }).catch(() => null), getJSON("fx.json", { bust: force }).catch(() => null)]);
  if (v) { SESS = v.sessions || {}; if (force || !LOADED_SIG) LOADED_SIG = v.sig; }
  if (f) FX = f;
  return v;
}
async function checkNewData(quiet) {
  LASTCHK = Date.now();
  const v = await getJSON("version.json", { bust: true }).catch(() => null);
  if (!v) { if (!quiet) toast("Could not reach the data server"); return false; }
  SESS = v.sessions || SESS;
  NEWDATA = !!(LOADED_SIG && v.sig && v.sig !== LOADED_SIG);
  if (!quiet) toast(NEWDATA ? "New data is available" : "You already have the latest data");
  return NEWDATA;
}
async function reloadData() {                                     // pulls fresh screener files and re-reads the account
  await loadMeta(true); MD = {};
  await Promise.all([loadMarket(M, true), reload()]);
  NEWDATA = false;
}
async function reload() {
  try {
    const [ledger, orders, fills, prices, saved] = await Promise.all(["ledger", "orders", "fills", "prices"].map(t => STORE.list(t)).concat([STORE.getSettings()]));
    S = { ledger, orders, fills, prices, settings: PC.mergeSettings(saved) };
    CANDLES = STORE.candles || {};
    PM = {};
    for (const p of prices) (PM[p.yf] = PM[p.yf] || []).push({ date: p.date, close: +p.close });
    for (const k in PM) PM[k].sort((a, b) => (a.date < b.date ? -1 : 1));
  } catch (e) { throw e; }
}

/* ------------------------------------------------------- account maths glue -- */
const rowsOf = m => (MD[m] && MD[m].rows) || [];
function refPrice(sym, m) {
  m = m || M;
  const arr = PM[toYf(sym, m)]; if (arr && arr.length) return arr[arr.length - 1].close;
  const r = rowsOf(m).find(x => x.sym === sym); return r ? r.close : null;
}
function blockedFunds(m) {
  const out = { total: 0, items: {}, unpriced: 0 };
  for (const o of S.orders) {
    if (o.portfolio !== m || o.status !== "pending" || o.side !== "BUY") continue;
    const px = o.type === "MARKET" ? refPrice(o.symbol, m) : +o.price;
    if (!(px > 0)) { out.unpriced++; continue; }
    const amt = PC.r2(+o.qty * px + PC.tradeFees(m, "BUY", +o.qty, px, S.settings).total);
    out.items[o.id] = amt; out.total += amt;
  }
  out.total = PC.r2(out.total);
  return out;
}
function compute() {
  const lg = S.ledger.filter(r => r.portfolio === M), fl = S.fills.filter(r => r.portfolio === M);
  ACC = PC.buildAccount(lg, fl, PM, MKT[M].bench);
  BLK = blockedFunds(M);
}
const avail = () => ACC.cash - BLK.total;
const needFor = (m, qty, px) => PC.r2(qty * px + PC.tradeFees(m, "BUY", qty, px, S.settings).total);
const shortMsg = (need, have) => `Not enough available funds: this order needs about ${money(need)} and ${money(have)} is available${BLK.total ? ` (${money(BLK.total)} is blocked on other pending orders)` : ""}.`;
const lastSession = () => SESS[M] || today();
const stopOrderFor = sym => S.orders.find(o => o.portfolio === M && o.symbol === sym && o.side === "SELL" && o.type === "STOP" && (o.status === "pending" || o.status === "waiting"));
const targetOrderFor = sym => S.orders.find(o => o.portfolio === M && o.symbol === sym && o.side === "SELL" && o.type === "LIMIT" && (o.status === "pending" || o.status === "waiting"));
const pbFor = sym => S.orders.find(o => o.portfolio === M && o.symbol === sym && o.pb && o.pb_state && !o.pb_state.finished);
const livePending = () => S.orders.filter(o => o.portfolio === M && (o.status === "pending" || o.status === "waiting"));
const hasMoney = () => S.ledger.some(r => r.portfolio === M);

/* Day change for an open position: last close against the session before it. Shares bought on the last session count from their buy price. */
function dayChange(p) {
  const ser = (PM[p.yf] || []).slice().sort((x, y) => (x.date < y.date ? -1 : 1)), last = p.priceDate;
  const prev = ser.filter(x => x.date < last).pop();
  const bought = S.fills.filter(f => f.portfolio === M && f.symbol === p.symbol && f.side === "BUY" && f.date === last);
  const nq = Math.min(p.qty, bought.reduce((t, f) => t + +f.qty, 0)), nv = bought.reduce((t, f) => t + +f.qty * +f.price, 0) * (nq && bought.length ? nq / bought.reduce((t, f) => t + +f.qty, 0) : 0);
  if (!prev && !nq) return null;
  const oldQ = p.qty - nq, base = (prev ? oldQ * prev.close : 0) + nv;
  if (!(base > 0)) return null;
  const abs = p.qty * p.price - base;
  return { abs, pct: abs / base * 100, base };
}
function dayTotal() {
  let abs = 0, base = 0;
  for (const p of ACC.positions) { const d = dayChange(p); if (d) { abs += d.abs; base += d.base; } }
  return base > 0 ? { abs, pct: abs / base * 100 } : null;
}

/* ------------------------------------------------------------ screener state -- */
function defaultFilters(m) {
  const d = (MD[m] && MD[m].meta.cfg.defaults) || { adv: 10, px: 5, cap: 15 };
  return { N: SC.DEF_N, adv: d.adv, px: d.px, cap: d.cap, rmin: "", rmax: "", ext: "", rv: "", rs: "", idx: ((MD[m] && MD[m].meta.indices) || []).map(i => i.code), sort: "chg", asc: false, top: SC.DEF_TOP, q: "" };
}
const FL = {};
function filters(m) {
  m = m || M;
  if (!FL[m]) { let saved = null; try { saved = JSON.parse(ls.get("bd-fl-" + m)); } catch (e) {} FL[m] = Object.assign(defaultFilters(m), saved || {}); const codes = ((MD[m] && MD[m].meta.indices) || []).map(i => i.code); if (codes.length) FL[m].idx = FL[m].idx.filter(c => codes.includes(c)); if (codes.length && !FL[m].idx.length) FL[m].idx = codes; }
  return FL[m];
}
const saveFilters = m => ls.set("bd-fl-" + (m || M), JSON.stringify(FL[m || M]));
function screened(m) {
  m = m || M; const d = MD[m]; if (!d) return { list: [], matched: 0, N: 0 };
  const f = filters(m), base = SC.matches(d.rows, f, d.meta.cfg, d.meta.minLookback);
  if (!base) return { list: [], matched: 0, N: f.N, bad: true };
  let list = base;
  const q = (f.q || "").trim().toLowerCase();
  if (q) list = list.filter(r => r.sym.toLowerCase().includes(q) || (r.name || "").toLowerCase().includes(q));
  const keyed = SC.sortRows(list, f.sort, f.asc, f.N, d.meta.cfg);
  return { list: f.top > 0 ? keyed.slice(0, f.top) : keyed, matched: list.length, N: f.N };
}
