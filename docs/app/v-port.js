/* Portfolio tab: positions, closed trades, and the performance dashboard (all numbers come from PaperCore). */
"use strict";
let PTAB = ls.get("bd-ptab") || "pos", DAYMODE = ls.get("bd-daymode") === "1";

function holdingRow(p) {
  const dc = dayChange(p), si = stopInfo(p), shown = DAYMODE ? (dc || { abs: null, pct: null }) : { abs: p.pnl, pct: p.pct };
  const stopTxt = si.stop != null ? `Stop ${money(si.stop)}${si.dist != null ? ` · ${si.dist.toFixed(1)}% below` : ""}` : `<span class="warn">No stop set</span>`;
  return `<button class="row" data-act="stock" data-sym="${esc(p.symbol)}" style="align-items:flex-start">
    <div class="av">${esc(initials(p.symbol))}</div>
    <div class="mid"><b>${esc(p.symbol)}</b><small>${num(p.qty)} × ${money(p.avg)} · ${p.days}d</small><small>${stopTxt}</small></div>
    <div class="end"><b>${money(p.price)}</b><small class="mut" style="font-weight:500">Value ${money(p.value, M, 0)}</small>
      <small class="${sgn(shown.abs)}">${shown.abs == null ? "–" : sgnm(shown.abs) + " (" + pct(shown.pct) + ")"}</small></div></button>`;
}

function portPositions() {
  const a = ACC;
  if (!a.positions.length) return emptyBox("💼", "No open positions", hasMoney() ? "Find a breakout in the Screener and place a paper order." : "Add funds, then place your first paper order.", hasMoney() ? `<button class="btn brand" data-act="tab" data-v="scan">Open screener</button>` : `<button class="btn brand" data-act="addfunds">Add funds</button>`);
  const dt = dayTotal();
  const P = a.positions.map(p => ({ p, dc: dayChange(p) })).sort((x, y) => DAYMODE ? ((y.dc ? y.dc.abs : -Infinity) - (x.dc ? x.dc.abs : -Infinity)) : y.p.pnl - x.p.pnl).map(x => x.p);
  const cash = Math.max(0, a.cash), colors = ["#4f3ff0", "#0a9a6a", "#e69a00", "#e5484d", "#4f8cff", "#a35ef0", "#17a3b8", "#8d96b5"];
  const parts = a.positions.slice(0, 6).map((p, i) => ({ name: p.symbol, value: p.value, color: colors[i] }));
  const rest = a.positions.slice(6).reduce((t, p) => t + p.value, 0); if (rest > 0) parts.push({ name: "Others", value: rest, color: colors[6] });
  parts.push({ name: "Cash", value: cash, color: "var(--line)" });
  return `<div class="card"><div class="kv"><div><small>Current value</small><b>${money(a.invested)}</b></div><div><small>${DAYMODE ? "Day P&amp;L" : "Unrealized P&amp;L"}</small>
      <b class="${DAYMODE ? sgn(dt && dt.abs) : sgn(a.unrealized)}">${DAYMODE ? (dt ? sgnm(dt.abs) + " (" + pct(dt.pct) + ")" : "–") : sgnm(a.unrealized)}</b></div></div>
    ${Charts.stack(parts)}</div>
    <div class="chips"><button class="chip" aria-pressed="${!DAYMODE}" data-act="daymode" data-v="0">Overall</button><button class="chip" aria-pressed="${DAYMODE}" data-act="daymode" data-v="1">Day change</button></div>
    <div class="card flush">${P.map(holdingRow).join("")}</div>
    <p class="hint">Average cost includes buying charges. Prices are last closes and update after each market closes. Tap a position for its chart, stop and Sell.</p>`;
}

