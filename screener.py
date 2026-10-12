#!/usr/bin/env python3
"""
US breakout screener -> one static HTML page whose filters you can change in the browser.

Mirrors this Chartink scan (N = 200 by default, adjustable on the page):
  1. Daily Close > 1-day-ago Max(N, Daily High)
        today's close is above the highest high of the previous N sessions
  2. 1-day-ago Close != 1-day-ago Max(N, Daily Close)
        yesterday's close was NOT itself the highest close of its N-session window
        (so the breakout is fresh, not a continuation)

To let the page recompute for ANY N without re-running this script, each stock is reduced to
two integers:
  n1 = how many consecutive previous sessions (counting back from yesterday) have a high
       below today's close          -> condition 1 holds exactly when N <= n1
  n2 = how many consecutive sessions before yesterday have a close <= yesterday's close
                                    -> condition 2 holds exactly when N > n2 + 1
So a stock matches lookback N when  n2 + 1 < N <= n1.

Universe: S&P 500 + S&P 400 + S&P 600 + Nasdaq-100 (de-duplicated).
Liquidity, minimum price and a max-daily-change cap are applied on the page.
"""
from __future__ import annotations

import datetime as dt
import io
import json
import re
import sys
from pathlib import Path

import numpy as np
import pandas as pd

# ---------------------------------------------------------------- settings --
MIN_LOOKBACK = 5            # smallest lookback offered on the page
MIN_BARS = 30               # ignore tickers with less history than this
HISTORY_PERIOD = "3y"       # allows lookbacks up to roughly 750 sessions
ADV_WINDOW = 20             # sessions (before the signal day) for average volume
SPARK_DAYS = 21             # sessions in the 1-month bar chart (about one trading month)
MIN_TICKERS = 400           # refuse to publish if fewer tickers returned data

OUT_PATH = Path(__file__).parent / "docs" / "index.html"

# code, label, page, minimum rows the constituents table should have
SOURCES = [
    ("SPX", "S&P 500", "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies", 400),
    ("MID", "S&P 400", "https://en.wikipedia.org/wiki/List_of_S%26P_400_companies", 300),
    ("SML", "S&P 600", "https://en.wikipedia.org/wiki/List_of_S%26P_600_companies", 450),
    ("NDX", "Nasdaq-100", "https://en.wikipedia.org/wiki/Nasdaq-100", 80),
]


# ------------------------------------------------------------------ logic ---
def breakout_stats(df: pd.DataFrame) -> dict | None:
    """Reduce one stock's daily bars (ascending dates; columns Open/High/Low/Close/Volume)
    to the numbers the page needs. Returns None if the stock cannot match for any
    lookback >= MIN_LOOKBACK."""
    df = df.dropna(subset=["Open", "High", "Low", "Close"])
    n = len(df)
    if n < MIN_BARS:
        return None

    h = df["High"].to_numpy(dtype=float)
    c = df["Close"].to_numpy(dtype=float)
    v = df["Volume"].fillna(0).to_numpy(dtype=float) if "Volume" in df else np.zeros(n)

    # n1: consecutive previous sessions (back from yesterday) whose high is below today's close
    viol = np.flatnonzero(h[:-1] >= c[-1])
    n1 = (n - 1) if viol.size == 0 else (n - 2) - int(viol[-1])

    # n2: consecutive sessions before yesterday (back from the day before) with close <= yesterday's close
    viol2 = np.flatnonzero(c[:-2] > c[-2])
    n2 = (n - 2) if viol2.size == 0 else (n - 3) - int(viol2[-1])

    if n1 < max(MIN_LOOKBACK, n2 + 2):      # no lookback N >= MIN_LOOKBACK satisfies both conditions
        return None

    prior_vol = v[-1 - ADV_WINDOW:-1]
    prior_dollar = (c * v)[-1 - ADV_WINDOW:-1]
    mean_vol = float(prior_vol.mean())

    # 1-month chart: return of each of the last SPARK_DAYS closes vs the close just before them
    base = float(c[-1 - SPARK_DAYS])
    spark = [round((float(x) / base - 1.0) * 100.0, 1) for x in c[-SPARK_DAYS:]]
    return {
        "date": df.index[-1].strftime("%Y-%m-%d"),
        "close": round(float(c[-1]), 2),
        "chg": round((float(c[-1]) / float(c[-2]) - 1.0) * 100.0, 2),
        "m1": spark[-1],
        "spark": spark,
        "rvol": round(float(v[-1]) / mean_vol, 2) if mean_vol > 0 else 0.0,
        "adv": int(prior_dollar.mean()),
        "n1": int(n1),
        "n2": int(n2),
        "bars": int(n - 1),
    }


