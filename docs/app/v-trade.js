/* Order ticket, Orders tab, order/stop/fill editors. The order documents are exactly what docs/paper.html writes, so the
   daily engine (paper/engine.py) fills them the same way. */
"use strict";
let OTAB = "open";

/* A confirm sheet. Resolves after the sheet has fully closed, so it is safe to open another screen right afterwards. */
function ask(title, msg, ok, danger) {
  return new Promise(res => {
    const L = openSheet(`${sheetHead(title)}<div class="sheet-in"><p style="margin:0">${msg}</p><div class="btnrow"><button class="btn ghost" data-act="ask-no">Cancel</button><button class="btn ${danger ? "danger" : "brand"}" data-act="ask-yes">${esc(ok || "OK")}</button></div></div>`, { onClose: () => res(!!L.yes) });
  });
}
ACT["ask-yes"] = () => { topLayer().yes = true; closeTop(); };
ACT["ask-no"] = () => closeTop();

async function afterWrite() { await reload(); compute(); render(); refreshLayers(); }
const goTab = t => { TAB = t; render(); const v = $("#view"); if (v) v.scrollTop = 0; };

/* ---------------------------------------------------------------- order ticket -- */
function ticketHtml(pref) {
  const m = M, cur = MKT[m].cur, india = m === "IN", side = pref.side || "BUY", type = pref.type || "STOP", pb = (S.settings.playbook || {}).default_on;
  const tags = [...new Set(S.fills.concat(S.orders).map(x => x.tag).filter(Boolean))];
  const risk = (S.settings.risk || {})[m.toLowerCase()] || "";
  const symField = pref.sym ? `<input type="hidden" name="sym" value="${esc(pref.sym)}">` :
    `<label class="fld"><span>Symbol</span><input name="sym" list="symlist" autocomplete="off" autocapitalize="characters" placeholder="e.g. ${india ? "RELIANCE" : "AAPL"}"><datalist id="symlist">${rowsOf(m).map(r => `<option value="${esc(r.sym)}">${esc(r.name)}</option>`).join("")}</datalist></label>`;
  return `<div class="tk-hd ${side === "SELL" ? "sell" : ""}" id="tk-hd"><div class="r1"><div><b id="tk-sym">${esc(pref.sym || "New order")}</b><small id="tk-name">${esc(MKT[m].name)} equity · end-of-day fill</small></div>
      <span class="sw2"><button type="button" data-act="tkside" data-v="BUY" aria-pressed="${side === "BUY"}">Buy</button><button type="button" data-act="tkside" data-v="SELL" aria-pressed="${side === "SELL"}">Sell</button></span></div>
    <div class="px"><span id="tk-px">–</span><span id="tk-chg"></span></div></div>
  <form id="tf" class="sheet-in g1" novalidate>
    <input type="hidden" name="side" value="${side}"><input type="hidden" name="type" value="${type}">${symField}
    <div><div class="mut" style="font-size:12px;font-weight:600;margin-bottom:5px">Order type</div>
      <div class="seg" id="tk-type" style="display:flex;width:100%">${[["MARKET", "Market"], ["LIMIT", "Limit"], ["STOP", "Stop"]].map(t => `<button type="button" style="flex:1" data-act="tktype" data-v="${t[0]}" aria-pressed="${type === t[0]}">${t[1]}</button>`).join("")}</div>
      <div class="hint" id="tk-typeinfo" style="margin-top:6px"></div></div>
    <div class="g2"><label class="fld"><span>Quantity</span><div class="stepper"><button type="button" data-act="tkqty" data-d="-1">−</button><input name="qty" type="number" inputmode="${india ? "numeric" : "decimal"}" step="${india ? 1 : "any"}" value="${pref.qty || ""}"><button type="button" data-act="tkqty" data-d="1">+</button></div></label>
      <label class="fld" id="l-price"><span id="l-price-t">Price (${cur})</span><input name="price" type="number" inputmode="decimal" step="any" value="${esc(pref.px || "")}"></label></div>
    <div id="buyonly" class="g1">
      <div class="g2"><label class="fld"><span id="l-bstop-t">Stop-loss (${cur})</span><input name="bstop" type="number" inputmode="decimal" step="any" value="${esc(pref.stop || "")}" placeholder="optional"></label>
        <label class="fld"><span>Risk amount (${cur})</span><input name="risk" type="number" inputmode="decimal" step="any" value="${risk}"></label></div>
      <label class="fld" id="l-btgt"><span>Target (${cur})</span><input name="btgt" type="number" inputmode="decimal" step="any" placeholder="optional"></label>
      <div class="hint" id="rinfo" style="margin:0"></div>
      <label class="chk"><input type="checkbox" name="pb" ${pb ? "checked" : ""}><span><b>Profit-booking playbook</b><br><small class="mut">Sells in slices at R targets, then trails</small></span></label>
      <div class="hint" id="pbinfo" style="margin:0"></div>
    </div>
    <details class="card" style="padding:12px 16px;box-shadow:none;border:1px solid var(--line)"><summary style="font-weight:700;cursor:pointer">More options</summary><div class="g1" style="margin-top:12px">
      <div class="g2"><label class="fld"><span>Fill from sessions after</span><input name="after" type="date" value="${esc(lastSession())}"></label><label class="fld"><span>Expires (optional)</span><input name="expiry" type="date"></label></div>
      <label class="fld"><span>Tag</span><input name="tag" list="taglist" value="${esc(pref.tag || "")}"><datalist id="taglist">${tags.map(t => `<option value="${esc(t)}">`).join("")}</datalist></label>
      <label class="fld" id="l-stopref"><span>Planned stop for R-multiples (follows the stop-loss)</span><input name="stopref" type="number" inputmode="decimal" step="any"></label>
      <label class="fld"><span>Note</span><input name="note" value="${esc(pref.note || "")}"></label></div></details>
    <div class="err" role="alert"></div>
  </form>
  <div class="sheet-ft"><div class="tk-sum" id="tk-sum"><span>Required <b id="tk-need">–</b></span><span>Available <b>${money(avail())}</b></span></div><button class="btn block buy" id="tk-go" type="submit" form="tf">Buy</button></div>`;
}

