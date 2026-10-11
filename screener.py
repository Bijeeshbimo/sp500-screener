#!/usr/bin/env python3
"""
S&P 500 daily screener -> static HTML page.

Filters (all must pass on the latest completed daily candle):
  1. Open is within +/- OPEN_TOL_PCT of the 20 EMA ("slightly below to slightly above").
  2. 50 EMA has been above the 200 EMA on each of the last EMA_LOOKBACK_DAYS sessions.
  3. Today's candle is a big bullish one:
       - close > open
       - body >= BIG_BODY_MULT x the average body of the previous 20 candles
       - close is above the highs of the previous 2 candles
  4. Daily change (close vs previous close) is positive and <= MAX_DAILY_CHANGE_PCT.

Survivors are ranked by daily change, descending; the top TOP_N are shown.
"""
from __future__ import annotations

import datetime as dt
import html
import io
import json
import sys
from pathlib import Path

import pandas as pd

# ---------------------------------------------------------------- settings --
OPEN_TOL_PCT = 1.0          # open must be within +/- this % of the 20 EMA
EMA_LOOKBACK_DAYS = 50      # 50 EMA must be > 200 EMA for this many sessions
BIG_BODY_MULT = 1.5         # body must be >= this x avg body of prior 20 candles
BODY_AVG_WINDOW = 20
ABOVE_PRIOR_CANDLES = 2     # close must exceed the highs of this many prior candles
MAX_DAILY_CHANGE_PCT = 15.0  # cap to drop extreme jumps
TOP_N = 20
HISTORY_PERIOD = "2y"       # enough warm-up for a stable 200 EMA

OUT_PATH = Path(__file__).parent / "docs" / "index.html"
WIKI_URL = "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies"


# ------------------------------------------------------------------ logic ---
def evaluate(df: pd.DataFrame) -> dict | None:
    """Apply the filters to one stock's OHLC frame (columns Open/High/Low/Close,
    ascending date index). Returns a metrics dict if it passes, else None."""
    df = df.dropna(subset=["Open", "High", "Low", "Close"])
    min_rows = 200 + EMA_LOOKBACK_DAYS  # EMA200 needs warm-up before the lookback window
    if len(df) < min_rows:
        return None

    close = df["Close"]
    ema20 = close.ewm(span=20, adjust=False).mean()
    ema50 = close.ewm(span=50, adjust=False).mean()
    ema200 = close.ewm(span=200, adjust=False).mean()

    o, h, c = df["Open"], df["High"], df["Close"]
    t_open, t_close = o.iloc[-1], c.iloc[-1]
    prev_close = c.iloc[-2]

    # 4. daily change within (0, cap]
    change_pct = (t_close / prev_close - 1.0) * 100.0
    if not (0.0 < change_pct <= MAX_DAILY_CHANGE_PCT):
        return None

    # 1. open hugging the 20 EMA (use the EMA as of the prior close: what was
    #    visible at the open)
    ema20_ref = ema20.iloc[-2]
    open_vs_ema = (t_open / ema20_ref - 1.0) * 100.0
    if abs(open_vs_ema) > OPEN_TOL_PCT:
        return None

    # 2. 50 EMA > 200 EMA for each of the last N sessions (including today)
    if not (ema50.iloc[-EMA_LOOKBACK_DAYS:] > ema200.iloc[-EMA_LOOKBACK_DAYS:]).all():
        return None

    # 3. big bullish candle closing above the previous candles' highs
    if t_close <= t_open:
        return None
    body = (c - o).abs()
    avg_body = body.iloc[-1 - BODY_AVG_WINDOW:-1].mean()
    body_ratio = body.iloc[-1] / avg_body if avg_body > 0 else float("inf")
    if body_ratio < BIG_BODY_MULT:
        return None
    prior_high = h.iloc[-1 - ABOVE_PRIOR_CANDLES:-1].max()
    if t_close <= prior_high:
        return None

    return {
        "close": float(t_close),
        "open": float(t_open),
        "change_pct": float(change_pct),
        "open_vs_ema20_pct": float(open_vs_ema),
        "ema20": float(ema20.iloc[-1]),
        "ema50": float(ema50.iloc[-1]),
        "ema200": float(ema200.iloc[-1]),
        "body_ratio": float(body_ratio),
        "date": df.index[-1].strftime("%Y-%m-%d"),
    }


# ------------------------------------------------------------------- data ---
def load_constituents() -> pd.DataFrame:
    import requests

    resp = requests.get(WIKI_URL, headers={"User-Agent": "sp500-screener/1.0"}, timeout=30)
    resp.raise_for_status()
    table = pd.read_html(io.StringIO(resp.text))[0]
    out = table[["Symbol", "Security", "GICS Sector"]].copy()
    out.columns = ["symbol", "name", "sector"]
    out["yf"] = out["symbol"].str.replace(".", "-", regex=False)
    return out