# ------------------------------------------------------------ universe -----
def _flatten(cols) -> list[str]:
    out = []
    for col in cols:
        if isinstance(col, tuple):
            col = " ".join(str(x) for x in col if not str(x).startswith("Unnamed"))
        out.append(str(col).strip())
    return out


def parse_constituents(tables: list[pd.DataFrame], min_rows: int) -> pd.DataFrame | None:
    """Find the table that looks like an index constituents list and return
    columns symbol / name / sector / yf (Yahoo-style ticker)."""
    for t in tables:
        cols = _flatten(t.columns)
        low = [c.lower() for c in cols]
        sym_i = next((i for i, c in enumerate(low) if "symbol" in c or "ticker" in c), None)
        if sym_i is None or len(t) < min_rows:
            continue
        name_i = next((i for i, c in enumerate(low) if "security" in c or "company" in c), None)
        sec_i = next((i for i, c in enumerate(low) if "sector" in c and "sub" not in c), None)

        out = pd.DataFrame({
            "symbol": t.iloc[:, sym_i].astype(str).str.replace(r"\[.*?\]", "", regex=True).str.strip(),
            "name": t.iloc[:, name_i].astype(str).str.strip() if name_i is not None else "",
            "sector": t.iloc[:, sec_i].astype(str).str.strip() if sec_i is not None else "",
        })
        out = out[out["symbol"].str.fullmatch(r"[A-Za-z][A-Za-z0-9.\-]{0,9}")].copy()
        if len(out) < min_rows:
            continue
        out["name"] = out["name"].where(out["name"] != "", out["symbol"])
        out["sector"] = out["sector"].replace("nan", "")
        out["yf"] = out["symbol"].str.replace(".", "-", regex=False)
        return out.reset_index(drop=True)
    return None


def load_constituents() -> tuple[pd.DataFrame, dict]:
    import requests

    frames, loaded = [], {}
    for code, label, url, min_rows in SOURCES:
        try:
            resp = requests.get(url, headers={"User-Agent": "us-breakout-screener/1.0"}, timeout=30)
            resp.raise_for_status()
            df = parse_constituents(pd.read_html(io.StringIO(resp.text)), min_rows)
            if df is None:
                raise ValueError("no constituents table found")
            df["idx"] = code
            frames.append(df)
            loaded[code] = {"label": label, "count": int(len(df))}
        except Exception as e:  # one failing list should not sink the whole run
            print(f"WARNING: could not load {label}: {e}", file=sys.stderr)

    if not frames:
        raise RuntimeError("none of the index lists could be loaded")

    merged = (
        pd.concat(frames, ignore_index=True)
        .groupby("yf", sort=False)
        .agg(symbol=("symbol", "first"), name=("name", "first"),
             sector=("sector", lambda s: next((x for x in s if x), "")),
             idx=("idx", lambda s: list(dict.fromkeys(s))))
        .reset_index()
    )
    return merged, loaded


# ------------------------------------------------------------------ prices --
PRICE_COLS = ["Open", "High", "Low", "Close", "Volume"]


def _download(chunk: list[str]) -> dict[str, pd.DataFrame]:
    import yfinance as yf

    # auto_adjust=False -> prices are split-adjusted but not dividend-adjusted,
    # which is what most charting platforms show.
    data = yf.download(chunk, period=HISTORY_PERIOD, interval="1d", auto_adjust=False,
                       group_by="ticker", threads=True, progress=False)
    out: dict[str, pd.DataFrame] = {}
    for t in chunk:
        try:
            if isinstance(data.columns, pd.MultiIndex):
                if t not in data.columns.get_level_values(0):
                    continue
                sub = data[t]
            else:
                sub = data
            sub = sub[PRICE_COLS].dropna(subset=["Open", "High", "Low", "Close"])
            if not sub.empty:
                out[t] = sub
        except KeyError:
            continue
    return out


