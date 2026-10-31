/* Small hand-drawn SVG charts (no libraries). Each function returns an HTML string; colours come from CSS classes and
   variables so light and dark themes both work. Call Charts.bind(rootElement) after inserting the HTML to switch on
   touch scrubbing (drag a finger across a chart to read its values). */
(function () {
  "use strict";
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const REG = {};                       // chart id -> geometry and data, used by the scrubber
  let seq = 0;
  const px = v => (Math.abs(v) >= 1000 ? v.toFixed(0) : Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(2));

  /* One bar per session showing the return versus a month ago: green above zero, red below. */
  function sparkBars(vals, label) {
    const BW = 3, GAP = 1.4, H = 30, n = vals.length;
    const top = Math.max(0, ...vals), bot = Math.min(0, ...vals), rng = (top - bot) || 1, y0 = top / rng * H;
    const w = n * (BW + GAP) - GAP;
    let g = `<line class="zl" x1="0" x2="${w}" y1="${y0}" y2="${y0}"/>`;
    vals.forEach((v, i) => {
      const h = Math.max(Math.abs(v) / rng * H, 1), y = v >= 0 ? Math.max(y0 - h, 0) : y0;
      g += `<rect class="${v >= 0 ? "pos" : "neg"}" x="${(i * (BW + GAP)).toFixed(1)}" y="${y.toFixed(1)}" width="${BW}" height="${h.toFixed(1)}" rx="1"/>`;
    });
    return `<svg class="spark" viewBox="0 0 ${w.toFixed(1)} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(label || "")}">${g}</svg>`;
  }

  /* Candles with 20 EMA (red) and 50 EMA (blue), volume, and optional horizontal level lines.
     d = {o,h,l,c,v?,e1,e2,dates?,d0?,d1?}; levels = [{name,color,v}] */
  function candles(d, opts) {
    opts = opts || {};
    const id = "ch" + (++seq), n = d.c.length;
    const W = 400, H = opts.vol === false ? 214 : 262, L = 6, R = 52, PT = 8, PH = opts.vol === false ? 186 : 170, VT = 190, VH = 50;
    const pw = W - L - R, step = pw / n, bw = Math.max(1, step * 0.66);
    const levels = (opts.levels || []).filter(x => x && x.v > 0);
    let hi = Math.max(...d.h, ...levels.map(x => x.v)), lo = Math.min(...d.l, ...levels.map(x => x.v));
    const pad = (hi - lo) * 0.05 || hi * 0.02; hi += pad; lo -= pad;
    const Y = v => PT + (hi - v) / (hi - lo) * PH, X = i => L + (i + 0.5) * step;
    let g = "";
    for (let k = 0; k <= 3; k++) { const v = lo + (hi - lo) * k / 3, y = Y(v); g += `<line class="gr" x1="${L}" x2="${L + pw}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"/><text x="${L + pw + 4}" y="${(y + 3).toFixed(1)}">${px(v)}</text>`; }
    if (opts.vol !== false && d.v) {
      const mv = Math.max(...d.v) || 1;
      for (let i = 0; i < n; i++) { const h = Math.max(d.v[i] / mv * VH, 0.5); g += `<rect class="vol ${d.c[i] >= d.o[i] ? "up" : "dn"}" x="${(X(i) - bw / 2).toFixed(1)}" y="${(VT + VH - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}"/>`; }
    }
    for (let i = 0; i < n; i++) {
      const cls = d.c[i] >= d.o[i] ? "up" : "dn", yo = Y(d.o[i]), yc = Y(d.c[i]);
      g += `<line class="wk ${cls}" x1="${X(i).toFixed(1)}" x2="${X(i).toFixed(1)}" y1="${Y(d.h[i]).toFixed(1)}" y2="${Y(d.l[i]).toFixed(1)}"/><rect class="bd ${cls}" x="${(X(i) - bw / 2).toFixed(1)}" y="${Math.min(yo, yc).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(Math.abs(yo - yc), 1).toFixed(1)}"/>`;
    }
    const line = (arr, cls) => `<polyline class="em ${cls}" points="${arr.map((v, i) => X(i).toFixed(1) + "," + Y(v).toFixed(1)).join(" ")}"/>`;
    if (d.e2) g += line(d.e2, "e50"); if (d.e1) g += line(d.e1, "e20");
    for (const lv of levels) {
      g += `<line x1="${L}" x2="${L + pw}" y1="${Y(lv.v).toFixed(1)}" y2="${Y(lv.v).toFixed(1)}" stroke="${lv.color}" stroke-width="1.3" stroke-dasharray="5 3"/>` +
           `<text x="${L + 3}" y="${(Y(lv.v) - 3).toFixed(1)}" style="fill:${lv.color};font-weight:600">${esc(lv.name)} ${px(lv.v)}</text>`;
    }
    const d0 = d.dates ? d.dates[0] : d.d0, d1 = d.dates ? d.dates[n - 1] : d.d1;
    if (d0) g += `<text x="${L}" y="${H - 2}">${esc(d0)}</text>`;
    if (d1) g += `<text x="${L + pw}" y="${H - 2}" text-anchor="end">${esc(d1)}</text>`;
    g += `<line id="${id}-x" class="xh" y1="${PT}" y2="${PT + PH}" x1="0" x2="0" style="display:none"/>`;
    REG[id] = { type: "candle", d, n, L, step, W, d1 };
    const lg = [`<span><i class="sw e20"></i>20 EMA</span>`, `<span><i class="sw e50"></i>50 EMA</span>`]
      .concat(levels.map(l => `<span><i class="sw" style="border-color:${l.color}"></i>${esc(l.name)}</span>`)).join("");
    return `<div class="lgd">${lg}</div><div class="ro" id="${id}-ro">${candleReadout(REG[id], n - 1)}</div>` +
           `<svg class="cv" id="${id}" data-chart="1" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.label || "Daily candlestick chart")}">${g}</svg>`;
  }
  function candleReadout(c, i) {
    const d = c.d, lab = d.dates ? d.dates[i] : (i === c.n - 1 ? (c.d1 || "latest") : (c.n - 1 - i) + " sessions ago");
    const chg = i > 0 ? (d.c[i] / d.c[i - 1] - 1) * 100 : null;
    return `<b>${esc(lab)}</b> &nbsp;O ${px(d.o[i])} &nbsp;H ${px(d.h[i])} &nbsp;L ${px(d.l[i])} &nbsp;C <b>${px(d.c[i])}</b>` +
           (chg == null ? "" : ` &nbsp;<span class="${chg >= 0 ? "up" : "dn"}">${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%</span>`);
  }

  /* series = [{name,color,pts:[{x:'YYYY-MM-DD',y:number}],dash?,w?,area?}] ; fmt formats the y values. */
  function line(series, fmt, opts) {
    opts = opts || {};
    const pts = series.flatMap(s => s.pts);
    if (pts.length < 2) return `<p class="hint">The chart appears once there are two or more days of data.</p>`;
    const id = "ch" + (++seq), W = 400, H = opts.h || 200, pl = 8, pr = 52, pt = 10, pb = 22;
    const xs = pts.map(p => Date.parse(p.x)), x0 = Math.min(...xs), x1 = Math.max(...xs);
    let y0 = Math.min(...pts.map(p => p.y)), y1 = Math.max(...pts.map(p => p.y)); if (y0 === y1) { y0 -= 1; y1 += 1; }
    const padY = (y1 - y0) * 0.08; y0 -= padY; y1 += padY;
    const X = d => pl + (Date.parse(d) - x0) / ((x1 - x0) || 1) * (W - pl - pr), Y = v => pt + (1 - (v - y0) / (y1 - y0)) * (H - pt - pb);
    let g = "";
    for (let i = 0; i <= 3; i++) { const v = y0 + (y1 - y0) * i / 3, y = Y(v); g += `<line class="gr" x1="${pl}" x2="${W - pr}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"/><text x="${W - pr + 4}" y="${(y + 3).toFixed(1)}">${esc(fmt(v))}</text>`; }
    g += `<text x="${pl}" y="${H - 5}">${new Date(x0).toISOString().slice(0, 10)}</text><text x="${W - pr}" y="${H - 5}" text-anchor="end">${new Date(x1).toISOString().slice(0, 10)}</text>`;
    series.forEach(s => {
      const path = s.pts.map((p, i) => (i ? "L" : "M") + X(p.x).toFixed(1) + " " + Y(p.y).toFixed(1)).join("");
      if (s.area) g += `<path d="${path}L${X(s.pts[s.pts.length - 1].x).toFixed(1)} ${H - pb}L${X(s.pts[0].x).toFixed(1)} ${H - pb}Z" fill="${s.color}" opacity=".12"/>`;
      g += `<path d="${path}" fill="none" stroke="${s.color}" stroke-width="${s.w || 2}" ${s.dash ? 'stroke-dasharray="5 4"' : ""} stroke-linejoin="round" stroke-linecap="round"/>`;
    });
    g += `<line id="${id}-x" class="xh" y1="${pt}" y2="${H - pb}" x1="0" x2="0" style="display:none"/>`;
    REG[id] = { type: "line", series, fmt, X, W };
    const lg = series.map(s => `<span><i class="sw" style="border-color:${s.color}${s.dash ? ";border-top-style:dashed" : ""}"></i>${esc(s.name)}</span>`).join("");
    return `<div class="lgd">${lg}</div><div class="ro" id="${id}-ro">&nbsp;</div><svg class="cv" id="${id}" data-chart="1" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(series.map(s => s.name).join(" and "))} over time">${g}</svg>`;
  }

  /* Stacked horizontal bar, e.g. where the money sits. parts = [{name,value,color}] */
  function stack(parts, fmt) {
    const tot = parts.reduce((t, p) => t + Math.max(0, p.value), 0);
    if (!(tot > 0)) return "";
    const bar = parts.filter(p => p.value > 0).map(p => `<i style="width:${(p.value / tot * 100).toFixed(2)}%;background:${p.color}" title="${esc(p.name)}"></i>`).join("");
    const lg = parts.filter(p => p.value > 0).map(p => `<span><i class="dot" style="background:${p.color}"></i>${esc(p.name)} <b>${(p.value / tot * 100).toFixed(0)}%</b></span>`).join("");
    return `<div class="stackbar">${bar}</div><div class="lgd stk">${lg}</div>`;
  }

  function bind(root) {
    (root || document).querySelectorAll("svg[data-chart]").forEach(svg => {
      if (svg.__bound) return; svg.__bound = true;
      const c = REG[svg.id]; if (!c) return;
      const ro = document.getElementById(svg.id + "-ro"), xh = document.getElementById(svg.id + "-x");
      const at = ev => {
        const r = svg.getBoundingClientRect(), x = (ev.clientX - r.left) / r.width * c.W;
        if (c.type === "candle") {
          const i = Math.max(0, Math.min(c.n - 1, Math.floor((x - c.L) / c.step)));
          const cx = c.L + (i + 0.5) * c.step; xh.setAttribute("x1", cx); xh.setAttribute("x2", cx); xh.style.display = "";
          ro.innerHTML = candleReadout(c, i);
        } else {
          let best = null, bd = 1e18;
          for (const p of c.series[0].pts) { const dx = Math.abs(c.X(p.x) - x); if (dx < bd) { bd = dx; best = p; } }
          if (!best) return;
          xh.setAttribute("x1", c.X(best.x)); xh.setAttribute("x2", c.X(best.x)); xh.style.display = "";
          ro.innerHTML = `<b>${esc(best.x)}</b> &nbsp;` + c.series.map(s => { const q = s.pts.filter(p => p.x <= best.x).pop(); return `${esc(s.name)} <b>${q ? esc(c.fmt(q.y)) : "–"}</b>`; }).join(" &nbsp;");
        }
      };
      svg.addEventListener("pointerdown", at); svg.addEventListener("pointermove", at);
    });
  }

  window.Charts = { sparkBars, candles, line, stack, bind, esc };
})();
