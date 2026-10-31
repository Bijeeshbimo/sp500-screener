/* More tab, funds (add / withdraw / history), settings, backup. */
"use strict";
const APP_VERSION = "1.0";

const menuRow = (ic, title, sub, act, extra) => `<button class="row" data-act="${act}"${extra || ""}><div class="ic">${icon(ic)}</div><div class="mid"><b>${title}</b>${sub ? `<small>${sub}</small>` : ""}</div>${icon("chev", "chev")}</button>`;

Views.more = function () {
  const email = STORE.mode === "cloud" ? STORE.email() : "Demo mode";
  const th = ls.get("bd-theme") || "auto";
  return notices() + `<div class="card"><div class="who"><div class="av2">${esc(initials(email === "Demo mode" ? "D" : email))}</div><div><b style="font-size:16px">${esc(email)}</b><div class="mut" style="font-size:12.5px">${STORE.mode === "cloud" ? "Synced across your devices" : "Saved on this phone only"}</div></div></div></div>
    <div class="card flush menu">${menuRow("wallet", "Funds", `Add, withdraw and review deposits`, "openfunds")}${menuRow("gear", "Charges &amp; settings", "Dhan-style fees, risk per trade, playbook", "opensettings")}${menuRow("refresh", "Check for new data", NEWDATA ? "New data is available" : "Screener data as of " + esc(MD[M] ? MD[M].meta.date : "–"), "refresh")}${menuRow("download", "Back up my data", "Copy or save a JSON backup", "backup")}${menuRow("info", "About &amp; disclaimer", "Version " + APP_VERSION, "about")}
      ${STORE.mode === "cloud" ? menuRow("logout", "Sign out", "", "signout") : ""}</div>
    <div class="card"><div class="mut" style="font-size:12px;font-weight:600;margin-bottom:8px">Appearance</div><div class="seg" style="display:flex">${[["auto", "Auto"], ["light", "Light"], ["dark", "Dark"]].map(t => `<button style="flex:1" data-act="theme" data-v="${t[0]}" aria-pressed="${th === t[0]}">${t[1]}</button>`).join("")}</div></div>`;
};
ACT.theme = el => { ls.set("bd-theme", el.dataset.v); applyTheme(); render(); };
ACT.signout = async () => { if (await ask("Sign out?", "You will need your email and password to get back in.", "Sign out", true)) await STORE.signOut(); };
ACT.about = () => openSheet(`${sheetHead("About Breakout Desk")}<div class="sheet-in"><p style="margin:0">A practice (paper) trading app beside your breakout screener. It reads the daily screener results from your GitHub Pages site and keeps your practice account in Firebase, the same account as the paper-trading web page.</p>
  <p class="hint">Simulation only. Orders are filled from end-of-day prices (Yahoo Finance via yfinance, unofficial) by a daily job after each market closes. A real broker's fills, slippage, circuit limits and charges will differ. Charges follow Dhan's published delivery pricing and are editable in Settings. For practice and record keeping, not investment advice.</p>
  <p class="hint">This app is independent. It only borrows the general look of broker apps and is not made by or connected to any broker.</p></div>`);
ACT.backup = () => {
  const json = JSON.stringify({ exported: new Date().toISOString(), ledger: S.ledger, orders: S.orders, fills: S.fills, settings: S.settings }, null, 1);
  openSheet(`${sheetHead("Back up my data")}<div class="sheet-in"><p class="hint" style="margin:0">Copy this and paste it into a note or email to yourself, or save it as a file.</p><label class="fld"><textarea id="bk" readonly style="height:150px;padding:10px;font-size:12px;font-family:monospace">${esc(json)}</textarea></label>
    <div class="btnrow"><button class="btn brand" data-act="bkcopy">Copy</button><button class="btn ghost" data-act="bkfile">Save file</button></div></div>`).json = json;
};
ACT.bkcopy = async () => { const ta = $("#bk"); try { await navigator.clipboard.writeText(ta.value); toast("Copied"); } catch (e) { ta.select(); document.execCommand && document.execCommand("copy"); toast("Copied"); } };
ACT.bkfile = () => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([topLayer().json], { type: "application/json" })); a.download = "breakout-desk-backup-" + today() + ".json"; a.click(); };
ACT.refresh = async el => {
  const btn = $("#refresh-btn"); if (btn) btn.classList.add("spin");
  try { await reloadData(); compute(); render(); refreshLayers(); toast("Up to date"); } catch (e) { toast("Could not refresh: " + errText(e)); }
  if (btn) btn.classList.remove("spin");
};