def download_prices(tickers: list[str], batch: int = 100) -> dict[str, pd.DataFrame]:
    frames: dict[str, pd.DataFrame] = {}
    for i in range(0, len(tickers), batch):
        frames.update(_download(tickers[i:i + batch]))
    missing = [t for t in tickers if t not in frames]      # one retry, in smaller batches
    for i in range(0, len(missing), 25):
        frames.update(_download(missing[i:i + 25]))
    return frames


def drop_incomplete_today(df: pd.DataFrame) -> pd.DataFrame:
    """Never screen a candle that may still be forming."""
    now_utc = dt.datetime.now(dt.timezone.utc)
    if df.index[-1].date() == now_utc.date() and now_utc.hour < 21:
        return df.iloc[:-1]
    return df


# ------------------------------------------------------------------- page ---
TEMPLATE = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>US Breakout Screener</title>
<style>
  :root {
    --bg:#fbfbf9; --fg:#1c1c1a; --muted:#6b6b66; --line:#e3e2dc; --card:#ffffff;
    --up:#0f7b4d; --down:#c23a2b; --accent:#2b5fd9; --chip:#eeede7; --chipon:#2b5fd9; --chipfg:#ffffff;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#141413; --fg:#ecebe6; --muted:#9a9990; --line:#2c2c29; --card:#1b1b19;
            --up:#4cc38a; --down:#ff7566; --accent:#7ba0ff; --chip:#262624; --chipon:#7ba0ff; --chipfg:#101010; }
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg);
         font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  .wrap { max-width:1240px; margin:0 auto; padding:28px 16px 48px; }
  h1 { font-size:22px; margin:0 0 4px; letter-spacing:-.01em; }
  .sub { color:var(--muted); font-size:13px; margin-bottom:18px; }
  .stats { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:16px; }
  .stat { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:10px 14px; }
  .stat b { display:block; font-size:20px; font-variant-numeric:tabular-nums; }
  .stat span { color:var(--muted); font-size:12px; }
  .ctl { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px; margin-bottom:16px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:12px; }
  label { display:block; font-size:12px; color:var(--muted); }
  input, select { width:100%; margin-top:4px; padding:7px 9px; font:inherit; color:var(--fg);
                  background:var(--bg); border:1px solid var(--line); border-radius:7px; }
  .chips { display:flex; flex-wrap:wrap; gap:6px; margin-top:12px; align-items:center; }
  .chips .lbl { font-size:12px; color:var(--muted); margin-right:2px; }
  .chip { background:var(--chip); color:var(--fg); border:0; border-radius:999px; padding:4px 12px;
          font:inherit; font-size:13px; cursor:pointer; }
  .chip.on { background:var(--chipon); color:var(--chipfg); }
  .chk { display:inline-flex; align-items:center; gap:6px; background:var(--chip); border-radius:999px;
         padding:4px 12px; font-size:13px; color:var(--fg); cursor:pointer; margin:0; }
  .chk input { width:auto; margin:0; }
  .rule { color:var(--muted); font-size:13px; margin:12px 0 0; }
  .reset { float:right; background:none; border:0; color:var(--accent); font:inherit; font-size:13px; cursor:pointer; padding:0; }
  .tw { overflow-x:auto; border:1px solid var(--line); border-radius:10px; background:var(--card); }
  table { width:100%; border-collapse:collapse; font-variant-numeric:tabular-nums; white-space:nowrap; }
  th, td { padding:9px 9px; text-align:right; border-bottom:1px solid var(--line); }
  th:nth-child(-n+4), td:nth-child(-n+4) { text-align:left; }
  th { font-size:12px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); cursor:pointer; user-select:none; }
  th:first-child { cursor:default; }
  th:hover { color:var(--fg); }
  tr:last-child td { border-bottom:0; }
  td a { color:var(--accent); text-decoration:none; }
  .nm { display:block; color:var(--muted); font-size:12px; max-width:220px; overflow:hidden; text-overflow:ellipsis; }
  .up { color:var(--up); font-weight:600; }
  .dn { color:var(--down); font-weight:600; }
  svg.spark { display:block; margin-left:auto; overflow:visible; }
  svg.spark .pos { fill:var(--up); }
  svg.spark .neg { fill:var(--down); }
  svg.spark .zero { stroke:var(--line); stroke-width:1; }
  .empty { text-align:center !important; color:var(--muted); padding:28px; }
  .foot { color:var(--muted); font-size:12px; margin-top:16px; }
  .warn { color:#b3541e; }
</style>
</head>
<body>
<div class="wrap">
  <h1>US Breakout Screener</h1>
  <div class="sub" id="sub"></div>

  <div class="stats">
    <div class="stat"><b id="s-scanned">0</b><span>stocks scanned</span></div>
    <div class="stat"><b id="s-match">0</b><span>match your settings</span></div>
    <div class="stat"><b id="s-shown">0</b><span>shown</span></div>
  </div>

  <section class="ctl">
    <button class="reset" id="reset" type="button">Reset</button>
    <div class="grid">
      <label>Lookback (sessions)<input id="n" type="number" inputmode="numeric" min="5" step="1"></label>
      <label>Min avg daily $ volume (M)<input id="adv" type="number" inputmode="decimal" min="0" step="1"></label>
      <label>Min price ($)<input id="px" type="number" inputmode="decimal" min="0" step="0.5"></label>
      <label>Max day change (%)<input id="cap" type="number" inputmode="decimal" min="0" step="1" placeholder="no cap"></label>
      <label>Show<select id="top">
        <option value="20">Top 20</option><option value="50">Top 50</option>
        <option value="100">Top 100</option><option value="0">All matches</option></select></label>
    </div>
    <div class="chips"><span class="lbl">Lookback presets</span><span id="presets"></span></div>
    <div class="chips"><span class="lbl">Indices</span><span id="indices"></span></div>
    <p class="rule" id="rule"></p>
  </section>

  <div class="tw"><table id="t"><thead><tr id="hr"></tr></thead><tbody id="tb"></tbody></table></div>

  <p class="foot" id="foot"></p>
  <p class="foot">End-of-day data from Yahoo Finance via yfinance (unofficial; split-adjusted, not dividend-adjusted).
  Avg daily $ volume = average of close &times; volume over the 20 sessions before the signal day.
  The 1-month chart has one bar per session (21 sessions): each bar is the return of that day&rsquo;s close vs the close one month before the last bar, green above that level and red below it.
  For information only, not investment advice.</p>
</div>

<script>
const DATA = __DATA__;
const ROWS = DATA.rows, META = DATA.meta;
const DEF = {n: 200, adv: 10, px: 5, cap: 15, top: 20};
const PRESETS = [20, 50, 100, 150, 200, 252];
const COLS = [
  {k: "sym", t: "Symbol"}, {k: "idxs", t: "Index"}, {k: "sector", t: "Sector"},
  {k: "close", t: "Close", num: 1}, {k: "chg", t: "Day %", num: 1},
  {k: "m1", t: "1M %", num: 1, tip: "Return over the last ~21 trading sessions"},
  {k: "spark", t: "1 month", chart: 1, tip: "Bars: return vs the close one month ago, one bar per session. Green = above, red = below."},
  {k: "rvol", t: "Rel vol", num: 1, tip: "Today's volume vs the average of the previous 20 sessions"},
  {k: "adv", t: "Avg $ vol", num: 1, tip: "Average daily dollar volume, previous 20 sessions"},
  {k: "n1", t: "Cleared", num: 1, tip: "Number of previous sessions whose highs today's close is above (the longest lookback it would pass)"}
];
const $ = id => document.getElementById(id);
const sort = {k: "chg", asc: false};

for (const r of ROWS) r.idxs = r.idx.join(" ");

function setDefaults() {
  $("n").value = DEF.n; $("adv").value = DEF.adv; $("px").value = DEF.px;
  $("cap").value = DEF.cap; $("top").value = DEF.top;
  document.querySelectorAll(".idx").forEach(e => e.checked = true);
}

function buildStatic() {
  $("sub").textContent = "Session of " + META.date + " · refreshed " + META.generated;
  $("s-scanned").textContent = META.scanned.toLocaleString("en-US");
  const pre = $("presets");
  for (const n of PRESETS) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "chip"; b.textContent = n; b.dataset.n = n;
    b.addEventListener("click", () => { $("n").value = n; update(); });
    pre.appendChild(b);
  }
  const box = $("indices");
  for (const ix of META.indices) {
    const l = document.createElement("label"); l.className = "chk";
    const c = document.createElement("input"); c.type = "checkbox"; c.className = "idx"; c.value = ix.code; c.checked = true;
    c.addEventListener("change", update);
    l.appendChild(c); l.appendChild(document.createTextNode(ix.label + " (" + ix.count + ")"));
    box.appendChild(l);
  }
  let foot = "Universe: " + META.indices.map(i => i.label).join(", ") + ".";
  $("foot").textContent = foot;
  if (META.failed.length) {
    const w = document.createElement("span"); w.className = "warn";
    w.textContent = " Not loaded on this run: " + META.failed.join(", ") + ".";
    $("foot").appendChild(w);
  }
  for (const id of ["n", "adv", "px", "cap"]) $(id).addEventListener("input", update);
  $("top").addEventListener("change", update);
  $("reset").addEventListener("click", () => { setDefaults(); update(); });
}