function openTicket(pref) {
  pref = pref || {};
  if (!hasMoney() && (pref.side || "BUY") === "BUY") toast("Tip: add funds first, a buy needs available cash");
  const m = M, india = m === "IN", cur = MKT[m].cur;
  const L = openSheet(ticketHtml(pref), { cls: "tk" });
  const f = $("#tf", L.el), g = id => $("#" + id, L.el);
  const side = () => f.elements.side.value, type = () => f.elements.type.value, symOf = () => val(f, "sym").toUpperCase().replace(/\.NS$/, "");
  let driver = pref.qty ? "qty" : "risk", stopTouched = false;
  const pbc = S.settings.playbook;

  const sync = () => {
    const s = side(), t = type(), sym = symOf(), row = rowsOf(m).find(x => x.sym === sym);
    g("tk-hd").classList.toggle("sell", s === "SELL");
    $$("[data-act=tkside]", L.el).forEach(b => b.setAttribute("aria-pressed", b.dataset.v === s));
    $$("[data-act=tktype]", L.el).forEach(b => b.setAttribute("aria-pressed", b.dataset.v === t));
    g("l-price").hidden = t === "MARKET";
    g("l-price-t").textContent = (t === "STOP" ? "Trigger price" : "Limit price") + ` (${cur})`;
    g("tk-typeinfo").textContent = t === "MARKET" ? "Fills at the next session's open." : t === "LIMIT" ? (s === "BUY" ? "Buys at your price or better." : "Sells at your price or better.") : (s === "BUY" ? "Buys once price rises to your trigger (a breakout entry)." : "Sells once price falls to your trigger (a stop-loss).");
    g("buyonly").hidden = s !== "BUY"; g("l-stopref").hidden = s !== "BUY";
    const pbOn = s === "BUY" && f.elements.pb.checked;
    g("l-btgt").hidden = pbOn; g("l-bstop-t").textContent = (pbOn ? "Initial stop-loss, defines 1R" : "Stop-loss") + ` (${cur})`;
    const q = +val(f, "qty") || 0, ep = t === "MARKET" ? refPrice(sym, m) : +val(f, "price"), st = +val(f, "bstop") || +val(f, "stopref"), R = ep - st;
    g("pbinfo").textContent = !pbOn ? "" : ep > 0 && st > 0 && R > 0 ? `1R = ${money(R)}. Sells ${pbc.t1_pct}% at ${money(ep + pbc.t1_r * R)} (${pbc.t1_r}R) and ${pbc.t2_pct}% at ${money(ep + pbc.t2_r * R)} (${pbc.t2_r}R); stop to cost at ${pbc.be_r}R; the rest goes on a close below the ${pbc.ema_len} EMA.` : "Enter the entry price and an initial stop-loss below it.";
    // header
    g("tk-sym").textContent = sym || "New order";
    const close = row ? row.close : refPrice(sym, m);
    g("tk-name").textContent = row ? row.name : MKT[m].name + " equity · end-of-day fill";
    g("tk-px").textContent = close ? money(close) : "–";
    g("tk-chg").textContent = row ? " " + pct(row.chg) + " today" : "";
    // footer
    const px = ep || close;
    const sum = g("tk-sum"), need = g("tk-need");
    let needAmt = null;
    if (px && q) { const fee = PC.tradeFees(m, s, q, px, S.settings, true); needAmt = s === "BUY" ? PC.r2(q * px + fee.total) : PC.r2(q * px - fee.total); need.textContent = money(needAmt); need.title = `Value ${money(q * px)} + charges ${money(fee.total)}`; } else need.textContent = "–";
    sum.firstElementChild.firstChild.textContent = s === "BUY" ? "Required " : "You receive ";
    sum.classList.toggle("bad", s === "BUY" && needAmt != null && needAmt > avail() + 0.005);
    need.classList.toggle("need", true);
    const go = g("tk-go"); go.className = "btn block " + (s === "BUY" ? "buy" : "sell"); go.textContent = (s === "BUY" ? "Buy " : "Sell ") + (sym || "");
  };
  const calc = () => {
    const out = g("rinfo");
    if (side() !== "BUY") { out.textContent = ""; return; }
    const sym = symOf(), px = type() === "MARKET" ? refPrice(sym, m) : +val(f, "price"), stop = +val(f, "bstop") || +val(f, "stopref"), per = px - stop;
    if (!(px > 0 && stop > 0 && per > 0)) { out.textContent = "Add the entry price and a stop-loss below it to link risk and quantity."; return; }
    if (driver === "risk") { const q = (+val(f, "risk") || 0) / per; f.elements.qty.value = q > 0 ? (india ? Math.round(q) : Math.floor(q * 1e4) / 1e4) : ""; }
    else f.elements.risk.value = (Math.round((+val(f, "qty") || 0) * per * 100) / 100) || "";
    const q = +val(f, "qty") || 0;
    out.textContent = q ? `Stop distance ${money(per)} a share. If the stop is hit you lose about ${money(q * per)} on ${q} shares, before charges.` : `Stop distance ${money(per)} a share.`;
  };
  f.addEventListener("input", e => {
    if (e.target.name === "risk") driver = "risk"; else if (e.target.name === "qty") driver = "qty";
    if (e.target.name === "stopref") stopTouched = true;
    if (e.target.name === "bstop" && !stopTouched) f.elements.stopref.value = f.elements.bstop.value;
    calc(); sync();
  });
  f.addEventListener("change", () => { calc(); sync(); });
  L.apply = (patch) => { Object.keys(patch).forEach(k => { f.elements[k].value = patch[k]; }); calc(); sync(); };
  L.setQty = d => { const q = Math.max(0, (+val(f, "qty") || 0) + d); f.elements.qty.value = india ? Math.round(q) : q; driver = "qty"; calc(); sync(); };
  if (pref.stop) f.elements.stopref.value = pref.stop;
  calc(); sync();
  f.onsubmit = async e => {
    e.preventDefault();
    const s = side(), t = type(), sym = symOf(), qty = nval(f, "qty"), price = nval(f, "price"), pbOn = s === "BUY" && f.elements.pb.checked;
    const bstop = s === "BUY" ? nval(f, "bstop") : null, btgt = s === "BUY" && !pbOn ? nval(f, "btgt") : null, pbStop = pbOn ? (bstop ?? nval(f, "stopref")) : null;
    if (!sym) return errBox(f, "Enter a symbol."); if (!(qty > 0)) return errBox(f, "Enter a quantity.");
    if (india && !Number.isInteger(qty)) return errBox(f, "Indian shares trade in whole numbers.");
    if (t !== "MARKET" && !(price > 0)) return errBox(f, "Enter a price for a limit or stop order.");
    if (!val(f, "after")) return errBox(f, "Pick the date after which the order can fill (More options).");
    if (pbOn) {
      if (!(pbStop > 0)) return errBox(f, "The playbook needs an initial stop-loss: it defines 1R.");
      const ep = t === "MARKET" ? refPrice(sym, m) : price; if (ep > 0 && pbStop >= ep) return errBox(f, "The stop-loss must be below your entry price.");
    }
    if (bstop != null && btgt != null && btgt <= bstop) return errBox(f, "The target must be above the stop-loss.");
    if (t !== "MARKET" && bstop != null && bstop >= price) return errBox(f, "The stop-loss must be below your entry price.");
    if (s === "BUY") {
      const rp = t === "MARKET" ? refPrice(sym, m) : price;
      if (rp > 0) { const need = needFor(m, qty, rp); if (need > avail() + 0.005) return errBox(f, shortMsg(need, avail())); }
    }
    const base = { portfolio: m, symbol: sym, yf: toYf(sym, m), qty, after_date: val(f, "after"), expiry: val(f, "expiry") || null, tag: val(f, "tag") || null, note: val(f, "note") || null };
    const btn = g("tk-go"); btn.disabled = true;
    try {
      const parent = await STORE.insert("orders", { ...base, side: s, type: t, price: t === "MARKET" ? null : price, oco_group: null, parent_id: null, stop_ref: s === "BUY" ? (pbOn ? pbStop : (nval(f, "stopref") ?? bstop)) : null, status: "pending",
        ...(pbOn ? { pb: { ...["t1_r", "t1_pct", "t2_r", "t2_pct", "be_r", "ema_len"].reduce((o, k) => (o[k] = +S.settings.playbook[k], o), {}), stop: pbStop } } : {}) });
      const grp = bstop != null && btgt != null ? uuid() : null;
      if (bstop != null && !pbOn) await STORE.insert("orders", { ...base, side: "SELL", type: "STOP", price: bstop, oco_group: grp, parent_id: parent.id, stop_ref: null, status: "waiting", expiry: null });
      if (btgt != null) await STORE.insert("orders", { ...base, side: "SELL", type: "LIMIT", price: btgt, oco_group: grp, parent_id: parent.id, stop_ref: null, status: "waiting", expiry: null });
      await reload(); compute();
      closeAll(() => { OTAB = "open"; goTab("orders"); toast("Order placed. It fills after the next market close."); });
    } catch (x) { btn.disabled = false; errBox(f, errText(x)); }
  };
}
ACT.neworder = () => openTicket();
ACT.tkside = el => { const L = topLayer(); $("#tf", L.el).elements.side.value = el.dataset.v; $("#tf", L.el).dispatchEvent(new Event("change")); };
ACT.tktype = el => { const L = topLayer(); $("#tf", L.el).elements.type.value = el.dataset.v; $("#tf", L.el).dispatchEvent(new Event("change")); };
ACT.tkqty = el => topLayer().setQty(+el.dataset.d * (M === "IN" ? 1 : 1));