def download_prices(tickers: list[str], batch: int = 100) -> dict[str, pd.DataFrame]:
    import yfinance as yf

    frames: dict[str, pd.DataFrame] = {}
    for i in range(0, len(tickers), batch):
        chunk = tickers[i : i + batch]
        data = yf.download(
            chunk, period=HISTORY_PERIOD, interval="1d", auto_adjust=True,
            group_by="ticker", threads=True, progress=False,
        )
        for t in chunk:
            try:
                sub = data[t] if len(chunk) > 1 else data
                sub = sub[["Open", "High", "Low", "Close"]].dropna()
                if not sub.empty:
                    frames[t] = sub
            except KeyError:
                continue
    return frames


def drop_incomplete_today(df: pd.DataFrame) -> pd.DataFrame:
    """If the last bar is today's date and the US market may still be open,
    drop it so we only ever screen completed candles."""
    now_utc = dt.datetime.now(dt.timezone.utc)
    last = df.index[-1].date()
    market_closed = now_utc.hour >= 21  # 21:00 UTC is after the close year-round
    if last == now_utc.date() and not market_closed:
        return df.iloc[:-1]
    return df


# ------------------------------------------------------------------- html ---
def render(rows: list[dict], data_date: str, n_scanned: int, n_passed: int) -> str:
    now = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    esc = html.escape

    body_rows = []
    for i, r in enumerate(rows, 1):
        tv = f"https://www.tradingview.com/chart/?symbol={esc(r['yf'])}"
        body_rows.append(
            "<tr>"
            f"<td data-v='{i}'>{i}</td>"
            f"<td data-v='{esc(r['symbol'])}'><a href='{tv}' target='_blank' rel='noopener'><b>{esc(r['symbol'])}</b></a>"
            f"<span class='nm'>{esc(r['name'])}</span></td>"
            f"<td data-v='{esc(r['sector'])}'>{esc(r['sector'])}</td>"
            f"<td data-v='{r['close']:.4f}'>{r['close']:,.2f}</td>"
            f"<td data-v='{r['change_pct']:.4f}' class='up'>+{r['change_pct']:.2f}%</td>"
            f"<td data-v='{r['open_vs_ema20_pct']:.4f}'>{r['open_vs_ema20_pct']:+.2f}%</td>"
            f"<td data-v='{r['body_ratio']:.4f}'>{r['body_ratio']:.1f}&times;</td>"
            f"<td data-v='{r['ema20']:.4f}'>{r['ema20']:,.2f}</td>"
            f"<td data-v='{r['ema50']:.4f}'>{r['ema50']:,.2f}</td>"
            f"<td data-v='{r['ema200']:.4f}'>{r['ema200']:,.2f}</td>"
            "</tr>"
        )
    table = (
        "".join(body_rows)
        if body_rows
        else "<tr><td colspan='10' class='empty'>No stocks met all criteria on this session.</td></tr>"
    )

    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>S&amp;P 500 Screener</title>