function matches() {
  const N = parseInt($("n").value, 10);
  if (!(N >= META.minLookback)) return null;
  const minAdv = (parseFloat($("adv").value) || 0) * 1e6;
  const minPx = parseFloat($("px").value) || 0;
  const capRaw = $("cap").value.trim();
  const cap = capRaw === "" || isNaN(parseFloat(capRaw)) ? Infinity : parseFloat(capRaw);
  const sel = new Set([...document.querySelectorAll(".idx:checked")].map(e => e.value));
  return ROWS.filter(r => N > r.n2 + 1 && N <= r.n1 && r.adv >= minAdv && r.close >= minPx
                          && r.chg <= cap && r.idx.some(i => sel.has(i)));
}

function cell(text, cls) {
  const td = document.createElement("td"); td.textContent = text; if (cls) td.className = cls; return td;
}
const SVGNS = "http://www.w3.org/2000/svg";
function sparkCell(vals, m1) {
  const BW = 4, GAP = 1, H = 28, n = vals.length;
  const top = Math.max(0, ...vals), bot = Math.min(0, ...vals), rng = (top - bot) || 1;
  const y0 = top / rng * H;                       // zero line, placed so the whole range fits
  const svg = document.createElementNS(SVGNS, "svg");
  const w = n * (BW + GAP) - GAP;
  svg.setAttribute("class", "spark"); svg.setAttribute("width", w); svg.setAttribute("height", H);
  svg.setAttribute("viewBox", "0 0 " + w + " " + H); svg.setAttribute("role", "img");
  const label = "1-month return " + (m1 >= 0 ? "+" : "") + m1.toFixed(1) + "%";
  svg.setAttribute("aria-label", label);
  const title = document.createElementNS(SVGNS, "title"); title.textContent = label; svg.appendChild(title);
  const zl = document.createElementNS(SVGNS, "line");
  zl.setAttribute("class", "zero"); zl.setAttribute("x1", 0); zl.setAttribute("x2", w);
  zl.setAttribute("y1", y0); zl.setAttribute("y2", y0); svg.appendChild(zl);
  vals.forEach((v, i) => {
    const h = Math.max(Math.abs(v) / rng * H, 1);
    const r = document.createElementNS(SVGNS, "rect");
    const y = v >= 0 ? Math.max(y0 - h, 0) : y0;
    r.setAttribute("class", v >= 0 ? "pos" : "neg");
    r.setAttribute("x", i * (BW + GAP)); r.setAttribute("y", y);
    r.setAttribute("width", BW); r.setAttribute("height", h);
    svg.appendChild(r);
  });
  const td = document.createElement("td"); td.appendChild(svg); return td;
}
const fmt2 = x => x.toLocaleString("en-US", {minimumFractionDigits: 2, maximumFractionDigits: 2});