/* ------------------------------------------------------------------ Orders tab -- */
const STATUS_PILL = { pending: "brand", waiting: "", filled: "up", cancelled: "", expired: "", rejected: "dn" };
function orderCard(o) {
  const live = o.status === "pending" || o.status === "waiting";
  const px = o.type === "MARKET" ? "Market · next open" : (o.type === "STOP" ? "Stop " : "Limit ") + money(o.price);
  return `<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><div style="display:flex;align-items:center;gap:8px;min-width:0"><span class="pill ${o.side === "BUY" ? "up" : "dn"}">${o.side}</span><b style="font-size:16px">${esc(o.symbol)}</b>
      ${o.parent_id ? '<span class="pill">bracket</span>' : ""}${o.pb ? '<span class="pill brand">playbook</span>' : ""}</div><span class="pill ${STATUS_PILL[o.status] || ""}">${esc(o.status)}</span></div>
    <div class="kv" style="margin-top:10px"><div><small>Quantity</small><b>${num(o.qty)}</b></div><div><small>Price</small><b>${px}</b></div>
      <div><small>Fills after</small><b>${esc(o.after_date)}</b><small>${o.expiry ? "expires " + esc(o.expiry) : ""}</small></div><div><small>${BLK.items[o.id] != null ? "Funds blocked" : "Placed"}</small><b>${BLK.items[o.id] != null ? money(BLK.items[o.id]) : esc((o.created_at || "").slice(0, 10))}</b></div></div>
    ${o.status_note ? `<div class="hint">${esc(o.status_note)}</div>` : ""}
    <div class="btnrow" style="margin-top:12px">${live ? `<button class="btn sm ghost" data-act="editorder" data-id="${o.id}">Modify</button><button class="btn sm danger" data-act="cancelorder" data-id="${o.id}">Cancel order</button>` : `<button class="btn sm danger" data-act="delorder" data-id="${o.id}">Remove</button>`}</div></div>`;
}
function fillCard(f) {
  const val_ = +f.qty * +f.price;
  return `<div class="card"><div style="display:flex;justify-content:space-between;align-items:center"><div style="display:flex;align-items:center;gap:8px"><span class="pill ${f.side === "BUY" ? "up" : "dn"}">${f.side}</span><b style="font-size:16px">${esc(f.symbol)}</b>${f.tag ? `<span class="pill">${esc(f.tag)}</span>` : ""}</div><span class="mut" style="font-size:12.5px">${esc(f.date)}</span></div>
    <div class="kv" style="margin-top:10px"><div><small>Quantity × price</small><b>${num(f.qty)} × ${money(f.price)}</b></div><div><small>Value</small><b>${money(val_)}</b></div>
      <div><small>Charges</small><b>${money(f.fees_total)}</b></div><div><small>Source</small><b>${esc(f.source || "")}</b></div></div>
    <div class="btnrow" style="margin-top:12px"><button class="btn sm ghost" data-act="editfill" data-id="${f.id}">Edit</button><button class="btn sm danger" data-act="delfill" data-id="${f.id}">Delete</button></div></div>`;
}
Views.orders = function () {
  const tabs = [["open", "Open"], ["filled", "Executed"], ["closed", "Closed"]];
  const F = { open: o => o.status === "pending" || o.status === "waiting", closed: o => ["cancelled", "expired", "rejected", "filled"].includes(o.status) && o.status !== "filled" };
  let body;
  if (OTAB === "filled") {
    const fl = S.fills.filter(r => r.portfolio === M).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (a.created_at || "") < (b.created_at || "") ? 1 : -1));
    body = `<button class="btn ghost block" data-act="addfill">${icon("plus")} Add a trade by hand</button>` +
      (fl.length ? fl.map(fillCard).join("") : emptyBox("📄", "No executed orders yet", "Fills appear here after the daily job runs. Misread a price? Add or edit one by hand.")) +
      `<p class="hint">Fix a misread price or quantity with Edit. Positions and P&amp;L recalculate from these records.</p>`;
  } else {
    const list = S.orders.filter(o => o.portfolio === M && F[OTAB](o)).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    body = `<button class="btn brand block" data-act="neworder">${icon("plus")} New order</button>` +
      (list.length ? list.map(orderCard).join("") : emptyBox(OTAB === "open" ? "📋" : "🗂️", OTAB === "open" ? "No open orders" : "Nothing here", OTAB === "open" ? "Orders you place wait here until the next market close, when the daily job fills them." : "Cancelled, expired and rejected orders show here.")) +
      (OTAB === "open" ? `<div class="card note"><b style="color:var(--ink)">How orders fill</b><br>Market fills at the next open. A limit buy fills at the open if it is at or below your price, otherwise at your price if the low reaches it. A stop triggers when the price reaches it; if the stock gaps through, you fill at the open. A buy blocks funds (quantity × price + charges) until it fills, is cancelled or expires. No margin, no short selling.</div>` : "");
  }
  return notices() + `<div class="utabs">${tabs.map(t => `<button role="tab" aria-selected="${OTAB === t[0]}" data-act="otab" data-v="${t[0]}">${t[1]}${t[0] === "open" && livePending().length ? ` (${livePending().length})` : ""}</button>`).join("")}</div>` + body;
};
ACT.otab = el => { OTAB = el.dataset.v; render(); };