<style>
  :root {{
    --bg:#fbfbf9; --fg:#1c1c1a; --muted:#6b6b66; --line:#e3e2dc; --card:#ffffff;
    --up:#0f7b4d; --accent:#2b5fd9;
  }}
  @media (prefers-color-scheme: dark) {{
    :root {{ --bg:#141413; --fg:#ecebe6; --muted:#9a9990; --line:#2c2c29; --card:#1b1b19;
             --up:#4cc38a; --accent:#7ba0ff; }}
  }}
  * {{ box-sizing:border-box; }}
  body {{ margin:0; background:var(--bg); color:var(--fg);
         font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }}
  .wrap {{ max-width:1100px; margin:0 auto; padding:28px 16px 48px; }}
  h1 {{ font-size:22px; margin:0 0 4px; letter-spacing:-.01em; }}
  .sub {{ color:var(--muted); font-size:13px; margin-bottom:18px; }}
  .stats {{ display:flex; gap:10px; flex-wrap:wrap; margin-bottom:18px; }}
  .stat {{ background:var(--card); border:1px solid var(--line); border-radius:10px; padding:10px 14px; }}
  .stat b {{ display:block; font-size:20px; font-variant-numeric:tabular-nums; }}
  .stat span {{ color:var(--muted); font-size:12px; }}
  details {{ background:var(--card); border:1px solid var(--line); border-radius:10px;
            padding:10px 14px; margin-bottom:18px; font-size:13.5px; }}
  summary {{ cursor:pointer; font-weight:600; }}
  details ol {{ margin:8px 0 0; padding-left:20px; color:var(--muted); }}
  .tw {{ overflow-x:auto; border:1px solid var(--line); border-radius:10px; background:var(--card); }}
  table {{ width:100%; border-collapse:collapse; font-variant-numeric:tabular-nums; white-space:nowrap; }}
  th, td {{ padding:9px 12px; text-align:right; border-bottom:1px solid var(--line); }}
  th:nth-child(-n+3), td:nth-child(-n+3) {{ text-align:left; }}
  th {{ font-size:12px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted);
       cursor:pointer; user-select:none; position:sticky; top:0; background:var(--card); }}
  th:hover {{ color:var(--fg); }}
  tr:last-child td {{ border-bottom:0; }}
  td a {{ color:var(--accent); text-decoration:none; }}
  .nm {{ display:block; color:var(--muted); font-size:12px; max-width:200px; overflow:hidden; text-overflow:ellipsis; }}
  .up {{ color:var(--up); font-weight:600; }}
  .empty {{ text-align:center !important; color:var(--muted); padding:28px; }}
  .foot {{ color:var(--muted); font-size:12px; margin-top:16px; }}
</style>
</head>
<body>
<div class="wrap">
  <h1>S&amp;P 500 Screener</h1>
  <div class="sub">Session of {esc(data_date)} &middot; refreshed {now}</div>

  <div class="stats">
    <div class="stat"><b>{n_scanned}</b><span>stocks scanned</span></div>
    <div class="stat"><b>{n_passed}</b><span>passed all filters</span></div>
    <div class="stat"><b>{len(rows)}</b><span>shown (top {TOP_N} by daily change)</span></div>
  </div>

  <details>
    <summary>Criteria</summary>
    <ol>
      <li>Open within &plusmn;{OPEN_TOL_PCT:g}% of the 20 EMA (EMA as of the prior close).</li>
      <li>50 EMA above 200 EMA on each of the last {EMA_LOOKBACK_DAYS} sessions.</li>
      <li>Big bullish candle: close &gt; open, body &ge; {BIG_BODY_MULT:g}&times; the average body of the prior {BODY_AVG_WINDOW} candles, and close above the highs of the prior {ABOVE_PRIOR_CANDLES} candles.</li>
      <li>Daily change above 0% and no more than {MAX_DAILY_CHANGE_PCT:g}% (filters out extreme jumps).</li>
    </ol>
  </details>

  <div class="tw">
    <table id="t">
      <thead><tr>
        <th>#</th><th>Symbol</th><th>Sector</th><th>Close</th><th>Day %</th>
        <th>Open vs 20 EMA</th><th>Body vs avg</th><th>20 EMA</th><th>50 EMA</th><th>200 EMA</th>
      </tr></thead>
      <tbody>{table}</tbody>
    </table>
  </div>

  <p class="foot">End-of-day data from Yahoo Finance via yfinance, which is unofficial and can contain errors.
  For information only, not investment advice.</p>
</div>
<script>
(function () {{
  var t = document.getElementById('t'), tb = t.tBodies[0], dir = {{}};
  Array.prototype.forEach.call(t.tHead.rows[0].cells, function (th, i) {{
    th.addEventListener('click', function () {{
      var asc = dir[i] = !dir[i];
      var rows = Array.prototype.slice.call(tb.rows).filter(function (r) {{ return r.cells.length > 1; }});
      rows.sort(function (a, b) {{
        var x = a.cells[i].dataset.v, y = b.cells[i].dataset.v;
        var nx = parseFloat(x), ny = parseFloat(y);
        var r = (isNaN(nx) || isNaN(ny)) ? String(x).localeCompare(String(y)) : nx - ny;
        return asc ? r : -r;
      }});
      rows.forEach(function (r) {{ tb.appendChild(r); }});
    }});
  }});
}})();
</script>
</body>
</html>
"""


# ------------------------------------------------------------------- main ---
def main() -> int:
    cons = load_constituents()
    prices = download_prices(cons["yf"].tolist())
    meta = cons.set_index("yf")

    passed: list[dict] = []
    scanned = 0
    data_dates: list[str] = []
    for yf_sym, df in prices.items():
        df = drop_incomplete_today(df)
        if df.empty:
            continue
        scanned += 1
        data_dates.append(df.index[-1].strftime("%Y-%m-%d"))
        res = evaluate(df)
        if res:
            res.update(yf=yf_sym, symbol=meta.loc[yf_sym, "symbol"],
                       name=meta.loc[yf_sym, "name"], sector=meta.loc[yf_sym, "sector"])
            passed.append(res)

    if scanned < 400:
        print(f"Only {scanned} tickers returned data; refusing to publish a partial page.", file=sys.stderr)
        return 1

    # Use the most common last-bar date as the session date; ignore stragglers
    data_date = pd.Series(data_dates).mode().iloc[0]
    passed = [r for r in passed if r["date"] == data_date]
    passed.sort(key=lambda r: r["change_pct"], reverse=True)
    top = passed[:TOP_N]

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(render(top, data_date, scanned, len(passed)), encoding="utf-8")
    (OUT_PATH.parent / "results.json").write_text(json.dumps(top, indent=2), encoding="utf-8")
    print(f"Scanned {scanned}, passed {len(passed)}, wrote top {len(top)} for {data_date}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