function portClosed() {
  const a = ACC, tr = a.trades.slice().sort((x, y) => (x.exitDate < y.exitDate ? 1 : -1)), s = a.stats;
  if (!tr.length) return emptyBox("🧾", "No closed trades yet", "Sells that close shares (first in, first out) appear here with their net P&L and R-multiple.");
  return `<div class="card"><div class="kv"><div><small>Realized P&amp;L</small><b class="${sgn(a.realized)}">${sgnm(a.realized)}</b></div><div><small>Closed trades</small><b>${s.n}${s.winRate != null ? ` · ${s.winRate.toFixed(0)}% win` : ""}</b></div></div></div>` +
    tr.map(t => `<div class="card"><div style="display:flex;justify-content:space-between;align-items:center"><div style="display:flex;gap:8px;align-items:center"><b style="font-size:16px">${esc(t.symbol)}</b>${t.partial ? '<span class="pill">partial</span>' : ""}${t.tag ? `<span class="pill">${esc(t.tag)}</span>` : ""}</div><span class="mut" style="font-size:12.5px">${esc(t.exitDate)}</span></div>
      <div class="kv" style="margin-top:10px"><div><small>Net P&amp;L</small><b class="${sgn(t.pnl)}">${sgnm(t.pnl)} (${pct(t.pct)})</b></div><div><small>Quantity</small><b>${num(t.qty)}</b></div>
        <div><small>Entry → exit</small><b>${money(t.entry)} → ${money(t.exit)}</b></div><div><small>Held · R</small><b>${t.days.toFixed(0)}d · ${t.r == null ? "–" : t.r.toFixed(2) + "R"}</b></div></div></div>`).join("") +
    `<p class="hint">Entry includes buying charges and exit is after selling charges, so P&amp;L is what you would keep before tax. R needs a planned stop on the buy.</p>`;
}

function backtestHtml() {
  const pb = S.settings.playbook, cfg = { t1_r: +pb.t1_r, t1_pct: +pb.t1_pct, t2_r: +pb.t2_r, t2_pct: +pb.t2_pct, be_r: +pb.be_r, ema_len: +pb.ema_len };
  const variants = [{ name: `Your playbook (${cfg.t1_pct}% at ${cfg.t1_r}R, ${cfg.t2_pct}% at ${cfg.t2_r}R, cost at ${cfg.be_r}R)`, cfg },
    { name: `Same, but stop to cost at ${cfg.be_r === 2 ? 3 : 2}R`, cfg: { ...cfg, be_r: cfg.be_r === 2 ? 3 : 2 } },
    { name: "No partial sells (stop to cost, then the EMA exit)", cfg: { ...cfg, t1_pct: 0, t2_pct: 0 } }];
  const bt = PC.playbookBacktest(S.fills.filter(f => f.portfolio === M), CANDLES, S.settings, variants);
  const head = `<div class="sec"><h2>Playbook vs what you did</h2></div>`;
  if (!bt.rows.length) return head + `<div class="card note">Nothing to compare yet. This replays the playbook on your <b>closed</b> buys that had a planned stop, using the daily price history the daily job saves.${bt.skipped ? ` ${bt.skipped} closed buy(s) were left out (no planned stop, or no price history yet).` : ""}</div>`;
  return head + `<div class="card flush"><div class="row"><div class="mid"><b>What you actually did</b></div><div class="end"><b class="${sgn(bt.actual)}">${sgnm(bt.actual)}</b></div></div>` +
    variants.map((v, i) => `<div class="row"><div class="mid"><small style="white-space:normal;color:var(--ink)">${esc(v.name)}</small></div><div class="end"><b class="${sgn(bt.totals[i])}">${sgnm(bt.totals[i])}</b><small class="${sgn(bt.totals[i] - bt.actual)}">${sgnm(bt.totals[i] - bt.actual)} vs yours</small></div></div>`).join("") + `</div>
    <p class="hint">${bt.rows.length} closed buy(s) replayed on daily candles using the same rules the daily job applies. A month of trades is a small sample, so treat this as a sanity check on the rules, not proof. Daily candles cannot show what happened inside a day.</p>`;
}