ACT.cancelorder = async el => {
  if (!await ask("Cancel this order?", "It will not be filled, and any blocked funds are released.", "Cancel order", true)) return;
  const id = el.dataset.id;
  await STORE.update("orders", id, { status: "cancelled", status_note: "cancelled by you" });
  for (const c of S.orders.filter(x => x.parent_id === id && x.status === "waiting")) await STORE.update("orders", c.id, { status: "cancelled", status_note: "entry order cancelled" });
  await afterWrite(); toast("Order cancelled");
};
ACT.delorder = async el => { if (!await ask("Remove this order?", "It disappears from the list.", "Remove", true)) return; await STORE.remove("orders", el.dataset.id); await afterWrite(); };

ACT.editorder = el => {
  const o = S.orders.find(x => x.id === el.dataset.id), m = M, cur = MKT[m].cur; if (!o) return;
  openSheet(`${sheetHead("Modify order", `${o.side} ${esc(o.symbol)}`)}<form id="ef" class="sheet-in g1" novalidate>
    <div class="g2"><label class="fld"><span>Quantity</span><input name="qty" type="number" inputmode="decimal" step="${m === "IN" ? 1 : "any"}" value="${o.qty}"></label>
      ${o.type === "MARKET" ? "" : `<label class="fld"><span>${o.type === "STOP" ? "Trigger" : "Limit"} price (${cur})</span><input name="price" type="number" inputmode="decimal" step="any" value="${o.price}"></label>`}
      <label class="fld"><span>Fills after</span><input name="after" type="date" value="${esc(o.after_date)}"></label><label class="fld"><span>Expires</span><input name="expiry" type="date" value="${esc(o.expiry || "")}"></label></div>
    <label class="fld"><span>Tag</span><input name="tag" value="${esc(o.tag || "")}"></label><label class="fld"><span>Note</span><input name="note" value="${esc(o.note || "")}"></label>
    <div class="err" role="alert"></div></form><div class="sheet-ft btnrow"><button class="btn ghost" data-act="back">Cancel</button><button class="btn brand" type="submit" form="ef">Save</button></div>`);
  const f = $("#ef", topLayer().el);
  f.onsubmit = async e => {
    e.preventDefault();
    const qty = nval(f, "qty"), price = o.type === "MARKET" ? null : nval(f, "price");
    if (!(qty > 0)) return errBox(f, "Enter a quantity."); if (o.type !== "MARKET" && !(price > 0)) return errBox(f, "Enter a price.");
    if (o.side === "BUY" && o.status === "pending") {
      const rp = o.type === "MARKET" ? refPrice(o.symbol) : price, have = avail() + (BLK.items[o.id] || 0);
      if (rp > 0) { const need = needFor(m, qty, rp); if (need > have + 0.005) return errBox(f, shortMsg(need, have)); }
    }
    try { await STORE.update("orders", o.id, { qty, price, after_date: val(f, "after"), expiry: val(f, "expiry") || null, tag: val(f, "tag") || null, note: val(f, "note") || null }); await afterWrite(); closeTop(); toast("Order updated"); }
    catch (x) { errBox(f, errText(x)); }
  };
};

