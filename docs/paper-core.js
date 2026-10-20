/* Paper trading: pure calculations shared by the page (browser) and the tests (node).
   No DOM, no network. Fee logic mirrors paper/fees.py; both are tested against paper/vectors.json. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PaperCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const DEFAULT_SETTINGS = {
    in: { brokerage_pct: 0, stt_pct: 0.1, stamp_buy_pct: 0.015, exch_pct: 0.00297, sebi_pct: 0.0001, gst_pct: 18, dp_charge: 12.5, slippage_bps: 0 },
    us: { brokerage_pct: 0.25, min_brokerage: 0.01, exch_pct: 0.005, gst_pct: 18, other_pct: 0, slippage_bps: 0 },
    fx: { markup_pct: 1.0, gst_pct_of_inr: 0.179, bank_charge_inr: 0, payin_fee_usd: 1, payin_free_from_usd: 100,
          tcs_enabled: false, tcs_rate_pct: 20, tcs_threshold_inr: 1000000, fallback_rate: 95 },
    engine: { same_bar_priority: "stop" },
    risk: { in: 5000, us: 50 },
  };

  const clone = o => JSON.parse(JSON.stringify(o));
  function mergeSettings(saved) {
    const out = clone(DEFAULT_SETTINGS);
    for (const g in saved || {}) if (out[g] && typeof saved[g] === "object") Object.assign(out[g], saved[g]);
    return out;
  }

  const r2 = x => Math.floor(x * 100 + 0.5 + 1e-9) / 100;

  /* ------------------------------------------------------------- trade fees -- */
  function tradeFees(portfolio, side, qty, price, settings, dpApplies) {
    if (dpApplies === undefined) dpApplies = true;
    const value = qty * price;
    let parts;
    if (portfolio === "IN") {
      const c = settings.in;
      const brokerage = r2(value * c.brokerage_pct / 100), stt = r2(value * c.stt_pct / 100);
      const exchange = r2(value * c.exch_pct / 100), sebi = r2(value * c.sebi_pct / 100);
      const stamp = side === "BUY" ? r2(value * c.stamp_buy_pct / 100) : 0;
      const gst = r2((brokerage + exchange + sebi) * c.gst_pct / 100);
      const dp = side === "SELL" && dpApplies ? r2(c.dp_charge * (1 + c.gst_pct / 100)) : 0;
      parts = { brokerage, stt, exchange, sebi, stamp, gst, dp };
    } else {
      const c = settings.us;
      const brokerage = Math.max(c.min_brokerage, Math.ceil(value * c.brokerage_pct / 100 * 100 - 1e-9) / 100);
      parts = { brokerage, exchange: r2(value * c.exch_pct / 100), gst: r2(brokerage * c.gst_pct / 100), other: r2(value * c.other_pct / 100) };
    }
    let t = 0; for (const k in parts) t += parts[k];
    parts.total = r2(t);
    return parts;
  }

  /* ------------------------------------------------------------ add US funds -- */
  // Indian financial year (1 Apr - 31 Mar) a date falls in, as its starting year.
  function fyOf(dateStr) { const y = +dateStr.slice(0, 4), m = +dateStr.slice(5, 7); return m >= 4 ? y : y - 1; }
  const defaultRate = (ref, s) => r2(ref * (1 + s.fx.markup_pct / 100) * 100) / 100;

  /* INR sent -> USD credited. Every override is optional; blank/undefined uses the setting.
     usd = (inr - gst - bank) / rate ; pay-in fee is taken from the USD when the pay-in is under the free limit. */
  function fundCalc(o) {
    const s = o.settings.fx;
    const inr = +o.inr, rate = +o.rate;
    if (!(inr > 0) || !(rate > 0)) return { ok: false, error: "Enter an INR amount and an exchange rate." };
    const gst = o.gst != null && o.gst !== "" ? +o.gst : r2(inr * s.gst_pct_of_inr / 100);
    const bank = o.bank != null && o.bank !== "" ? +o.bank : s.bank_charge_inr;
    const gross = r2((inr - gst - bank) / rate);
    const payin = o.payin != null && o.payin !== "" ? +o.payin : (gross < s.payin_free_from_usd ? s.payin_fee_usd : 0);
    const net = r2(gross - payin);
    if (!(net > 0)) return { ok: false, error: "The charges are larger than the amount." };
    let tcs = 0;
    if (o.applyTcs) {
      const before = +o.fyRemittedBefore || 0, th = s.tcs_threshold_inr;
      const over = Math.max(0, before + inr - th) - Math.max(0, before - th);
      tcs = r2(over * s.tcs_rate_pct / 100);
    }
    return { ok: true, inr, rate, gst, bank, gross_usd: gross, payin_fee_usd: payin, net_usd: net, tcs,
             total_inr_out: r2(inr + tcs), effective_rate: Math.round(inr / net * 100) / 100 };
  }

  /* ----------------------------------------------------------------- account -- */
  const dayDiff = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 864e5);
  const sum = a => a.reduce((x, y) => x + y, 0);
  const mean = a => (a.length ? sum(a) / a.length : null);

  /* ledger/fills: rows of ONE portfolio. prices: {yf: [{date, close}]} ascending. bench: yahoo ticker for the benchmark.
     Cash and holdings are never stored; they are recomputed from the records every time. */
  function buildAccount(ledger, fills, prices, bench) {
    const issues = [];
    const ff = fills.slice().sort((a, b) =>
      a.date < b.date ? -1 : a.date > b.date ? 1 : (a.side === b.side ? 0 : a.side === "BUY" ? -1 : 1) || (a.created_at || "") .localeCompare(b.created_at || ""));
    const lots = {}, trades = [], meta = {};
    let fees = 0;
    for (const f of ff) {
      const q = +f.qty, p = +f.price, fee = +f.fees_total || 0;
      fees += fee;
      meta[f.symbol] = { yf: f.yf, tag: f.tag };
      if (f.side === "BUY") {
        (lots[f.symbol] = lots[f.symbol] || []).push({ qty: q, price: p, unit: p + fee / q, date: f.date, stop: f.stop_ref != null ? +f.stop_ref : null, tag: f.tag || "", id: f.id });
      } else {
        const net = (q * p - fee) / q;
        let left = q, cost = 0, proceeds = 0, risk = 0, riskOk = true, dsum = 0, tag = "", first = null;
        const L = lots[f.symbol] || [];
        while (left > 1e-9 && L.length) {
          const lot = L[0], m = Math.min(left, lot.qty);
          cost += m * lot.unit; proceeds += m * net; dsum += m * dayDiff(f.date, lot.date);
          if (lot.stop != null && lot.price > lot.stop) risk += m * (lot.price - lot.stop); else riskOk = false;
          if (!first) { first = lot.date; tag = lot.tag; }
          lot.qty -= m; left -= m; if (lot.qty <= 1e-9) L.shift();
        }
        if (left > 1e-9) issues.push(`Sold ${left} more ${f.symbol} than held on ${f.date}; check your fills.`);
        const mq = q - Math.max(left, 0);
        if (mq > 0) {
          const pnl = proceeds - cost;
          trades.push({ symbol: f.symbol, qty: mq, entry: cost / mq, exit: net, entryDate: first, exitDate: f.date, pnl,
                        pct: pnl / cost * 100, days: dsum / mq, r: riskOk && risk > 0 ? pnl / risk : null, tag: tag || "", fillId: f.id });
        }
      }
    }

    // current positions
    const lastPx = sym => {
      const arr = prices[(meta[sym] || {}).yf] || [];
      return arr.length ? arr[arr.length - 1] : null;
    };
    const positions = [];
    for (const sym in lots) {
      const L = lots[sym].filter(l => l.qty > 1e-9);
      if (!L.length) continue;
      const qty = sum(L.map(l => l.qty)), cost = sum(L.map(l => l.qty * l.unit));
      const lp = lastPx(sym), px = lp ? lp.close : L[L.length - 1].price;
      const stops = L.filter(l => l.stop != null);
      positions.push({ symbol: sym, yf: meta[sym].yf, qty, avg: cost / qty, cost, price: px, priceDate: lp ? lp.date : null,
        value: qty * px, pnl: qty * px - cost, pct: (qty * px / cost - 1) * 100, since: L[0].date, days: dayDiff(new Date().toISOString().slice(0, 10), L[0].date),
        stop: stops.length ? stops[stops.length - 1].stop : null, tag: L[0].tag || "" });
    }
    positions.sort((a, b) => b.value - a.value);

    // cash and daily equity curve
    const events = [];
    for (const r of ledger) events.push({ date: r.date, k: 0, flow: (r.kind === "deposit" ? 1 : -1) * +r.amount });
    for (const f of ff) events.push({ date: f.date, k: 1, f });
    events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.k - b.k));
    const curve = [];
    let cash = 0, netDep = 0;
    if (events.length) {
      const dates = new Set(events.map(e => e.date));
      const benchArr = prices[bench] || [];
      for (const b of benchArr) if (b.date >= events[0].date) dates.add(b.date);
      const held = {};
      const idx = {};
      const px = (yf, d, fallback) => {
        const arr = prices[yf] || []; let i = idx[yf] || 0;
        while (i + 1 < arr.length && arr[i + 1].date <= d) i++;
        idx[yf] = i;
        return arr.length && arr[i].date <= d ? arr[i].close : fallback;
      };
      const lastFill = {};
      let ei = 0, prevE = 0, index = 1, peak = 1, maxDD = 0;
      for (const d of [...dates].sort()) {
        let flowToday = 0;
        while (ei < events.length && events[ei].date <= d) {
          const e = events[ei++];
          if (e.k === 0) { cash += e.flow; netDep += e.flow; flowToday += e.flow; }
          else {
            const f = e.f, q = +f.qty, p = +f.price, fee = +f.fees_total || 0;
            lastFill[f.symbol] = p;
            if (f.side === "BUY") { cash -= q * p + fee; held[f.symbol] = (held[f.symbol] || 0) + q; }
            else { cash += q * p - fee; held[f.symbol] = (held[f.symbol] || 0) - q; }
          }
        }
        let mv = 0;
        for (const s in held) if (held[s] > 1e-9) mv += held[s] * px((meta[s] || {}).yf, d, lastFill[s]);
        const eq = cash + mv, base = prevE + flowToday;
        if (base > 0) index *= eq / base;
        peak = Math.max(peak, index); maxDD = Math.max(maxDD, 1 - index / peak);
        curve.push({ date: d, equity: eq, netDep, twr: (index - 1) * 100 });
        prevE = eq;
      }
      var maxDrawdownPct = maxDD * 100;
    }
    const invested = sum(positions.map(p => p.value));
    const equity = cash + invested;
    const realized = sum(trades.map(t => t.pnl));
    let benchPct = null;
    const barr = prices[bench] || [];
    if (events.length && barr.length) {
      const startBar = [...barr].reverse().find(b => b.date <= events[0].date) || barr[0];
      benchPct = (barr[barr.length - 1].close / startBar.close - 1) * 100;
    }
    return { cash, invested, equity, netDeposits: netDep, pnl: equity - netDep, realized, unrealized: sum(positions.map(p => p.pnl)),
             fees, positions, trades, curve, issues, twrPct: curve.length ? curve[curve.length - 1].twr : null,
             maxDrawdownPct: maxDrawdownPct == null ? null : maxDrawdownPct, benchPct, stats: tradeStats(trades) };
  }

  function tradeStats(trades) {
    const n = trades.length;
    const w = trades.filter(t => t.pnl > 0), l = trades.filter(t => t.pnl < 0);
    const gp = sum(w.map(t => t.pnl)), gl = -sum(l.map(t => t.pnl));
    const avgWin = mean(w.map(t => t.pnl)), avgLoss = l.length ? gl / l.length : null;
    let run = 0, maxLossRun = 0;
    for (const t of trades.slice().sort((a, b) => (a.exitDate < b.exitDate ? -1 : 1))) { run = t.pnl < 0 ? run + 1 : 0; maxLossRun = Math.max(maxLossRun, run); }
    const rs = trades.filter(t => t.r != null).map(t => t.r);
    return { n, wins: w.length, losses: l.length, winRate: n ? w.length / n * 100 : null, avgWin, avgLoss,
      payoff: avgWin != null && avgLoss ? avgWin / avgLoss : null, profitFactor: gl > 0 ? gp / gl : (gp > 0 ? Infinity : null),
      expectancy: mean(trades.map(t => t.pnl)), avgPct: mean(trades.map(t => t.pct)), avgR: mean(rs), rCount: rs.length,
      holdWin: mean(w.map(t => t.days)), holdLoss: mean(l.map(t => t.days)),
      best: n ? Math.max(...trades.map(t => t.pnl)) : null, worst: n ? Math.min(...trades.map(t => t.pnl)) : null,
      grossProfit: gp, grossLoss: gl, maxLossRun };
  }

  function byTag(trades) {
    const g = {};
    for (const t of trades) (g[t.tag || "(no tag)"] = g[t.tag || "(no tag)"] || []).push(t);
    return Object.keys(g).map(tag => ({ tag, ...tradeStats(g[tag]), total: sum(g[tag].map(t => t.pnl)) }))
      .sort((a, b) => b.total - a.total);
  }

  /* Plain-language observations; every line is a rule on the numbers above, nothing predictive. */
  function insights(acc, ctx) {
    const out = [], s = acc.stats, add = (level, text) => out.push({ level, text });
    const cur = ctx.currency, f0 = x => cur + Math.abs(x).toLocaleString("en-IN", { maximumFractionDigits: 0 });
    if (s.n < 5) add("info", `Only ${s.n} closed trade${s.n === 1 ? "" : "s"} so far. Win rate and averages are not reliable until there are 20 or more.`);
    if (s.n >= 3) {
      if (s.profitFactor != null && s.profitFactor < 1) add("bad", `Losses are bigger than gains so far (profit factor ${s.profitFactor.toFixed(2)}). The average trade loses ${f0(s.expectancy)}.`);
      else if (s.expectancy > 0) add("good", `The average closed trade makes ${f0(s.expectancy)} (win rate ${s.winRate.toFixed(0)}%, average win is ${s.payoff ? s.payoff.toFixed(1) + "x" : "n/a"} the average loss).`);
      if (s.winRate < 40 && s.payoff != null && s.payoff < 1.5) add("warn", `Low win rate (${s.winRate.toFixed(0)}%) with winners only ${s.payoff.toFixed(1)}x the size of losers. That combination rarely pays; either cut losers faster or let winners run.`);
      if (s.holdWin != null && s.holdLoss != null) {
        if (s.holdLoss > s.holdWin * 1.5 && s.holdLoss - s.holdWin >= 2) add("warn", `Losers are held longer than winners (${s.holdLoss.toFixed(0)} vs ${s.holdWin.toFixed(0)} days on average). Stops may be too loose or moved.`);
        else if (s.holdWin > s.holdLoss * 1.5 && s.holdWin - s.holdLoss >= 2) add("good", `Winners are held longer than losers (${s.holdWin.toFixed(0)} vs ${s.holdLoss.toFixed(0)} days), which is the pattern trend following aims for.`);
      }
      if (s.avgLoss && s.worst != null && -s.worst > 3 * s.avgLoss) add("warn", `The worst loss (${f0(s.worst)}) is more than 3x the average loss, so one trade is doing outsized damage.`);
      if (s.maxLossRun >= 4) add("warn", `Longest losing streak: ${s.maxLossRun} trades in a row.`);
    }
    if (s.rCount >= 3) add("info", `Average result is ${s.avgR.toFixed(2)}R over ${s.rCount} trades that had a planned stop (1R = the amount risked to the stop).`);
    if (s.grossProfit > 0 && acc.fees > 0.1 * s.grossProfit) add("warn", `Charges are ${(acc.fees / s.grossProfit * 100).toFixed(0)}% of gross profit. Frequent small trades are costing a lot.`);
    if (acc.maxDrawdownPct != null && acc.maxDrawdownPct >= 10) add("warn", `The deepest drawdown so far is ${acc.maxDrawdownPct.toFixed(1)}% (deposits excluded).`);
    if (acc.equity > 0) {
      const top = acc.positions[0];
      if (top && top.value / acc.equity > 0.35) add("warn", `${top.symbol} is ${(top.value / acc.equity * 100).toFixed(0)}% of the account, a heavy concentration.`);
      const cashPct = acc.cash / acc.equity * 100;
      if (acc.positions.length && cashPct > 60) add("info", `${cashPct.toFixed(0)}% of the account is idle cash.`);
    }
    const nostop = acc.positions.filter(p => !(ctx.stopSymbols || new Set()).has(p.symbol));
    if (nostop.length) add("warn", `No pending stop order for: ${nostop.map(p => p.symbol).join(", ")}.`);
    const near = acc.positions.filter(p => p.stop != null && p.price > 0 && (p.price - p.stop) / p.price * 100 < 2 && p.price >= p.stop);
    if (near.length) add("info", `Within 2% of the planned stop: ${near.map(p => p.symbol).join(", ")}.`);
    const tags = byTag(acc.trades).filter(t => t.n >= 3);
    if (tags.length >= 2) {
      const best = tags.slice().sort((a, b) => b.expectancy - a.expectancy)[0], worst = tags.slice().sort((a, b) => a.expectancy - b.expectancy)[0];
      if (best.tag !== worst.tag) add("info", `By tag, "${best.tag}" averages ${f0(best.expectancy)} per trade and "${worst.tag}" ${worst.expectancy < 0 ? "loses " : "makes "}${f0(worst.expectancy)}.`);
    }
    if (acc.twrPct != null && acc.benchPct != null && s.n + acc.positions.length > 0)
      add(acc.twrPct >= acc.benchPct ? "good" : "info", `Return so far ${acc.twrPct.toFixed(1)}% (deposit-adjusted) against ${acc.benchPct.toFixed(1)}% for the ${ctx.benchName} over the same period.`);
    for (const i of acc.issues) add("bad", i);
    return out;
  }

  return { DEFAULT_SETTINGS, mergeSettings, r2, tradeFees, fyOf, defaultRate, fundCalc, buildAccount, tradeStats, byTag, insights };
});