function portDash() {
  if (!hasMoney()) return emptyBox("📊", "No money in this portfolio yet", "Add funds to start tracking performance.", `<button class="btn brand" data-act="addfunds">Add funds</button>`);
  const a = ACC, s = a.stats, c = a.curve, cur = MKT[M].cur;
  const eq = Charts.line([{ name: "Account value", color: "#6a55ff", area: true, pts: c.map(p => ({ x: p.date, y: p.equity })) }, { name: "Net deposits", color: "#8d96b5", dash: 1, w: 1.5, pts: c.map(p => ({ x: p.date, y: p.netDep })) }], v => money(v, M, 0));
  const b = PM[MKT[M].bench] || []; let benchPts = [];
  if (c.length && b.length) { const b0 = ([...b].reverse().find(p => p.date <= c[0].date) || b[0]).close; benchPts = b.filter(p => p.date >= c[0].date).map(p => ({ x: p.date, y: (p.close / b0 - 1) * 100 })); }
  const rt = Charts.line([{ name: "You (deposit-adjusted)", color: "#6a55ff", pts: c.map(p => ({ x: p.date, y: p.twr })) }].concat(benchPts.length ? [{ name: MKT[M].benchName, color: "#8d96b5", dash: 1, w: 1.5, pts: benchPts }] : []), v => v.toFixed(1) + "%");
  const k = (l, v, cls) => `<div><small>${l}</small><b class="${cls || ""}">${v}</b></div>`;
  const ins = PC.insights(a, { currency: cur, benchName: MKT[M].benchName, stopSymbols: new Set(S.orders.filter(o => o.portfolio === M && o.side === "SELL" && o.type === "STOP" && o.status === "pending").map(o => o.symbol)) });
  const tags = PC.byTag(a.rounds), dt = dayTotal();
  return `<div class="sec"><h2>Account value</h2></div><div class="card">${eq}</div>
    <div class="sec"><h2>Return vs ${esc(MKT[M].benchName)}</h2></div><div class="card">${rt}<p class="hint">Deposits and withdrawals are removed from the return, so adding money never looks like profit.</p></div>
    <div class="sec"><h2>Performance</h2></div><div class="card"><div class="kv">
      ${k("Closed trades", s.n)}${k("Win rate", s.winRate == null ? "–" : s.winRate.toFixed(0) + "%")}
      ${k("Average win", money(s.avgWin), "up")}${k("Average loss", s.avgLoss == null ? "–" : money(-s.avgLoss), "dn")}
      ${k("Win/loss size", s.payoff == null ? "–" : s.payoff.toFixed(2) + "×")}${k("Profit factor", s.profitFactor == null ? "–" : s.profitFactor === Infinity ? "∞" : s.profitFactor.toFixed(2))}
      ${k("Expectancy / trade", money(s.expectancy), sgn(s.expectancy))}${k("Average R", s.avgR == null ? "–" : s.avgR.toFixed(2) + "R")}
      ${k("Avg days: winners", s.holdWin == null ? "–" : s.holdWin.toFixed(1))}${k("Avg days: losers", s.holdLoss == null ? "–" : s.holdLoss.toFixed(1))}
      ${k("Best trade", s.best == null ? "–" : money(s.best), sgn(s.best))}${k("Worst trade", s.worst == null ? "–" : money(s.worst), sgn(s.worst))}
      ${dt ? k("Day P&amp;L", sgnm(dt.abs) + " (" + pct(dt.pct) + ")", sgn(dt.abs)) : ""}${k("Deposit-adjusted return", pct(a.twrPct), sgn(a.twrPct))}${k("Max drawdown", a.maxDrawdownPct == null ? "–" : "-" + a.maxDrawdownPct.toFixed(1) + "%")}
      ${k(esc(MKT[M].benchName) + " (same period)", pct(a.benchPct), sgn(a.benchPct))}${k("Charges paid", money(a.fees))}</div></div>
    <div class="sec"><h2>Observations</h2></div><div class="card">${ins.length ? `<ul class="ins">${ins.map(i => `<li class="${i.level}">${esc(i.text)}</li>`).join("")}</ul>` : '<p class="hint" style="margin:0">Nothing to report yet.</p>'}<p class="hint">Rule-based checks on your own numbers, not predictions.</p></div>
    ${backtestHtml()}
    ${tags.length && a.rounds.length ? `<div class="sec"><h2>By tag</h2></div><div class="card flush">${tags.map(t => `<div class="row"><div class="mid"><b>${esc(t.tag)}</b><small>${t.n} trade${t.n === 1 ? "" : "s"} · ${t.winRate.toFixed(0)}% win</small></div><div class="end"><b class="${sgn(t.total)}">${sgnm(t.total)}</b><small class="${sgn(t.expectancy)}">${sgnm(t.expectancy)} / trade</small></div></div>`).join("")}</div>` : ""}`;
}

Views.port = function () {
  const tabs = [["pos", `Positions${ACC.positions.length ? " (" + ACC.positions.length + ")" : ""}`], ["trd", "Closed"], ["dash", "Insights"]];
  return notices() + `<div class="utabs">${tabs.map(t => `<button role="tab" aria-selected="${PTAB === t[0]}" data-act="ptab" data-v="${t[0]}">${t[1]}</button>`).join("")}</div>` +
    (PTAB === "trd" ? portClosed() : PTAB === "dash" ? portDash() : portPositions());
};
ACT.ptab = el => { PTAB = el.dataset.v; ls.set("bd-ptab", PTAB); render(); };
ACT.daymode = el => { DAYMODE = el.dataset.v === "1"; ls.set("bd-daymode", DAYMODE ? "1" : "0"); render(); };