ACT.setstop = el => {
  const sym = el.dataset.sym, p = ACC.positions.find(x => x.symbol === sym), so = stopOrderFor(sym); if (!p) return;
  openSheet(`${sheetHead(so ? "Move stop" : "Set stop", esc(sym))}<form id="sf" class="sheet-in g1" novalidate>
    <p class="hint" style="margin:0">Sell all ${num(p.qty)} shares if the price falls to the stop. Last close ${money(p.price)}.</p>
    <div class="g2"><label class="fld"><span>Stop price (${MKT[M].cur})</span><input name="price" type="number" inputmode="decimal" step="any" value="${so ? so.price : ""}"></label>
      <label class="fld"><span>Fills after</span><input name="after" type="date" value="${so ? esc(so.after_date) : esc(lastSession())}"></label></div><div class="err" role="alert"></div></form>
    <div class="sheet-ft btnrow"><button class="btn ghost" data-act="back">Cancel</button><button class="btn brand" type="submit" form="sf">Save stop</button></div>`);
  const f = $("#sf", topLayer().el);
  f.onsubmit = async e => {
    e.preventDefault(); const px = nval(f, "price");
    if (!(px > 0)) return errBox(f, "Enter a stop price."); if (px >= p.price) return errBox(f, "A stop sits below the current price; otherwise it would trigger immediately.");
    try {
      if (so) await STORE.update("orders", so.id, { price: px, qty: p.qty, after_date: val(f, "after") });
      else await STORE.insert("orders", { portfolio: M, symbol: sym, yf: p.yf, side: "SELL", type: "STOP", qty: p.qty, price: px, after_date: val(f, "after"), expiry: null, oco_group: null, parent_id: null, stop_ref: null, tag: p.tag || null, note: null, status: "pending" });
      await afterWrite(); closeTop(); toast("Stop saved");
    } catch (x) { errBox(f, errText(x)); }
  };
};