function update() {
  const N = parseInt($("n").value, 10);
  document.querySelectorAll("#presets .chip").forEach(b => b.classList.toggle("on", +b.dataset.n === N));
  $("rule").textContent = N >= META.minLookback
    ? "Close is above the highest high of the previous " + N + " sessions, and yesterday’s close was not itself the highest close of its " + N + " sessions."
    : "Enter a lookback of at least " + META.minLookback + " sessions.";

  let list = matches();
  const matched = list ? list.length : 0;
  list = list ? list.slice() : [];
  const c = COLS.find(x => x.k === sort.k);
  list.sort((a, b) => {
    const x = a[sort.k], y = b[sort.k];
    const r = c.num ? x - y : String(x).localeCompare(String(y));
    return sort.asc ? r : -r;
  });
  const top = parseInt($("top").value, 10);
  if (top > 0) list = list.slice(0, top);

  $("s-match").textContent = matched.toLocaleString("en-US");
  $("s-shown").textContent = list.length.toLocaleString("en-US");

  const hr = $("hr"); hr.replaceChildren();
  const th0 = document.createElement("th"); th0.textContent = "#"; hr.appendChild(th0);
  for (const col of COLS) {
    const th = document.createElement("th");
    th.textContent = col.t + (sort.k === col.k ? (sort.asc ? " ▲" : " ▼") : "");
    if (col.tip) th.title = col.tip;
    if (col.chart) th.style.cursor = "default";
    else th.addEventListener("click", () => {
      if (sort.k === col.k) sort.asc = !sort.asc; else { sort.k = col.k; sort.asc = !col.num; }
      update();
    });
    hr.appendChild(th);
  }

  const tb = $("tb"); tb.replaceChildren();
  if (!list.length) {
    const tr = document.createElement("tr"); const td = cell("No stocks match these settings. Try a shorter lookback or relax the liquidity filter.", "empty");
    td.colSpan = COLS.length + 1; tr.appendChild(td); tb.appendChild(tr); return;
  }
  list.forEach((r, i) => {
    const tr = document.createElement("tr");
    tr.appendChild(cell(i + 1));
    const s = document.createElement("td");
    const a = document.createElement("a");
    a.href = "https://www.tradingview.com/chart/?symbol=" + encodeURIComponent(r.sym);
    a.target = "_blank"; a.rel = "noopener";
    const b = document.createElement("b"); b.textContent = r.sym; a.appendChild(b);
    const nm = document.createElement("span"); nm.className = "nm"; nm.textContent = r.name;
    s.appendChild(a); s.appendChild(nm); tr.appendChild(s);
    tr.appendChild(cell(r.idxs.replaceAll(" ", " · ")));
    tr.appendChild(cell(r.sector || "—"));
    tr.appendChild(cell(fmt2(r.close)));
    tr.appendChild(cell("+" + r.chg.toFixed(2) + "%", "up"));
    tr.appendChild(cell((r.m1 >= 0 ? "+" : "") + r.m1.toFixed(1) + "%", r.m1 >= 0 ? "up" : "dn"));
    tr.appendChild(sparkCell(r.spark, r.m1));
    tr.appendChild(cell(r.rvol.toFixed(1) + "×"));
    tr.appendChild(cell("$" + (r.adv / 1e6).toFixed(1) + "M"));
    tr.appendChild(cell((r.n1 >= r.bars ? "≥ " : "") + r.n1));
    tb.appendChild(tr);
  });
}

