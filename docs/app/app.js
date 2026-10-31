/* App shell: tab bar, header, rendering, sign-in, start-up and keeping data fresh. */
"use strict";
const TABS = [["home", "Home", "home"], ["scan", "Screener", "scan"], ["orders", "Orders", "orders"], ["port", "Portfolio", "port"], ["more", "More", "more"]];
let MDERR = {};

function headerInfo() {
  const d = MD[M], last = Object.values(PM).flat().map(p => p.date).sort().pop();
  switch (TAB) {
    case "home": return ["Breakout Desk", `${MKT[M].name} · ${d ? "screener as of " + d.meta.date : "loading data…"}`];
    case "scan": return ["Screener", d ? `${d.meta.cfg.name} · ${d.meta.date} close` : "loading…"];
    case "orders": return ["Orders", `${MKT[M].name} · ${livePending().length} open`];
    case "port": return ["Portfolio", `${MKT[M].name} · prices as of ${last || "(none yet)"}`];
    default: return ["More", ""];
  }
}

function render() {
  if (!STORE) return;
  compute();
  const [t, sub] = headerInfo();
  $("#ttl").innerHTML = `<b>${esc(t)}</b>${sub ? `<small>${esc(sub)}</small>` : ""}`;
  $("#mseg").hidden = TAB === "more";
  $$("#mseg button").forEach(b => b.setAttribute("aria-pressed", b.dataset.v === M));
  const rb = $("#refresh-btn"); rb.innerHTML = icon("refresh") + (NEWDATA ? '<span class="dot"></span>' : "");
  const pend = livePending().filter(o => !o.parent_id || o.status === "pending").length;
  $("#tabbar").innerHTML = TABS.map(([k, label, ic]) => `<button data-act="tab" data-v="${k}" aria-selected="${TAB === k}">${icon(ic)}<span>${label}</span>${k === "orders" && pend ? `<span class="badge">${pend}</span>` : ""}</button>`).join("");
  const v = $("#view"), st = v.scrollTop;
  v.innerHTML = Views[TAB]();
  v.scrollTop = st;
  Charts.bind(v);
}
function refreshLayers() { LAYERS.forEach(L => { if (L.opts.render) L.opts.render(); }); }

ACT.tab = el => { if (LAYERS.length) return closeAll(() => ACT.tab(el)); TAB = el.dataset.v; render(); $("#view").scrollTop = 0; if (["home", "scan"].includes(TAB)) ensureMarket(M); };
ACT.mkt = async el => {
  M = el.dataset.v; ls.set("bd-m", M); render();
  await ensureMarket(M); render();
};
async function ensureMarket(m, force) {
  if (MD[m] && !force) return;
  try { await loadMarket(m, force); delete MDERR[m]; } catch (e) { MDERR[m] = e; }
  if (m === M) render();
}
function dataMissing() {
  if (!MDERR[M]) return skeletons(6);
  return emptyBox("📡", "Could not load screener data", `${esc(errText(MDERR[M]))}<br>Data source: <span class="mut">${esc(dataBase())}</span>`, `<button class="btn brand" data-act="retrydata">Try again</button>`);
}
ACT.retrydata = async () => { delete MDERR[M]; render(); await ensureMarket(M, true); };

/* ------------------------------------------------------------------ sign-in -- */
function showAuth() {
  $("#boot").hidden = true; $("#auth").hidden = false;
  closeAll();
  const msg = (t, ok) => { const m = $("#a-msg"); m.style.color = ok ? "var(--up)" : ""; m.textContent = t; };
  const cred = () => ({ email: $("#a-email").value.trim(), password: $("#a-pass").value });
  const go = fn => async () => { try { msg(""); const c = cred(); await fn(c); $("#auth").hidden = true; $("#a-pass").value = ""; await start(); } catch (e) { msg(errText(e)); } };
  $("#auth-form").onsubmit = e => { e.preventDefault(); go(c => STORE.signIn(c.email, c.password))(); };
  $("#a-up").onclick = go(c => STORE.signUp(c.email, c.password));
  $("#a-reset").onclick = async () => {
    const e = $("#a-email").value.trim(); if (!e) return msg("Type your email first.");
    try { await STORE.reset(e); msg("If that email has an account, a password reset link is on its way.", true); } catch (x) { msg(errText(x)); }
  };
}

/* ------------------------------------------------------------------ start-up -- */
function bootError(e) {
  $("#boot").hidden = false; $("#auth").hidden = true;
  $("#boot-msg").innerHTML = esc(errText(e));
  const b = $("#boot-retry"); b.hidden = false; b.onclick = () => location.reload();
}
async function start() {
  $("#auth").hidden = true; $("#boot").hidden = false; $("#boot-retry").hidden = true; $("#boot-msg").textContent = "Loading your account…";
  try {
    await loadMeta(true).catch(() => {});
    await Promise.all([ensureMarketQuiet(M), reload()]);
  } catch (e) { return bootError(e); }
  compute();
  $("#boot").hidden = true;
  render();
  if (!window.__started) {
    window.__started = true;
    document.addEventListener("visibilitychange", () => { if (!document.hidden && Date.now() - LASTCHK > 120000) checkNewData(true).then(() => render()); });
    setInterval(() => { if (!document.hidden) checkNewData(true).then(() => render()); }, 10 * 60 * 1000);
  }
}
async function ensureMarketQuiet(m) { try { await loadMarket(m); delete MDERR[m]; } catch (e) { MDERR[m] = e; } }

async function boot() {
  applyTheme();
  $$(".logo").forEach(l => { l.innerHTML = LOGO; });
  const q = new URLSearchParams(location.search);
  try {
    const fb = CFG.firebase || {};
    if (q.get("demo") === "1" || !fb.apiKey || !fb.projectId) STORE = Store.localStore();
    else {
      STORE = await Store.firebaseStore(fb);
      STORE.onSignedOut(() => { STORE.signedOut = true; showAuth(); });
      if (!await STORE.restore()) return showAuth();
    }
    await start();
  } catch (e) { bootError(e); }
  if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol) && !(window.Capacitor && Capacitor.isNativePlatform && Capacitor.isNativePlatform()) && !q.has("nosw")) navigator.serviceWorker.register("sw.js").catch(() => {});
  // Android: the back button closes the top screen first (handled through history), then leaves the app.
  try { const A = window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.App; if (A && A.addListener) A.addListener("appStateChange", s => { if (s.isActive && Date.now() - LASTCHK > 120000) checkNewData(true).then(() => render()); }); } catch (e) {}
}
boot();