/* ---------------------------------------------------------- executed orders -- */
function fillSheet(fl) {
  const m = M, isNew = !fl, sel = isNew ? { side: "BUY", date: today() } : fl, cur = MKT[m].cur;
  openSheet(`${sheetHead(isNew ? "Add a trade by hand" : "Edit executed order")}<form id="xf" class="sheet-in g1" novalidate>
    <div class="g2"><label class="fld"><span>Symbol</span><input name="sym" ${isNew ? "" : "readonly"} autocapitalize="characters" value="${esc(sel.symbol || "")}"></label>
      <label class="fld"><span>Side</span><select name="side" ${isNew ? "" : "disabled"}><option ${sel.side === "BUY" ? "selected" : ""}>BUY</option><option ${sel.side === "SELL" ? "selected" : ""}>SELL</option></select></label>
      <label class="fld"><span>Date</span><input name="date" type="date" value="${esc(sel.date)}"></label>
      <label class="fld"><span>Quantity</span><input name="qty" type="number" inputmode="decimal" step="${m === "IN" ? 1 : "any"}" value="${sel.qty || ""}"></label>
      <label class="fld"><span>Price (${cur})</span><input name="price" type="number" inputmode="decimal" step="any" value="${sel.price || ""}"></label>
      <label class="fld"><span>Planned stop (buys)</span><input name="stopref" type="number" inputmode="decimal" step="any" value="${sel.stop_ref || ""}"></label></div>
    <label class="fld"><span>Tag</span><input name="tag" value="${esc(sel.tag || "")}"></label><label class="fld"><span>Note</span><input name="note" value="${esc(sel.note || "")}"></label>
    <label class="chk"><input type="checkbox" name="recalc" checked><span>Recalculate charges from Settings</span></label>
    <label class="fld" id="l-fee" hidden><span>Charges (${cur})</span><input name="fee" type="number" inputmode="decimal" step="any" value="${sel.fees_total != null ? sel.fees_total : ""}"></label>
    <div class="brk" id="brk" hidden></div><div class="err" role="alert"></div></form>
    <div class="sheet-ft btnrow"><button class="btn ghost" data-act="back">Cancel</button><button class="btn brand" type="submit" form="xf">Save</button></div>`);
  const L = topLayer(), f = $("#xf", L.el);
  const dpOK = () => !S.fills.some(x => x.portfolio === m && x.side === "SELL" && x.symbol === val(f, "sym").toUpperCase() && x.date === val(f, "date") && (!fl || x.id !== fl.id) && x.fees && x.fees.dp > 0);
  const calc = () => {
    $("#l-fee", L.el).hidden = f.elements.recalc.checked;
    const q = +val(f, "qty"), p = +val(f, "price"), b = $("#brk", L.el); if (!(q > 0 && p > 0)) { b.hidden = true; return null; }
    const side = isNew ? f.elements.side.value : fl.side, fee = PC.tradeFees(m, side, q, p, S.settings, dpOK(), val(f, "date") || undefined);
    b.hidden = false; b.innerHTML = `<div><span>Value</span><span>${money(q * p)}</span></div>` + Object.keys(fee).filter(k => k !== "total" && fee[k]).map(k => `<div><span>${k}</span><span>${money(fee[k])}</span></div>`).join("") + `<div class="tot"><span>Charges</span><span>${money(fee.total)}</span></div>`;
    return fee;
  };
  f.addEventListener("input", calc); f.addEventListener("change", calc); calc();
  f.onsubmit = async e => {
    e.preventDefault();
    const sym = val(f, "sym").toUpperCase().replace(/\.NS$/, ""), q = nval(f, "qty"), p = nval(f, "price"), side = isNew ? f.elements.side.value : fl.side;
    if (!sym) return errBox(f, "Enter a symbol."); if (!(q > 0) || !(p > 0)) return errBox(f, "Enter a quantity and a price."); if (!val(f, "date")) return errBox(f, "Pick a date.");
    if (m === "IN" && !Number.isInteger(q)) return errBox(f, "Indian shares trade in whole numbers.");
    let fees = calc(); if (!f.elements.recalc.checked) { const t = nval(f, "fee"); if (t == null || t < 0) return errBox(f, "Enter the charges."); fees = { total: t, custom: true }; }
    const row = { portfolio: m, symbol: sym, yf: isNew ? toYf(sym, m) : fl.yf, side, qty: q, price: p, date: val(f, "date"), fees, fees_total: fees.total, stop_ref: side === "BUY" ? nval(f, "stopref") : null, tag: val(f, "tag") || null, note: val(f, "note") || null };
    try {
      if (isNew) await STORE.insert("fills", { ...row, order_id: null, source: "manual" }); else await STORE.update("fills", fl.id, { ...row, source: fl.source === "manual" ? "manual" : "edited" });
      await afterWrite(); closeTop(); toast("Saved");
    } catch (x) { errBox(f, errText(x)); }
  };
}
ACT.addfill = () => fillSheet();
ACT.editfill = el => fillSheet(S.fills.find(x => x.id === el.dataset.id));
ACT.delfill = async el => {
  const fl = S.fills.find(x => x.id === el.dataset.id); if (!fl) return;
  if (!await ask("Delete this trade?", `${fl.side} ${num(fl.qty)} ${esc(fl.symbol)} on ${esc(fl.date)}. Positions and P&amp;L will recalculate.`, "Delete", true)) return;
  await STORE.remove("fills", fl.id);
  if (fl.order_id) { try { await STORE.update("orders", fl.order_id, { status: "cancelled", status_note: "its fill was deleted" }); } catch (x) {} }
  await afterWrite(); toast("Trade deleted");
};