buildStatic(); setDefaults(); update();
</script>
</body>
</html>
"""


def render(rows: list[dict], meta: dict) -> str:
    payload = json.dumps({"rows": rows, "meta": meta}, separators=(",", ":")).replace("<", "\\u003c")
    return TEMPLATE.replace("__DATA__", payload)


# ------------------------------------------------------------------- main ---
def main() -> int:
    cons, loaded = load_constituents()
    prices = download_prices(cons["yf"].tolist())
    meta_by_yf = cons.set_index("yf")

    rows: list[dict] = []
    dates: list[str] = []
    scanned = 0
    for yf_sym, df in prices.items():
        df = drop_incomplete_today(df)
        if len(df) < MIN_BARS:
            continue
        scanned += 1
        dates.append(df.index[-1].strftime("%Y-%m-%d"))
        st = breakout_stats(df)
        if st:
            m = meta_by_yf.loc[yf_sym]
            st.update(sym=m["symbol"], name=m["name"], sector=m["sector"], idx=list(m["idx"]))
            rows.append(st)

    if scanned < MIN_TICKERS:
        print(f"Only {scanned} tickers returned data; refusing to publish a partial page.", file=sys.stderr)
        return 1

    data_date = pd.Series(dates).mode().iloc[0]        # ignore stragglers with stale last bars
    rows = [r for r in rows if r.pop("date") == data_date]

    meta = {
        "date": data_date,
        "generated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "scanned": scanned,
        "minLookback": MIN_LOOKBACK,
        "indices": [{"code": c, "label": v["label"], "count": v["count"]} for c, v in loaded.items()],
        "failed": [label for code, label, _, _ in SOURCES if code not in loaded],
    }
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(render(rows, meta), encoding="utf-8")
    print(f"Scanned {scanned}; {len(rows)} stocks are breakouts for at least one lookback; session {data_date}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