/* ------------------------------------------------------------------- funds -- */
function fundsHtml() {
  const lg = S.ledger.filter(r => r.portfolio === M).sort((a, b) => (a.date < b.date ? 1 : -1));
  let lrs = "";
  if (M === "US") {
    const fy = PC.fyOf(today()), used = S.ledger.filter(r => r.portfolio === "US" && r.kind === "deposit" && PC.fyOf(r.date) === fy).reduce((x, r) => x + (+r.inr || 0), 0);
    lrs = `<div class="card note"><b style="color:var(--ink)">Sent abroad this financial year</b> (Apr ${fy} – Mar ${fy + 1})<br>${money(used, "IN", 0)} of ₹10,00,000 before 20% TCS applies. Your bank collects TCS and it is adjustable in your income tax return.</div>`;
  }
  const rows = lg.map(r => {
    const mt = r.meta || {};
    const det = M === "US" && r.kind === "deposit" ? `${money(r.inr, "IN", 2)} at ₹${num(mt.rate, 4)}${mt.tcs ? " · TCS ₹" + num(mt.tcs, 2) : ""}` : esc(r.note || "");
    return `<div class="row"><div class="av" style="${r.kind === "deposit" ? "" : "background:var(--dn-soft);color:var(--dn)"}">${r.kind === "deposit" ? "+" : "−"}</div><div class="mid"><b>${r.kind === "deposit" ? "Deposit" : "Withdrawal"}</b><small>${esc(r.date)}${det ? " · " + det : ""}</small></div>
      <div class="end"><b class="${r.kind === "deposit" ? "up" : "dn"}">${r.kind === "deposit" ? "+" : "−"}${money(r.amount)}</b><small><span class="lnk" data-act="editfund" data-id="${r.id}">Edit</span> &nbsp; <span class="lnk" style="color:var(--dn)" data-act="delfund" data-id="${r.id}">Delete</span></small></div></div>`;
  }).join("");
  return pageHead("Funds", MKT[M].name + " portfolio") + `<div class="page-in"><div class="card"><div class="kv"><div><small>Cash</small><b>${money(ACC.cash)}</b></div><div><small>Available to trade</small><b>${money(avail())}</b></div>
      <div><small>Blocked on orders</small><b>${money(BLK.total)}</b></div><div><small>Net deposits</small><b>${money(ACC.netDeposits)}</b></div></div></div>${lrs}
    ${lg.length ? `<div class="card flush">${rows}</div>` : emptyBox("💰", "No deposits yet", "Add pretend funds to start.")}</div>
    <div class="page-ft"><button class="btn ghost" data-act="withdraw">Withdraw</button><button class="btn brand" data-act="addfunds">Add funds</button></div>`;
}
ACT.openfunds = () => { const L = openPage(fundsHtml()); L.opts.render = () => { L.el.querySelector(".page-body").innerHTML = fundsHtml(); }; };

const quickChips = () => `<div class="chips">${[10000, 25000, 50000, 100000].map(v => `<button type="button" class="chip" data-act="quick" data-v="${v}">+ ₹${v.toLocaleString("en-IN")}</button>`).join("")}</div>`;
ACT.quick = el => { const i = $("#ff2", topLayer().el).elements[M === "IN" ? "amt" : "inr"]; i.value = (+i.value || 0) + +el.dataset.v; i.dispatchEvent(new Event("input", { bubbles: true })); };

