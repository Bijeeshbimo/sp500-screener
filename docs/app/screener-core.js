/* Screener logic shared by the app and the tests: the breakout filter and the plain-language insights.
   Ported one-for-one from the page that screener.py writes (docs/index.html), so both show the same stocks and the
   same checks. No DOM, no network. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ScreenerCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const PRESETS = [20, 50, 100, 150, 200, 252];
  const DEF_N = 200, DEF_TOP = 20;

  /* The breakout level for lookback N: lv is a list of [sessions, level] steps. */
  function levelFor(steps, N) {
    let v = null;
    for (const st of steps || []) { if (st[0] <= N) v = st[1]; else break; }
    return v;
  }

  /* f = { N, adv, px, cap, rmin, rmax, ext, rv, rs, idx:[codes] }; a null/undefined number means "no filter".
     Returns null when the lookback is below the minimum. */
  function matches(rows, f, cfg, minLookback) {
    const N = parseInt(f.N, 10);
    if (!(N >= minLookback)) return null;
    const minAdv = (+f.adv || 0) * cfg.advFactor, minPx = +f.px || 0;
    const cap = f.cap == null || f.cap === "" || isNaN(+f.cap) ? Infinity : +f.cap;
    const sel = new Set(f.idx || []);
    const has = v => v != null && v !== "" && !isNaN(+v);
    return rows.filter(r => N > r.n2 + 1 && N <= r.n1 && r.adv >= minAdv && r.close >= minPx
      && r.chg <= cap && r.idx.some(i => sel.has(i))
      && (!has(f.rmin) || (r.rsi !== null && r.rsi >= +f.rmin))
      && (!has(f.rmax) || (r.rsi !== null && r.rsi <= +f.rmax))
      && (!has(f.ext) || r.ext20 <= +f.ext)
      && (!has(f.rv) || r.rvol >= +f.rv)
      && (!has(f.rs) || (r.rs !== null && r.rs >= +f.rs)));
  }

  const SEV = { bad: 0, warn: 1, good: 2, info: 3 };
  const dayMs = 864e5;
  const isoDay = d => d.toISOString().slice(0, 10);
  function daysUntil(iso, now) { return Math.round((Date.parse(iso + "T00:00:00Z") - Date.parse(isoDay(now || new Date()) + "T00:00:00Z")) / dayMs); }

  /* Plain-language checks worked out from the numbers in one row. Observations, not advice.
     cfg: the market's meta.cfg (currency, locale, price bands). */
  function insights(r, N, cfg, now) {
    const out = { items: [], stop: null, good: 0, warn: 0, bad: 0 };
    const x = r.x; if (!x) return out;
    const cur = cfg.currency, cx = r.cx, last = cx.c.length - 1;
    const fmtPx = v => v.toLocaleString(cfg.locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const add = (g, l, t) => { out.items.push({ g, l, t }); if (l !== "info") out[l]++; };
    const lvl = levelFor(r.lv, N), dayLow = cx.l[last];

    if (lvl !== null) {
      const over = (r.close / lvl - 1) * 100;
      if (over < 0.5) add("Breakout", "warn", "Only " + over.toFixed(1) + "% above the " + N + "-session high (" + cur + fmtPx(lvl) + "): a thin margin.");
      else if (over <= 6) add("Breakout", "good", "Closed " + over.toFixed(1) + "% above the " + N + "-session high (" + cur + fmtPx(lvl) + ").");
      else add("Breakout", "warn", "Closed " + over.toFixed(1) + "% above the " + N + "-session high: already well past the breakout point.");
    }
    if (x.cp !== null) {
      if (x.cp >= 80) add("Breakout", "good", "Closed near the high of the day (top " + Math.max(1, Math.ceil(100 - x.cp)) + "% of its range): buyers held on to the close.");
      else if (x.cp <= 50) add("Breakout", "warn", "Closed in the lower half of the day’s range: sellers pushed back late in the session.");
    }
    if (x.gap >= 3) {
      if (x.cp !== null && x.cp < 60) add("Breakout", "warn", "Gapped up " + x.gap.toFixed(1) + "% at the open but faded during the day.");
      else add("Breakout", "info", "Gapped up " + x.gap.toFixed(1) + "% at the open.");
    }
    if (r.rvol >= 1.5) add("Breakout", "good", "Volume " + r.rvol.toFixed(1) + "× normal: real participation behind the move.");
    else if (r.rvol < 1) add("Breakout", "warn", "Volume only " + r.rvol.toFixed(1) + "× normal: weak confirmation.");
    if (x.rg !== null && x.rg >= 2.5) add("Breakout", "info", "Today’s range was " + x.rg.toFixed(1) + "× its normal size.");
    if (x.b20 !== null && x.atrp) {
      if (x.b20 / x.atrp <= 4) add("Breakout", "good", "Quiet 20-day base (range " + x.b20.toFixed(1) + "%) before the move.");
    }
    if (r.m1 >= 35) add("Breakout", "warn", "Already up " + r.m1.toFixed(0) + "% in a month: extended.");

    const e1 = cx.e1[last], e2 = cx.e2[last];
    if (r.close > e1 && e1 > e2) add("Trend", "good", "Price is above the 20 EMA and the 20 EMA is above the 50 EMA: trend stacked up.");
    else if (r.close < e2) add("Trend", "warn", "Price is still below the 50 EMA: the longer trend is not up yet.");
    else add("Trend", "warn", "20 and 50 EMAs are not in bullish order yet.");
    if (x.s200 !== null) {
      if (e2 > x.s200) add("Trend", "good", "50 EMA is above the 200-day average.");
      else add("Trend", "warn", "50 EMA is below the 200-day average: long-term trend not up.");
    }
    if (r.close > x.h52) add("Trend", "good", "New 52-week high.");
    else {
      const d = (r.close / x.h52 - 1) * 100;
      if (d < -25) add("Trend", "warn", "Still " + (-d).toFixed(0) + "% below its 52-week high: a recovery move rather than a fresh high.");
      else add("Trend", "info", (-d).toFixed(1) + "% below its 52-week high.");
    }
    if (r.rs !== null) {
      if (r.rs >= 80) add("Trend", "good", "Strong relative strength: RS rank " + r.rs + " (ahead of " + r.rs + "% of stocks scanned).");
      else if (r.rs <= 40) add("Trend", "warn", "Weak relative strength: RS rank " + r.rs + ".");
      else add("Trend", "info", "RS rank " + r.rs + ".");
    }

    if (r.rsi !== null && r.rsi >= 80) add("Risk", "warn", "RSI " + r.rsi.toFixed(0) + ": stretched; pullbacks are common after readings this high.");
    if (r.ext20 >= 10) add("Risk", "warn", r.ext20.toFixed(1) + "% above the 20 EMA: extended from its short-term average.");
    if (lvl !== null) {
      const stop = Math.max(lvl, dayLow), risk = (r.close / stop - 1) * 100, am = x.atr > 0 ? (r.close - stop) / x.atr : null;
      out.stop = { px: stop, risk, atrMult: am };
      if (am !== null && am > 3) add("Risk", "warn", "Reference stop is " + am.toFixed(1) + "× the normal daily range away (" + risk.toFixed(1) + "%): wide.");
      else add("Risk", "info", "Reference stop is " + risk.toFixed(1) + "% below the close" + (am !== null ? " (" + am.toFixed(1) + "× the normal daily range)." : "."));
    }
    if (r.earn) {
      const d = daysUntil(r.earn, now), when = d < 0 ? "just reported" : d === 0 ? "today" : d === 1 ? "tomorrow" : "in " + d + " days";
      if (d >= 0 && d <= 2) add("Risk", "bad", "Earnings " + when + " (" + r.earn + "): a gap on results can jump straight past any stop.");
      else if (d >= 3 && d <= 10) add("Risk", "warn", "Earnings " + when + " (" + r.earn + ").");
      else add("Risk", "info", "Next earnings: " + r.earn + " (" + when + ").");
    } else add("Risk", "info", "No earnings date available: check before entering.");

    if (r.chg >= 40) add("Data check", "bad", "Up " + r.chg.toFixed(0) + "% in one day: check for a split, bonus issue or data error before trusting this.");
    if (cfg.bands && x.cp !== null && x.cp >= 99) {
      for (const bnd of cfg.bands) if (r.chg >= bnd - 0.6 && r.chg <= bnd + 0.1)
        add("Data check", "warn", "Closed at the day’s high, up " + r.chg.toFixed(1) + "%, right at the " + bnd + "% price band: it may have hit upper circuit, so buying may not have been possible.");
    }
    out.items.sort((a, b) => SEV[a.l] - SEV[b.l]);
    return out;
  }

  /* Sort keys offered in the app. "sg" is positives minus cautions, warnings counting double (as on the web page). */
  const SORTS = [
    { k: "chg", t: "Day %", num: 1 }, { k: "sg", t: "Signals", num: 1 }, { k: "rs", t: "RS rank", num: 1 },
    { k: "rvol", t: "Rel. volume", num: 1 }, { k: "m1", t: "1M %", num: 1 }, { k: "rsi", t: "RSI", num: 1 },
    { k: "ext20", t: "From 20 EMA", num: 1 }, { k: "adv", t: "Liquidity", num: 1 }, { k: "sym", t: "A–Z" },
  ];
  function sortRows(list, key, asc, N, cfg, now) {
    const keyed = list.map(r => { const ins = insights(r, N, cfg, now); return { r, ins, sg: ins.good - ins.warn - 2 * ins.bad }; });
    const num = key !== "sym";
    keyed.sort((a, b) => {
      let x = key === "sg" ? a.sg : a.r[key], y = key === "sg" ? b.sg : b.r[key], c;
      if (num) { x = x ?? -Infinity; y = y ?? -Infinity; c = x === y ? 0 : (x < y ? -1 : 1); } else c = String(x).localeCompare(String(y));
      return asc ? c : -c;
    });
    return keyed;
  }

  return { PRESETS, DEF_N, DEF_TOP, SORTS, levelFor, matches, insights, sortRows, daysUntil };
});
