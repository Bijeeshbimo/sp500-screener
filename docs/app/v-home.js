/* Home tab, and the row/card pieces other tabs reuse. */
"use strict";
const Views = {};

const sig = ins => `<span class="dots">${ins.good ? `<span class="g">● ${ins.good}</span>` : ""}${ins.warn ? `<span class="w">● ${ins.warn}</span>` : ""}${ins.bad ? `<span class="b">● ${ins.bad}</span>` : ""}</span>`;

function stockRow(k, m) {                               // k = {r, ins}
  const r = k.r, cfg = MD[m || M].meta.cfg;
  return `<button class="row" data-act="stock" data-sym="${esc(r.sym)}">
    <div class="av">${esc(initials(r.sym))}</div>
    <div class="mid"><b>${esc(r.sym)}</b><small>${esc(r.name)}${r.sector ? " · " + esc(r.sector) : ""}</small>${sig(k.ins)}</div>
    <div style="width:78px;flex:none">${Charts.sparkBars(r.spark, "1-month return " + r.m1 + "%")}</div>
    <div class="end"><b>${money(r.close, m)}</b><small class="${sgn(r.chg)}">${pct(r.chg)}</small></div></button>`;
}
function miniCard(k) {
  const r = k.r;
  return `<button class="mini" data-act="stock" data-sym="${esc(r.sym)}"><b>${esc(r.sym)}</b><small>${esc(r.name)}</small>
    <div class="px">${money(r.close)}</div><span class="pill ${r.chg >= 0 ? "up" : "dn"}">${pct(r.chg)}</span>${Charts.sparkBars(r.spark, "")}</button>`;
}
function posRow(p) {
  return `<button class="row" data-act="stock" data-sym="${esc(p.symbol)}"><div class="av">${esc(initials(p.symbol))}</div>
    <div class="mid"><b>${esc(p.symbol)}</b><small>${num(p.qty)} × ${money(p.avg)}</small></div>
    <div class="end"><b>${money(p.value)}</b><small class="${sgn(p.pnl)}">${sgnm(p.pnl)} (${pct(p.pct)})</small></div></button>`;
}
const skeletons = n => Array.from({ length: n }, () => '<div class="skel"></div>').join("");
const emptyBox = (big, title, msg, btn) => `<div class="card empty"><div class="big">${big}</div><b>${esc(title)}</b>${msg ? `<div>${msg}</div>` : ""}${btn ? `<div style="margin-top:14px">${btn}</div>` : ""}</div>`;

function notices() {
  let h = "";
  if (STORE && STORE.mode === "demo") h += `<div class="banner">Demo mode: your data stays on this phone and orders are never filled. Connect Firebase in <b>config.js</b> to sync with your account.</div>`;
  if (NEWDATA) h += `<div class="banner ok">New screener data is available. <button data-act="refresh">Load it</button></div>`;
  if (OFFLINE) h += `<div class="banner">You are offline: showing the last data saved on this phone.</div>`;
  if (BLK.unpriced) h += `<div class="banner">${BLK.unpriced} pending market buy order(s) have no known price yet, so their funds are not counted.</div>`;
  if (ACC && ACC.cash < -0.005) h += `<div class="banner err">Cash is negative. A deposit is missing, or a trade was entered or edited with the wrong amount. Check Funds and the executed orders.</div>`;
  return h;
}

Views.home = function () {
  const a = ACC, d = MD[M], cur = MKT[M].name;
  let h = notices();
  if (!hasMoney()) {
    h += `<div class="hero"><div class="lbl">${cur} practice account</div><div class="big">${money(0)}</div>
      <div class="chg">Add pretend funds to start paper trading.</div>
      <div class="acts"><button data-act="addfunds">Add funds</button><button class="alt" data-act="tab" data-v="scan">Browse breakouts</button></div></div>`;
  } else {
    const dt = dayTotal();
    h += `<div class="hero"><div class="lbl">Account value · ${cur}</div><div class="big">${money(a.equity)}</div>
      <div class="chg">${dt ? `<span class="${dt.abs >= 0 ? "pos" : "neg"}">Today ${sgnm(dt.abs)} (${pct(dt.pct)})</span>` : ""}<span class="${a.pnl >= 0 ? "pos" : "neg"}">Total ${sgnm(a.pnl)}${a.netDeposits > 0 ? " (" + pct(a.pnl / a.netDeposits * 100) + ")" : ""}</span></div>
      <div class="grid3"><div><small>Invested</small><b>${money(a.invested, M, 0)}</b></div><div><small>Available</small><b>${money(avail(), M, 0)}</b></div><div><small>${BLK.total ? "Blocked" : "Realized"}</small><b>${money(BLK.total ? BLK.total : a.realized, M, 0)}</b></div></div>
      <div class="acts"><button data-act="addfunds">Add funds</button><button class="alt" data-act="neworder">New order</button></div></div>`;
  }

  const P = a ? a.positions.slice(0, 4) : [];
  if (P.length) h += `<div class="sec"><h2>Open positions</h2><button data-act="tab" data-v="port">View all (${a.positions.length})</button></div><div class="card flush">${P.map(posRow).join("")}</div>`;
  const pend = livePending().filter(o => !o.parent_id || o.status === "pending");
  if (pend.length) h += `<button class="card tile link" data-act="tab" data-v="orders" style="width:100%"><small>Pending orders</small><b>${pend.length} waiting for the next market close</b></button>`;

  if (!d) h += `<div class="sec"><h2>Breakouts today</h2></div>${skeletons(3)}`;
  else {
    const sc = screened(M), f = filters(M);
    h += `<div class="sec"><h2>Breakouts today</h2><button data-act="tab" data-v="scan">See all ${sc.matched}</button></div>`;
    if (sc.list.length) h += `<div class="hscroll">${sc.list.slice(0, 8).map(miniCard).join("")}</div>`;
    else h += emptyBox("🔍", "No matches", "Nothing passes the " + f.N + "-session breakout with your filters.", `<button class="btn sm brand" data-act="tab" data-v="scan">Adjust filters</button>`);
    h += `<div class="card note">${d.meta.scanned.toLocaleString()} stocks scanned for the ${esc(d.meta.date)} close · refreshed ${esc(d.meta.generated)}. These are chart observations, not advice.</div>`;
  }
  return h;
};