function addFundsSheet(existing) {
  const m = M;
  if (m === "IN") {
    openSheet(`${sheetHead(existing ? "Edit deposit" : "Add funds", "India · rupees")}<form id="ff2" class="sheet-in g1" novalidate>
      <label class="fld"><span>Amount (₹)</span><input name="amt" type="number" step="any" inputmode="decimal" value="${existing ? existing.amount : ""}" style="font-size:22px;height:56px"></label>${existing ? "" : quickChips()}
      <label class="fld"><span>Date</span><input name="date" type="date" value="${existing ? existing.date : today()}"></label><label class="fld"><span>Note</span><input name="note" value="${esc(existing ? existing.note : "")}"></label>
      <div class="err" role="alert"></div></form><div class="sheet-ft"><button class="btn brand block" type="submit" form="ff2">${existing ? "Save" : "Add funds"}</button></div>`);
    const f = $("#ff2", topLayer().el);
    f.onsubmit = async e => {
      e.preventDefault(); const a = nval(f, "amt"); if (!(a > 0)) return errBox(f, "Enter an amount."); if (!val(f, "date")) return errBox(f, "Pick a date.");
      try { const row = { portfolio: "IN", kind: "deposit", date: val(f, "date"), amount: a, inr: a, note: val(f, "note") || null, meta: {} };
        if (existing) await STORE.update("ledger", existing.id, row); else await STORE.insert("ledger", row);
        await afterWrite(); closeTop(); toast("Funds added"); } catch (x) { errBox(f, errText(x)); }
    };
    return;
  }
  const ex = existing && existing.meta || {}, ref = FX ? FX.usdinr : null;
  const defRate = ref ? PC.defaultRate(ref, S.settings) : PC.defaultRate(S.settings.fx.fallback_rate, S.settings);
  openSheet(`${sheetHead(existing ? "Edit deposit" : "Add funds", "US stocks · enter rupees, get dollars")}<form id="ff2" class="sheet-in g1" novalidate>
    <label class="fld"><span>Amount to send (₹)</span><input name="inr" type="number" step="any" inputmode="decimal" value="${existing ? existing.inr : ""}" style="font-size:22px;height:56px"></label>${existing ? "" : quickChips()}
    <div class="g2"><label class="fld"><span>Exchange rate (₹ per $)</span><input name="rate" type="number" step="any" inputmode="decimal" value="${existing ? ex.rate : defRate}"></label><label class="fld"><span>Date</span><input name="date" type="date" value="${existing ? existing.date : today()}"></label>
      <label class="fld"><span>GST (₹)</span><input name="gst" type="number" step="any" inputmode="decimal" placeholder="auto" value="${existing && ex.gst_manual ? ex.gst : ""}"></label>
      <label class="fld"><span>Bank charge (₹)</span><input name="bank" type="number" step="any" inputmode="decimal" placeholder="auto" value="${existing && ex.bank_manual ? ex.bank : ""}"></label>
      <label class="fld"><span>Pay-in charge ($)</span><input name="payin" type="number" step="any" inputmode="decimal" placeholder="auto" value="${existing && ex.payin_manual ? ex.payin_fee_usd : ""}"></label></div>
    <p class="hint" style="margin:0">${existing ? "Rate shown is the one saved with this deposit." : (ref ? `Rate pre-filled from the USD/INR close of ${esc(FX.date)} (₹${ref}) plus a ${S.settings.fx.markup_pct}% markup.` : "Rate pre-filled from your fallback rate.")} Type over the rate or any charge to match what Dhan shows; leave a charge blank to calculate it.</p>
    <label class="chk"><input type="checkbox" name="tcs" ${ex.tcs || S.settings.fx.tcs_enabled ? "checked" : ""}><span>Include TCS (20% above ₹10 lakh sent this financial year)</span></label>
    <div class="brk" id="brk"></div><label class="fld"><span>Note</span><input name="note" value="${esc(existing ? existing.note : "")}"></label><div class="err" role="alert"></div></form>
    <div class="sheet-ft"><button class="btn brand block" type="submit" form="ff2">${existing ? "Save" : "Add funds"}</button></div>`);
  const L = topLayer(), f = $("#ff2", L.el); let last = null;
  const calc = () => {
    const d = val(f, "date") || today(), fy = PC.fyOf(d);
    const before = S.ledger.filter(r => r.portfolio === "US" && r.kind === "deposit" && PC.fyOf(r.date) === fy && r.date <= d && (!existing || r.id !== existing.id)).reduce((x, r) => x + (+r.inr || 0), 0);
    const ov = n => (val(f, n) === "" ? null : val(f, n));
    last = PC.fundCalc({ inr: val(f, "inr"), rate: val(f, "rate"), gst: ov("gst"), bank: ov("bank"), payin: ov("payin"), settings: S.settings, applyTcs: f.elements.tcs.checked, fyRemittedBefore: before });
    const b = $("#brk", L.el), r = last;
    if (!r.ok) { b.innerHTML = `<span class="mut">${esc(r.error)}</span>`; return; }
    f.elements.gst.placeholder = "auto ₹" + r.gst; f.elements.bank.placeholder = "auto ₹" + r.bank; f.elements.payin.placeholder = "auto $" + r.payin_fee_usd;
    const R = (k, v, c) => `<div class="${c || ""}"><span>${k}</span><span>${v}</span></div>`;
    b.innerHTML = R("Amount sent", money(r.inr, "IN")) + R("Exchange rate", "₹" + num(r.rate, 4) + " per $") + R("GST on conversion", money(r.gst, "IN")) + (r.bank ? R("Bank charge", money(r.bank, "IN")) : "") +
      R("Converted", "$" + r.gross_usd.toLocaleString("en-US", { minimumFractionDigits: 2 })) + R("Pay-in charge", "$" + r.payin_fee_usd.toFixed(2)) +
      (r.tcs ? R("TCS (collected by your bank)", money(r.tcs, "IN")) + R("Total out of your bank", money(r.total_inr_out, "IN")) : "") +
      R("Credited to your US wallet", "$" + r.net_usd.toLocaleString("en-US", { minimumFractionDigits: 2 }), "tot") + R("Effective cost per dollar", "₹" + r.effective_rate.toFixed(2));
  };
  f.addEventListener("input", calc); f.addEventListener("change", calc); calc();
  f.onsubmit = async e => {
    e.preventDefault(); calc(); if (!last.ok) return errBox(f, last.error); if (!val(f, "date")) return errBox(f, "Pick a date.");
    const meta = { rate: last.rate, gst: last.gst, gst_manual: val(f, "gst") !== "", bank: last.bank, bank_manual: val(f, "bank") !== "", payin_fee_usd: last.payin_fee_usd, payin_manual: val(f, "payin") !== "", gross_usd: last.gross_usd, tcs: last.tcs, effective_rate: last.effective_rate };
    try { const row = { portfolio: "US", kind: "deposit", date: val(f, "date"), amount: last.net_usd, inr: last.inr, note: val(f, "note") || null, meta };
      if (existing) await STORE.update("ledger", existing.id, row); else await STORE.insert("ledger", row);
      await afterWrite(); closeTop(); toast("Funds added"); } catch (x) { errBox(f, errText(x)); }
  };
}
ACT.addfunds = () => addFundsSheet();
ACT.withdraw = () => {
  openSheet(`${sheetHead("Withdraw", MKT[M].name + " portfolio")}<form id="wf" class="sheet-in g1" novalidate>
    <label class="fld"><span>Amount (${MKT[M].cur})</span><input name="amt" type="number" step="any" inputmode="decimal" style="font-size:22px;height:56px"></label>
    <label class="fld"><span>Date</span><input name="date" type="date" value="${today()}"></label>
    <p class="hint" style="margin:0">Available to withdraw: ${money(avail())}${BLK.total ? ` (cash ${money(ACC.cash)}, ${money(BLK.total)} blocked on pending orders)` : ""}. ${M === "US" ? "Withdrawals from Dhan US Stocks are free." : ""}</p>
    <label class="fld"><span>Note</span><input name="note"></label><div class="err" role="alert"></div></form><div class="sheet-ft"><button class="btn brand block" type="submit" form="wf">Withdraw</button></div>`);
  const f = $("#wf", topLayer().el);
  f.onsubmit = async e => {
    e.preventDefault(); const a = nval(f, "amt"); if (!(a > 0)) return errBox(f, "Enter an amount.");
    if (a > avail() + 0.005) return errBox(f, "That is more than the available funds" + (BLK.total ? " (some cash is blocked on pending orders)." : "."));
    try { await STORE.insert("ledger", { portfolio: M, kind: "withdrawal", date: val(f, "date") || today(), amount: a, inr: M === "IN" ? a : null, note: val(f, "note") || null, meta: {} }); await afterWrite(); closeTop(); toast("Withdrawal recorded"); } catch (x) { errBox(f, errText(x)); }
  };
};
ACT.editfund = el => {
  const r = S.ledger.find(x => x.id === el.dataset.id); if (!r) return;
  if (r.kind === "deposit") return addFundsSheet(r);
  openSheet(`${sheetHead("Edit withdrawal")}<form id="wf" class="sheet-in g1" novalidate><label class="fld"><span>Amount</span><input name="amt" type="number" step="any" inputmode="decimal" value="${r.amount}"></label><label class="fld"><span>Date</span><input name="date" type="date" value="${r.date}"></label><label class="fld"><span>Note</span><input name="note" value="${esc(r.note || "")}"></label><div class="err" role="alert"></div></form><div class="sheet-ft"><button class="btn brand block" type="submit" form="wf">Save</button></div>`);
  const f = $("#wf", topLayer().el);
  f.onsubmit = async e => { e.preventDefault(); const a = nval(f, "amt"); if (!(a > 0)) return errBox(f, "Enter an amount.");
    try { await STORE.update("ledger", r.id, { amount: a, date: val(f, "date"), note: val(f, "note") || null }); await afterWrite(); closeTop(); } catch (x) { errBox(f, errText(x)); } };
};
ACT.delfund = async el => {
  const r = S.ledger.find(x => x.id === el.dataset.id); if (!r) return;
  const without = PC.buildAccount(S.ledger.filter(x => x.portfolio === M && x.id !== r.id), S.fills.filter(x => x.portfolio === M), PM, MKT[M].bench);
  if (r.kind === "deposit" && without.cash < -0.005) return toast("Deleting this deposit would leave cash negative.");
  if (!await ask("Delete this " + r.kind + "?", money(r.amount) + " on " + esc(r.date), "Delete", true)) return;
  await STORE.remove("ledger", r.id); await afterWrite();
};

/* ---------------------------------------------------------------- settings -- */
const SLAB = {
  in: { brokerage_pct: "Brokerage (% of value)", stt_pct: "STT (% of value, buy and sell)", stamp_buy_pct: "Stamp duty (% of value, buy)", exch_pct: "Exchange charges (% of value)", sebi_pct: "SEBI fee (% of value)", gst_pct: "GST (% on brokerage, exchange and SEBI)", dp_charge: "DP charge per stock per sell day (₹, before GST)", slippage_bps: "Slippage on market/stop fills (basis points)" },
  us: { brokerage_pct: "Brokerage (% of value, from 26 Oct 2026)", legacy_brokerage_pct: "Brokerage before 26 Oct 2026 (%)", min_brokerage: "Minimum brokerage per order ($)", max_brokerage: "Maximum brokerage per order ($)", exch_pct: "Exchange charges (% of value)", gst_pct: "GST (% on brokerage)", other_pct: "Other regulatory fees (% of value)", slippage_bps: "Slippage on market/stop fills (basis points)" },
  playbook: { t1_r: "First target (R multiple)", t1_pct: "Sell at the first target (% of position)", t2_r: "Second target (R multiple)", t2_pct: "Sell at the second target (% of position)", be_r: "Move the stop to cost at (R)", ema_len: "Sell the rest on a close below this EMA (days)" },
  risk: { in: "Default risk per trade (₹)", us: "Default risk per trade ($)" },
  fx: { markup_pct: "FX markup over the reference rate (%)", gst_pct_of_inr: "GST on conversion (% of the INR sent)", bank_charge_inr: "Bank / wire charge per top-up (₹)", payin_fee_usd: "Pay-in fee when under the free limit ($)", payin_free_from_usd: "Pay-in free from ($)", tcs_rate_pct: "TCS rate (%)", tcs_threshold_inr: "TCS threshold per financial year (₹)", fallback_rate: "Fallback USD/INR rate" },
};
const GTITLE = { in: "India trades (Dhan equity delivery)", us: "US trades (Dhan US Stocks)", fx: "Adding US funds (INR to USD)", risk: "Position sizing", playbook: "Profit-booking playbook" };
function settingsHtml() {
  const st = S.settings, grp = g => `<div class="sec"><h2>${GTITLE[g]}</h2></div><div class="card g1">${Object.keys(SLAB[g]).map(k => `<label class="fld"><span>${SLAB[g][k]}</span><input data-s="${g}.${k}" type="number" step="any" inputmode="decimal" value="${st[g][k]}"></label>`).join("")}
    ${g === "playbook" ? `<label class="chk"><input type="checkbox" data-s="playbook.default_on" ${st.playbook.default_on ? "checked" : ""}><span>Tick the playbook by default on new buy orders</span></label><p class="hint" style="margin:0">1R is your entry minus your initial stop. After the entry fills, the daily job sells the first slice at the first target and the second at the second target, moves the stop to cost once price reaches the stop-to-cost level (from the next session), then sells the rest on the first close below the EMA at the next open.</p>` : ""}
    ${g === "fx" ? `<label class="chk"><input type="checkbox" data-s="fx.tcs_enabled" ${st.fx.tcs_enabled ? "checked" : ""}><span>Add TCS to new US top-ups when over the threshold</span></label>` : ""}</div>`;
  return pageHead("Charges & settings") + `<div class="page-in"><div class="card note">Starting values follow Dhan's published pricing. Past trades and top-ups keep the charges they were saved with; changing a rate only affects new ones (or a fill you edit).</div>
    <div class="sec"><h2>Data source</h2></div><div class="card g1"><label class="fld"><span>GitHub Pages address (where the daily screener data is read from)</span><input id="db" type="url" inputmode="url" value="${esc(ls.get("bd-data-base") || dataBase())}" autocapitalize="off"></label>
      <p class="hint" style="margin:0">Only change this if your site address is different. Leave it as it is otherwise.</p></div>
    ${grp("playbook")}${grp("in")}${grp("us")}${grp("fx")}${grp("risk")}
    <div class="sec"><h2>Order engine</h2></div><div class="card"><label class="fld"><span>If a stop and a target could both trigger in one session, assume</span><select data-s="engine.same_bar_priority"><option value="stop"${st.engine.same_bar_priority === "stop" ? " selected" : ""}>the stop hit first (conservative)</option><option value="target"${st.engine.same_bar_priority === "target" ? " selected" : ""}>the target hit first</option></select></label></div></div>
    <div class="page-ft"><button class="btn ghost" data-act="resetsettings">Reset</button><button class="btn brand" data-act="savesettings">Save settings</button></div>`;
}
ACT.opensettings = () => { openPage(settingsHtml()); };
ACT.savesettings = async () => {
  const L = topLayer(), out = PC.mergeSettings(S.settings);
  $$("[data-s]", L.el).forEach(el => { const [g, k] = el.dataset.s.split("."); out[g][k] = el.type === "checkbox" ? el.checked : el.tagName === "SELECT" ? el.value : (el.value === "" ? out[g][k] : +el.value); });
  const db = $("#db", L.el).value.trim(), cur = ls.get("bd-data-base") || "";
  await STORE.saveSettings(out);
  if (db && db !== dataBase() && db !== cur) { ls.set("bd-data-base", db); MD = {}; loadMarket(M, true).then(() => { render(); }).catch(() => {}); }
  await afterWrite(); toast("Settings saved");
};
ACT.resetsettings = async () => {
  if (!await ask("Reset every rate?", "Charges, playbook and risk settings go back to the defaults.", "Reset", true)) return;
  await STORE.saveSettings({}); await afterWrite(); closeAll(() => toast("Defaults restored"));
};
