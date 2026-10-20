#!/usr/bin/env python3
"""
Breakout screener (US + India) -> one static HTML page whose filters you can change in the browser.

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

Markets (each with its own currency, units, defaults, session date and RS ranking):
  US     S&P 500 + S&P 400 + S&P 600 + Nasdaq-100 (de-duplicated)
  India  NSE: Nifty 50 + Nifty Next 50 + Midcap 150 + Smallcap 250 (= Nifty 500), Yahoo ".NS" tickers
Liquidity, minimum price and a max-daily-change cap are applied on the page.
"""
from __future__ import annotations

import datetime as dt
import io
import json
import re
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

# ---------------------------------------------------------------- settings --
MIN_LOOKBACK = 5            # smallest lookback offered on the page
MIN_BARS = 30               # ignore tickers with less history than this
HISTORY_PERIOD = "3y"       # allows lookbacks up to roughly 750 sessions
ADV_WINDOW = 20             # sessions (before the signal day) for average volume
SPARK_DAYS = 21             # sessions in the 1-month bar chart (about one trading month)
RSI_PERIOD = 14             # Wilder RSI length
EMA_FAST = 20               # EMA used for the "extension" measure
RS_LOOKBACK = 126          # sessions (about 6 months) for the relative-strength rank
EMA_SLOW = 50                # second EMA drawn on the hover chart
ATR_PERIOD = 14
SETTLE_MINUTES = 15       # wait this long after the close before trusting the day's final candle
PREVIEW_DAYS = 126          # sessions of candles shown in the hover chart

# Per-market settings. "defaults" are the starting values of the liquidity / price / day-change filters;
# adv is in advUnit (US: $ million, India: Rs crore, 1 crore = 10 million). tz/close is the cash-market
# closing time (daylight saving is handled automatically); a candle is only screened once SETTLE_MINUTES have passed
# since the close, so a candle that is still forming (or that Yahoo is still revising) is never used.
MARKETS = {
    "US": {
        "name": "US", "currency": "$", "advUnit": "M", "advFactor": 1e6, "locale": "en-US", "tvPrefix": "",
        "advLabel": "Min avg daily $ volume ($M)", "pxLabel": "Min price ($)",
        "advHeader": "Avg $ vol (M)", "advTip": "Average daily dollar volume (close x volume), previous 20 sessions",
        "footNote": "Avg daily $ volume = average of close \u00d7 volume over the 20 sessions before the signal day.",
        "defaults": {"adv": 10, "px": 5, "cap": 15},
        "tz": "America/New_York", "close": (16, 0), "min_tickers": 400,
    },
    "IN": {
        "name": "India (NSE)", "currency": "\u20b9", "advUnit": "Cr", "advFactor": 1e7, "locale": "en-IN", "tvPrefix": "NSE:", "bands": [5, 10, 20],
        "advLabel": "Min avg daily turnover (\u20b9 crore)", "pxLabel": "Min price (\u20b9)",
        "advHeader": "Avg turnover (Cr)", "advTip": "Average daily turnover in \u20b9 crore (close x volume), previous 20 sessions",
        "footNote": "Avg daily turnover = average of close \u00d7 volume over the 20 sessions before the signal day, in \u20b9 crore "
                    "(1 crore = 10 million rupees). NSE price bands of 5%, 10% or 20% limit how far a stock can move in one day.",
        "defaults": {"adv": 10, "px": 50, "cap": 15},
        "tz": "Asia/Kolkata", "close": (15, 30), "min_tickers": 300,
    },
}

OUT_PATH = Path(__file__).parent / "docs" / "index.html"

# code, label, page, minimum rows the constituents table should have
SOURCES = [
    ("SPX", "S&P 500", "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies", 400),
    ("MID", "S&P 400", "https://en.wikipedia.org/wiki/List_of_S%26P_400_companies", 300),
    ("SML", "S&P 600", "https://en.wikipedia.org/wiki/List_of_S%26P_600_companies", 450),
    # Wikipedia's Nasdaq-100 article no longer carries a constituents table, so use stockanalysis.com
    ("NDX", "Nasdaq-100", "https://stockanalysis.com/list/nasdaq-100-stocks/", 80),
]

# India: NSE publishes each index's constituents as a CSV (Company Name, Industry, Symbol, Series, ISIN Code).
# Nifty 500 = Nifty 50 + Nifty Next 50 + Midcap 150 + Smallcap 250, so loading the four pieces gives the sub-index chips.
NSE_BASES = ("https://nsearchives.nseindia.com/content/indices/", "https://www.niftyindices.com/IndexConstituent/")
NSE_LISTS = [  # code, label, file, minimum rows
    ("N50", "Nifty 50", "ind_nifty50list.csv", 45),
    ("NN50", "Nifty Next 50", "ind_niftynext50list.csv", 45),
    ("MID150", "Midcap 150", "ind_niftymidcap150list.csv", 130),
    ("SML250", "Smallcap 250", "ind_niftysmallcap250list.csv", 220),
]
NSE_ALL = ("N500", "Nifty 500", "ind_nifty500list.csv", 450)     # used only to fill gaps
NSE_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "Accept": "text/csv,*/*;q=0.8", "Accept-Language": "en-US,en;q=0.9",
}
NSE_RETRY_DELAY = 2   # seconds between attempts

# Used only if the live Nasdaq-100 source cannot be loaded, so the index never silently disappears.
# Snapshot of 2026-10-12; membership changes a few times a year, so treat it as approximate.
NASDAQ100_FALLBACK_DATE = "2026-10-12"
NASDAQ100_FALLBACK = (
    "NVDA AAPL GOOGL GOOG MSFT AMZN SPCX META AVGO TSLA MU AMD WMT ASML INTC PLTR CSCO COST AMAT LRCX "
    "PANW NFLX ARM CRWD TXN KLAC MRVL SNDK AMGN LIN SHOP ADI GILD QCOM STX PEP TMUS ISRG WDC FTNT VRTX "
    "BKNG PDD ADP CEG DDOG SBUX LITE ABNB SNPS CDNS MELI MAR ADBE APP CSX MNST DASH INTU CTAS MDLZ REGN "
    "CMCSA ROST ORLY MPWR AEP HON TER NBIS ALAB MSTR FAST NXPI PCAR BKR FANG HONA ADSK PYPL XEL CCEP "
    "CRWV WDAY TRI KDP EXC MCHP RKLB IDXX TTWO ODFL PAYX FER ROP AXON DXCM ALNY GEHC CPRT"
).split()


# ------------------------------------------------------------------ logic ---
def rsi_wilder(close, period: int = RSI_PERIOD) -> float | None:
    """Wilder's RSI at the last bar: first averages are simple means of the first `period`
    changes, then Wilder smoothing (the textbook method used by charting platforms)."""
    c = np.asarray(close, dtype=float)
    if len(c) <= period:
        return None
    d = np.diff(c)
    gain, loss = np.where(d > 0, d, 0.0), np.where(d < 0, -d, 0.0)
    avg_g, avg_l = gain[:period].mean(), loss[:period].mean()
    for g, l in zip(gain[period:], loss[period:]):
        avg_g = (avg_g * (period - 1) + g) / period
        avg_l = (avg_l * (period - 1) + l) / period
    if avg_l == 0:
        return 100.0 if avg_g > 0 else 50.0
    return float(100.0 - 100.0 / (1.0 + avg_g / avg_l))


def six_month_return(df: pd.DataFrame) -> float | None:
    """Return over the last RS_LOOKBACK sessions, or None if there is not enough history."""
    c = df["Close"].to_numpy(dtype=float)
    if len(c) <= RS_LOOKBACK or c[-1 - RS_LOOKBACK] <= 0:
        return None
    return float(c[-1] / c[-1 - RS_LOOKBACK] - 1.0)


def rs_ranks(returns: dict[str, float]) -> dict[str, int]:
    """Percentile rank 0-99 of each stock's return among all stocks given (99 = strongest)."""
    if len(returns) < 2:
        return {}
    r = pd.Series(returns).rank(method="average")
    return {k: int(round((v - 1) / (len(r) - 1) * 99)) for k, v in r.items()}


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
    cs = pd.Series(c)
    e_fast = cs.ewm(span=EMA_FAST, adjust=False).mean().to_numpy()
    e_slow = cs.ewm(span=EMA_SLOW, adjust=False).mean().to_numpy()
    ema_fast = float(e_fast[-1])
    # Breakout level for ANY lookback N = highest high of the previous N sessions. As N grows this is a
    # staircase, so keep only the steps: [[k, level], ...] means "from N = k sessions on, the level is `level`".
    prev_hi = np.maximum.accumulate(h[:-1][::-1])
    steps = [[int(i + 1), round(float(prev_hi[i]), 2)] for i in range(len(prev_hi))
             if i == 0 or prev_hi[i] > prev_hi[i - 1]]
    pv = min(PREVIEW_DAYS, n)
    r2 = lambda a: np.round(np.asarray(a, dtype=float)[-pv:], 2).tolist()
    cx = {
        "o": r2(df["Open"].to_numpy(dtype=float)), "h": r2(h), "l": r2(df["Low"].to_numpy(dtype=float)), "c": r2(c),
        "v": [int(x / 1000) for x in v[-pv:]], "e1": r2(e_fast), "e2": r2(e_slow),
        "d0": df.index[-pv].strftime("%Y-%m-%d"), "d1": df.index[-1].strftime("%Y-%m-%d"),
    }
    rsi = rsi_wilder(c)

    # --- extra context for the "insights" on the page (none of this depends on the lookback N) ---
    lo = df["Low"].to_numpy(dtype=float)
    o_ = df["Open"].to_numpy(dtype=float)
    pc = np.r_[c[0], c[:-1]]
    tr = np.maximum.reduce([h - lo, np.abs(h - pc), np.abs(lo - pc)])
    atr = float(tr[-1 - ATR_PERIOD:-1].mean())                         # average true range of the 14 sessions before today
    span = h[-1] - lo[-1]
    prior = slice(-1 - 252, -1)                                         # the previous ~52 weeks
    base_lo = float(lo[-21:-1].min())
    x = {
        "cp": round(float((c[-1] - lo[-1]) / span * 100.0), 1) if span > 0 else None,   # where the close sits in the day's range
        "gap": round((float(o_[-1]) / float(c[-2]) - 1.0) * 100.0, 2),                # open vs yesterday's close
        "atr": round(atr, 2),
        "atrp": round(atr / float(c[-2]) * 100.0, 2) if c[-2] > 0 else None,
        "rg": round(float(tr[-1]) / atr, 1) if atr > 0 else None,                      # today's range in units of normal
        "h52": round(float(h[prior].max()), 2), "l52": round(float(lo[prior].min()), 2),
        "s200": round(float(c[-200:].mean()), 2) if n >= 200 else None,
        "b20": round((float(h[-21:-1].max()) / base_lo - 1.0) * 100.0, 1) if base_lo > 0 else None,   # 20-day range before today
    }
    return {
        "date": df.index[-1].strftime("%Y-%m-%d"),
        "close": round(float(c[-1]), 2),
        "chg": round((float(c[-1]) / float(c[-2]) - 1.0) * 100.0, 2),
        "m1": spark[-1],
        "spark": spark,
        "rsi": round(rsi, 1) if rsi is not None else None,
        "ext20": round((float(c[-1]) / ema_fast - 1.0) * 100.0, 1),
        "cx": cx,
        "x": x,
        "lv": steps,
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
            if code == "NDX":
                syms = list(dict.fromkeys(NASDAQ100_FALLBACK))
                frames.append(pd.DataFrame({
                    "symbol": syms, "name": syms, "sector": "",
                    "yf": [x.replace(".", "-") for x in syms], "idx": code}))
                loaded[code] = {
                    "label": label, "count": len(syms),
                    "note": f"{label} could not be loaded live, so a built-in list dated "
                            f"{NASDAQ100_FALLBACK_DATE} was used.",
                }
                print(f"WARNING: using built-in {label} list dated {NASDAQ100_FALLBACK_DATE}", file=sys.stderr)

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


def parse_nse_csv(text: str, min_rows: int) -> pd.DataFrame:
    """Parse one NSE index-constituents CSV into symbol / name / sector / yf (Yahoo '.NS' ticker).
    NSE pads some lists with placeholder rows such as 'DUMMYHEG'; those are dropped."""
    raw = pd.read_csv(io.StringIO(text), dtype=str).fillna("")
    raw.columns = [str(c).strip() for c in raw.columns]
    low = {c.lower(): c for c in raw.columns}
    if "symbol" not in low:
        raise ValueError("no Symbol column (not a constituents CSV)")
    sym = raw[low["symbol"]].str.strip()
    out = pd.DataFrame({
        "symbol": sym,
        "name": raw[low["company name"]].str.strip() if "company name" in low else sym,
        "sector": raw[low["industry"]].str.strip() if "industry" in low else "",
    })
    out = out[out["symbol"].str.fullmatch(r"[A-Za-z0-9][A-Za-z0-9&\-_.]{0,19}")]
    out = out[~out["symbol"].str.upper().str.startswith("DUMMY")].drop_duplicates("symbol").copy()
    if len(out) < min_rows:
        raise ValueError(f"only {len(out)} usable rows (expected at least {min_rows})")
    out["name"] = out["name"].where(out["name"] != "", out["symbol"])
    out["yf"] = out["symbol"] + ".NS"
    return out.reset_index(drop=True)


def _fetch_nse_csv(filename: str, min_rows: int, attempts: int = 2) -> pd.DataFrame:
    import requests

    last: Exception | None = None
    for base in NSE_BASES:
        for _ in range(attempts):
            try:
                resp = requests.get(base + filename, headers=NSE_HEADERS, timeout=30)
                resp.raise_for_status()
                return parse_nse_csv(resp.text, min_rows)
            except Exception as e:
                last = e
                time.sleep(NSE_RETRY_DELAY)
    raise RuntimeError(f"{filename}: {last}")


def _merge_frames(frames: list[pd.DataFrame]) -> pd.DataFrame:
    return (
        pd.concat(frames, ignore_index=True)
        .groupby("yf", sort=False)
        .agg(symbol=("symbol", "first"), name=("name", "first"),
             sector=("sector", lambda s: next((x for x in s if x), "")),
             idx=("idx", lambda s: list(dict.fromkeys(s))))
        .reset_index()
    )


def load_india_constituents() -> tuple[pd.DataFrame, dict]:
    frames, loaded = [], {}
    for code, label, filename, min_rows in NSE_LISTS:
        try:
            df = _fetch_nse_csv(filename, min_rows)
            df["idx"] = code
            frames.append(df)
            loaded[code] = {"label": label, "count": int(len(df))}
        except Exception as e:
            print(f"WARNING: could not load {label}: {e}", file=sys.stderr)

    have = set().union(*[set(f["yf"]) for f in frames]) if frames else set()
    code, label, filename, min_rows = NSE_ALL
    if len(have) < min_rows:                       # something is missing: fill the gap from the combined list
        try:
            df = _fetch_nse_csv(filename, min_rows)
            extra = df[~df["yf"].isin(have)].copy()
            if len(extra):
                had_parts = bool(frames)
                extra["idx"] = code
                frames.append(extra)
                loaded[code] = {
                    "label": "Other Nifty 500" if had_parts else label, "count": int(len(extra)),
                    "note": ("Some Nifty index lists could not be loaded, so the missing stocks were added from the "
                             "combined Nifty 500 list (shown as \u201cOther Nifty 500\u201d).") if had_parts else
                            "The individual Nifty index lists could not be loaded, so the combined Nifty 500 list was used.",
                }
        except Exception as e:
            print(f"WARNING: could not load {label}: {e}", file=sys.stderr)

    if not frames:
        raise RuntimeError("none of the NSE index lists could be loaded")
    return _merge_frames(frames), loaded


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


def drop_incomplete_today(df: pd.DataFrame, tz: str = "America/New_York", close: tuple = (16, 0),
                          settle: int = SETTLE_MINUTES) -> pd.DataFrame:
    """Never screen a candle that may still be forming: drop today's bar until `settle` minutes after the close."""
    from zoneinfo import ZoneInfo

    now = dt.datetime.now(dt.timezone.utc).astimezone(ZoneInfo(tz))
    ready = now.replace(hour=close[0], minute=close[1], second=0, microsecond=0) + dt.timedelta(minutes=settle)
    if df.index[-1].date() == now.date() and now < ready:
        return df.iloc[:-1]
    return df


# ------------------------------------------------------------------- page ---
TEMPLATE = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Breakout Screener</title>
<style>
  :root {
    --bg:#fbfbf9; --fg:#1c1c1a; --muted:#6b6b66; --line:#e3e2dc; --card:#ffffff;
    --up:#0f7b4d; --down:#c23a2b; --e20:#e5484d; --e50:#3b6fd8; --accent:#2b5fd9; --chip:#eeede7; --chipon:#2b5fd9; --chipfg:#ffffff;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#141413; --fg:#ecebe6; --muted:#9a9990; --line:#2c2c29; --card:#1b1b19;
            --up:#4cc38a; --down:#ff7566; --e20:#ff6b6b; --e50:#6c9bff; --accent:#7ba0ff; --chip:#262624; --chipon:#7ba0ff; --chipfg:#101010; }
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg);
         font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  .wrap { max-width:1360px; margin:0 auto; padding:28px 16px 48px; }
  h1 { font-size:22px; margin:0 0 4px; letter-spacing:-.01em; }
  .sub { color:var(--muted); font-size:13px; margin-bottom:18px; }
  .upd, .newdata button { font:inherit; font-size:12px; margin-left:8px; padding:3px 10px; border:1px solid var(--line); border-radius:999px; background:var(--card); color:var(--fg); cursor:pointer; }
  .upd:hover, .newdata button:hover { border-color:var(--accent); }
  .newdata { background:#e8f0fe; color:#1a3d8f; border:1px solid #b6cbf5; border-radius:10px; padding:9px 14px; font-size:13.5px; margin:-6px 0 16px; }
  @media (prefers-color-scheme: dark) { .newdata { background:#1b2a4a; color:#cfdcff; border-color:#2f4a85; } }
  .tabs { display:inline-flex; gap:4px; background:var(--chip); padding:3px; border-radius:999px; margin:6px 0 12px; }
  .tabs[hidden] { display:none; }
  .tab { border:0; background:none; color:var(--fg); font:inherit; font-size:14px; padding:5px 16px; border-radius:999px; cursor:pointer; }
  .tab[aria-selected="true"] { background:var(--card); box-shadow:0 1px 3px rgba(0,0,0,.18); font-weight:600; }
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
  .sub2 { color:var(--muted); font-size:12px; margin:16px 0 8px; }
  .sub2 span { opacity:.8; }
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
  .nm { display:block; color:var(--muted); font-size:12px; max-width:170px; overflow:hidden; text-overflow:ellipsis; }
  .up { color:var(--up); font-weight:600; }
  .dn { color:var(--down); font-weight:600; }
  svg.spark { display:block; margin-left:auto; overflow:visible; }
  svg.spark .pos { fill:var(--up); }
  svg.spark .neg { fill:var(--down); }
  svg.spark .zero { stroke:var(--line); stroke-width:1; }
  .empty { text-align:center !important; color:var(--muted); padding:28px; }
  .foot { color:var(--muted); font-size:12px; margin-top:16px; }
  .warn { color:#b3541e; }
  .hint { color:var(--muted); font-size:12px; margin:0 0 8px; }
  tbody tr:hover td { background:var(--chip); }
  tbody tr:focus { outline:2px solid var(--accent); outline-offset:-2px; }
  .pv { position:fixed; z-index:50; width:424px; max-width:calc(100vw - 16px); background:var(--card);
        border:1px solid var(--line); border-radius:10px; box-shadow:0 10px 30px rgba(0,0,0,.2);
        padding:10px 12px 8px; pointer-events:none; }
  .pv[hidden] { display:none; }
  .pv .hd { font-size:13px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .lg { display:flex; flex-wrap:wrap; gap:4px 14px; font-size:11px; color:var(--muted); margin:3px 0 6px; }
  .sw { display:inline-block; width:14px; border-top:2px solid; vertical-align:middle; margin-right:5px; }
  .sgs { white-space:nowrap; font-variant-numeric:tabular-nums; }
  .sgs span { margin-right:7px; font-weight:600; font-size:13px; }
  .sgs .g { color:var(--up); } .sgs .w { color:#c98a00; } .sgs .b { color:var(--down); }
  ul.ins { list-style:none; margin:8px 0 0; padding:0; font-size:12.5px; line-height:1.4; }
  ul.ins li { position:relative; padding-left:16px; margin:4px 0; }
  ul.ins li::before { content:"\25CF"; position:absolute; left:0; top:1px; font-size:10px; color:var(--muted); }
  ul.ins li.good::before { color:var(--up); } ul.ins li.warn::before { color:#d99a00; } ul.ins li.bad::before { color:var(--down); }
  .pv .more { font-size:11px; color:var(--muted); margin-top:6px; }
  tbody tr { cursor:pointer; }
  tbody tr.sel td { background:var(--chip); }
  .panel { position:fixed; z-index:60; top:0; right:0; bottom:0; width:430px; max-width:100vw; background:var(--card);
           border-left:1px solid var(--line); box-shadow:-10px 0 30px rgba(0,0,0,.22); overflow:auto; padding:14px 16px 28px; }
  .panel[hidden] { display:none; }
  .panel .top { display:flex; align-items:flex-start; justify-content:space-between; gap:10px; }
  .panel .top b { font-size:18px; } .panel .top .nm2 { color:var(--muted); font-size:13px; }
  .panel .x { border:1px solid var(--line); background:var(--bg); color:var(--fg); border-radius:8px; font-size:18px; line-height:1; padding:4px 10px; cursor:pointer; }
  .panel h3 { font-size:12px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); margin:16px 0 0; }
  .panel .stop { margin-top:12px; border:1px solid var(--line); border-radius:10px; padding:10px 12px; font-size:13px; background:var(--bg); }
  .panel .stop b { font-size:16px; }
  .panel .tally { margin-top:10px; font-size:13px; } .panel .tally .sgs { margin-right:14px; }
  .panel .links a { margin-right:14px; font-size:13px; }
  .panel .disc { color:var(--muted); font-size:11.5px; margin-top:16px; }
  @media (max-width:700px) { .panel { top:auto; height:80vh; width:100vw; border-left:0; border-top:1px solid var(--line); border-radius:14px 14px 0 0; } }
  svg.pvs { display:block; width:100%; height:auto; }
  .pvs .up { fill:var(--up); stroke:var(--up); }
  .pvs .dn { fill:var(--down); stroke:var(--down); }
  .pvs .vol { opacity:.45; stroke:none; }
  .pvs .wick { stroke-width:1; }
  .pvs .body { stroke:none; }
  .pvs .band { fill:var(--chip); }
  .pvs .grid { stroke:var(--line); stroke-width:1; }
  .pvs .ema { fill:none; stroke-width:1.4; stroke-linejoin:round; }
  .pvs .e1 { stroke:var(--e20); }
  .pvs .e2 { stroke:var(--e50); }
  .pvs .lvl { stroke:var(--fg); stroke-width:1; stroke-dasharray:4 3; }
  .pvs text { font:10px system-ui,sans-serif; fill:var(--muted); }
  .pvs .lvt { fill:var(--fg); }
</style>
</head>
<body>
<div class="wrap">
  <h1>Breakout Screener <a href="paper.html" class="upd" style="text-decoration:none">Paper trading &rarr;</a></h1>
  <div class="tabs" id="tabs" role="tablist"></div>
  <div class="sub"><span id="sub"></span> <button type="button" class="upd" id="chk">Check for new data</button> <span id="chk-msg" aria-live="polite"></span></div>
  <div class="newdata" id="newdata" hidden>New data is available. <button type="button" id="loadnew">Load it</button></div>

  <div class="stats">
    <div class="stat"><b id="s-scanned">0</b><span>stocks scanned</span></div>
    <div class="stat"><b id="s-match">0</b><span>match your settings</span></div>
    <div class="stat"><b id="s-shown">0</b><span>shown</span></div>
  </div>

  <section class="ctl">
    <button class="reset" id="reset" type="button">Reset</button>
    <div class="grid">
      <label>Lookback (sessions)<input id="n" type="number" inputmode="numeric" min="5" step="1"></label>
      <label><span id="l-adv">Min avg daily $ volume ($M)</span><input id="adv" type="number" inputmode="decimal" min="0" step="1"></label>
      <label><span id="l-px">Min price ($)</span><input id="px" type="number" inputmode="decimal" min="0" step="0.5"></label>
      <label>Max day change (%)<input id="cap" type="number" inputmode="decimal" min="0" step="1" placeholder="no cap"></label>
      <label>Show<select id="top">
        <option value="20">Top 20</option><option value="50">Top 50</option>
        <option value="100">Top 100</option><option value="0">All matches</option></select></label>
    </div>
    <div class="sub2">Entry quality <span>(optional &middot; leave blank for no filter)</span></div>
    <div class="grid">
      <label>RSI(14) min<input id="rmin" type="number" inputmode="decimal" min="0" max="100" step="1" placeholder="e.g. 55"></label>
      <label>RSI(14) max<input id="rmax" type="number" inputmode="decimal" min="0" max="100" step="1" placeholder="e.g. 80"></label>
      <label>Max % above 20 EMA<input id="ext" type="number" inputmode="decimal" step="0.5" placeholder="e.g. 8"></label>
      <label>Min relative volume (&times;)<input id="rv" type="number" inputmode="decimal" min="0" step="0.1" placeholder="e.g. 1.5"></label>
      <label>Min RS rank (0&ndash;99)<input id="rs" type="number" inputmode="numeric" min="0" max="99" step="1" placeholder="e.g. 80"></label>
    </div>
    <div class="chips"><span class="lbl">Lookback presets</span><span id="presets"></span></div>
    <div class="chips"><span class="lbl">Indices</span><span id="indices"></span></div>
    <p class="rule" id="rule"></p>
  </section>

  <p class="hint">Hover a row for a 6-month chart (candles, 20 EMA red, 50 EMA blue, volume, breakout level) and the key checks. Click a row to pin the full checklist and a reference stop.</p>
  <div class="tw"><table id="t"><thead><tr id="hr"></tr></thead><tbody id="tb"></tbody></table></div>

  <p class="foot" id="foot"></p>
  <p class="foot">End-of-day data from Yahoo Finance via yfinance (unofficial; split-adjusted, not dividend-adjusted).
  <span id="foot2"></span>
  RSI is Wilder&rsquo;s 14-day RSI. &ldquo;vs 20 EMA&rdquo; is how far the close sits above its 20-day EMA. RS rank is the percentile (0&ndash;99) of the 6-month return among all stocks scanned, 99 being the strongest.
  The 1-month chart has one bar per session (21 sessions): each bar is the return of that day&rsquo;s close vs the close one month before the last bar, green above that level and red below it.
  For information only, not investment advice.</p>
</div>

<div id="pv" class="pv" hidden></div>
<aside id="panel" class="panel" hidden role="dialog" aria-label="Stock details"></aside>
<script>
const DATA = __DATA__;
const MK = DATA.markets;
let CUR = null, ROWS = [], META = null, CFG = null, PANEL = null;
const DEF = {n: 200, adv: 10, px: 5, cap: 15, top: 20};
const PRESETS = [20, 50, 100, 150, 200, 252];
const COLS = [
  {k: "sym", t: "Symbol"}, {k: "idxs", t: "Index"}, {k: "sector", t: "Sector"},
  {k: "close", t: "Close", num: 1}, {k: "chg", t: "Day %", num: 1},
  {k: "m1", t: "1M %", num: 1, tip: "Return over the last ~21 trading sessions"},
  {k: "spark", t: "1 month", chart: 1, tip: "Bars: return vs the close one month ago, one bar per session. Green = above, red = below."},
  {k: "_sg", t: "Signals", num: 1, tip: "Rule-based checks: green dots = positive, amber = caution, red = warning. Click a row for the list. Sorting is by positives minus cautions (warnings count double)."},
  {k: "rsi", t: "RSI", num: 1, tip: "Wilder RSI(14) on daily closes"},
  {k: "ext20", t: "vs 20 EMA", num: 1, tip: "How far the close is above its 20-day EMA, in %. A rough guide to stop distance if you trail under the 20 EMA."},
  {k: "rs", t: "RS rank", num: 1, tip: "Percentile (0-99) of the 6-month return among all stocks scanned. 99 = strongest."},
  {k: "rvol", t: "Rel vol", num: 1, tip: "Today's volume vs the average of the previous 20 sessions"},
  {k: "adv", t: "Avg $ vol", num: 1, tip: "Average daily dollar volume, previous 20 sessions"},
  {k: "n1", t: "Cleared", num: 1, tip: "Number of previous sessions whose highs today's close is above (the longest lookback it would pass)"}
];
const $ = id => document.getElementById(id);
const num = id => { const s = $(id).value.trim(); if (s === "") return null; const v = parseFloat(s); return isNaN(v) ? null : v; };
const sort = {k: "chg", asc: false};

const prep = mk => { for (const code in mk) for (const r of mk[code].rows) r.idxs = r.idx.join(" "); };
prep(MK);

function setMarketDefaults() {
  $("adv").value = DEF.adv; $("px").value = DEF.px; $("cap").value = DEF.cap;
  document.querySelectorAll(".idx").forEach(e => e.checked = true);
}
function setDefaults() {
  $("n").value = DEF.n; $("top").value = DEF.top;
  setMarketDefaults();
  for (const id of ["rmin", "rmax", "ext", "rv", "rs"]) $(id).value = "";
}

function buildStatic() {
  const pre = $("presets");
  for (const n of PRESETS) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "chip"; b.textContent = n; b.dataset.n = n;
    b.addEventListener("click", () => { $("n").value = n; update(); });
    pre.appendChild(b);
  }
  const tabs = $("tabs");
  for (const code of DATA.order) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "tab"; b.setAttribute("role", "tab"); b.dataset.m = code;
    b.textContent = MK[code].meta.cfg.name;
    b.addEventListener("click", () => setMarket(code));
    tabs.appendChild(b);
  }
  tabs.hidden = DATA.order.length < 2;
  for (const id of ["n", "adv", "px", "cap", "rmin", "rmax", "ext", "rv", "rs"]) $(id).addEventListener("input", update);
  $("top").addEventListener("change", update);
  $("reset").addEventListener("click", () => { setDefaults(); update(); });
}

function setMarket(code) {
  closePanel();
  CUR = code; META = MK[code].meta; ROWS = MK[code].rows; CFG = META.cfg;
  DEF.adv = CFG.defaults.adv; DEF.px = CFG.defaults.px; DEF.cap = CFG.defaults.cap;
  document.querySelectorAll("#tabs .tab").forEach(b => b.setAttribute("aria-selected", b.dataset.m === code ? "true" : "false"));
  $("l-adv").textContent = CFG.advLabel; $("l-px").textContent = CFG.pxLabel;
  $("sub").textContent = "Session of " + META.date + " · refreshed " + META.generated;
  $("s-scanned").textContent = META.scanned.toLocaleString("en-US");
  const box = $("indices"); box.replaceChildren();
  for (const ix of META.indices) {
    const l = document.createElement("label"); l.className = "chk";
    const c = document.createElement("input"); c.type = "checkbox"; c.className = "idx"; c.value = ix.code; c.checked = true;
    c.addEventListener("change", update);
    l.appendChild(c); l.appendChild(document.createTextNode(ix.label + " (" + ix.count + ")"));
    box.appendChild(l);
  }
  const foot = $("foot"); foot.replaceChildren();
  foot.appendChild(document.createTextNode("Universe: " + META.indices.map(i => i.label).join(", ") + "."));
  const warn = txt => { const w = document.createElement("span"); w.className = "warn"; w.textContent = " " + txt; foot.appendChild(w); };
  if (META.failed.length) warn("Not loaded on this run: " + META.failed.join(", ") + ".");
  for (const n of META.notes || []) warn(n);
  if (META.stale) warn(META.stale);
  $("foot2").textContent = CFG.footNote;
  setMarketDefaults();
  try { localStorage.setItem("market", code); } catch (e) {}
  try { history.replaceState(null, "", "#" + code.toLowerCase()); } catch (e) {}
  update();
}

function matches() {
  const N = parseInt($("n").value, 10);
  if (!(N >= META.minLookback)) return null;
  const minAdv = (parseFloat($("adv").value) || 0) * CFG.advFactor;
  const minPx = parseFloat($("px").value) || 0;
  const capRaw = $("cap").value.trim();
  const cap = capRaw === "" || isNaN(parseFloat(capRaw)) ? Infinity : parseFloat(capRaw);
  const sel = new Set([...document.querySelectorAll(".idx:checked")].map(e => e.value));
  const rmin = num("rmin"), rmax = num("rmax"), ext = num("ext"), rv = num("rv"), rs = num("rs");
  return ROWS.filter(r => N > r.n2 + 1 && N <= r.n1 && r.adv >= minAdv && r.close >= minPx
                          && r.chg <= cap && r.idx.some(i => sel.has(i))
                          && (rmin === null || (r.rsi !== null && r.rsi >= rmin))
                          && (rmax === null || (r.rsi !== null && r.rsi <= rmax))
                          && (ext === null || r.ext20 <= ext)
                          && (rv === null || r.rvol >= rv)
                          && (rs === null || (r.rs !== null && r.rs >= rs)));
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
const fmt2 = x => x.toLocaleString(CFG.locale, {minimumFractionDigits: 2, maximumFractionDigits: 2});
const fmtAdv = v => CFG.currency + (v / CFG.advFactor).toLocaleString(CFG.locale, {minimumFractionDigits: 1, maximumFractionDigits: 1})
  + (CFG.advUnit === "Cr" ? " Cr" : CFG.advUnit);

function levelFor(steps, N) {
  let v = null;
  for (const st of steps) { if (st[0] <= N) v = st[1]; else break; }
  return v;
}
function svgEl(tag, attrs, parent) {
  const e = document.createElementNS(SVGNS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}
const fmtPx = v => v.toLocaleString(CFG.locale, {minimumFractionDigits: 2, maximumFractionDigits: 2});

function drawPreview(r, N) {
  const cx = r.cx, n = cx.c.length;
  const W = 400, H = 224, L = 6, R = 50, PT = 6, PH = 154, VT = 168, VH = 38;
  const pw = W - L - R, step = pw / n, bw = Math.max(1, step * 0.66);
  const lvl = levelFor(r.lv, N);
  let hi = Math.max(...cx.h), lo = Math.min(...cx.l);
  if (lvl !== null) { hi = Math.max(hi, lvl); lo = Math.min(lo, lvl); }
  const pad = (hi - lo) * 0.04 || hi * 0.02; hi += pad; lo -= pad;
  const Y = v => PT + (hi - v) / (hi - lo) * PH;
  const X = i => L + (i + 0.5) * step;
  const svg = svgEl("svg", {viewBox: "0 0 " + W + " " + H, "class": "pvs", role: "img",
    "aria-label": r.sym + " daily chart, last " + n + " sessions"});
  svgEl("rect", {"class": "band", x: L + (n - 1) * step, y: PT, width: step, height: VT + VH - PT}, svg);
  for (let g = 0; g <= 3; g++) {
    const v = lo + (hi - lo) * g / 3, y = Y(v);
    svgEl("line", {"class": "grid", x1: L, x2: L + pw, y1: y, y2: y}, svg);
    svgEl("text", {x: L + pw + 4, y: y + 3}, svg).textContent = fmtPx(v);
  }
  const mv = Math.max(...cx.v) || 1;
  for (let i = 0; i < n; i++) {
    const h = Math.max(cx.v[i] / mv * VH, 0.5);
    svgEl("rect", {"class": "vol " + (cx.c[i] >= cx.o[i] ? "up" : "dn"), x: X(i) - bw / 2, y: VT + VH - h, width: bw, height: h}, svg);
  }
  for (let i = 0; i < n; i++) {
    const cls = cx.c[i] >= cx.o[i] ? "up" : "dn", yo = Y(cx.o[i]), yc = Y(cx.c[i]);
    svgEl("line", {"class": "wick " + cls, x1: X(i), x2: X(i), y1: Y(cx.h[i]), y2: Y(cx.l[i])}, svg);
    svgEl("rect", {"class": "body " + cls, x: X(i) - bw / 2, y: Math.min(yo, yc), width: bw, height: Math.max(Math.abs(yo - yc), 1)}, svg);
  }
  const line = (arr, cls) => svgEl("polyline", {"class": "ema " + cls,
    points: arr.map((v, i) => X(i).toFixed(1) + "," + Y(v).toFixed(1)).join(" ")}, svg);
  line(cx.e2, "e2"); line(cx.e1, "e1");
  if (lvl !== null) {
    svgEl("line", {"class": "lvl", x1: L, x2: L + pw, y1: Y(lvl), y2: Y(lvl)}, svg);
    svgEl("text", {"class": "lvt", x: L + 4, y: Y(lvl) - 4}, svg).textContent = N + "-session high " + fmtPx(lvl);
  }
  svgEl("text", {x: L, y: H - 3}, svg).textContent = cx.d0;
  svgEl("text", {x: L + pw, y: H - 3, "text-anchor": "end"}, svg).textContent = cx.d1;
  return svg;
}

const pvBox = $("pv");

// ---- insights: plain-language checks worked out from the numbers in each row (observations, not advice) ----
const SEV = {bad: 0, warn: 1, good: 2, info: 3};
const todayStr = () => new Date().toISOString().slice(0, 10);
function daysUntil(iso) { return Math.round((Date.parse(iso + "T00:00:00Z") - Date.parse(todayStr() + "T00:00:00Z")) / 864e5); }
function insights(r, N) {
  const out = {items: [], stop: null, good: 0, warn: 0, bad: 0};
  const x = r.x; if (!x) return out;
  const cur = CFG.currency, cx = r.cx, last = cx.c.length - 1;
  const add = (g, l, t) => { out.items.push({g, l, t}); if (l !== "info") out[l]++; };
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
    out.stop = {px: stop, risk, atrMult: am};
    if (am !== null && am > 3) add("Risk", "warn", "Reference stop is " + am.toFixed(1) + "× the normal daily range away (" + risk.toFixed(1) + "%): wide.");
    else add("Risk", "info", "Reference stop is " + risk.toFixed(1) + "% below the close" + (am !== null ? " (" + am.toFixed(1) + "× the normal daily range)." : "."));
  }
  if (r.earn) {
    const d = daysUntil(r.earn), when = d < 0 ? "just reported" : d === 0 ? "today" : d === 1 ? "tomorrow" : "in " + d + " days";
    if (d >= 0 && d <= 2) add("Risk", "bad", "Earnings " + when + " (" + r.earn + "): a gap on results can jump straight past any stop.");
    else if (d >= 3 && d <= 10) add("Risk", "warn", "Earnings " + when + " (" + r.earn + ").");
    else add("Risk", "info", "Next earnings: " + r.earn + " (" + when + ").");
  } else add("Risk", "info", "No earnings date available: check before entering.");

  if (r.chg >= 40) add("Data check", "bad", "Up " + r.chg.toFixed(0) + "% in one day: check for a split, bonus issue or data error before trusting this.");
  if (CFG.bands && x.cp !== null && x.cp >= 99) {
    for (const bnd of CFG.bands) if (r.chg >= bnd - 0.6 && r.chg <= bnd + 0.1)
      add("Data check", "warn", "Closed at the day’s high, up " + r.chg.toFixed(1) + "%, right at the " + bnd + "% price band: it may have hit upper circuit, so buying may not have been possible.");
  }
  out.items.sort((a, b) => SEV[a.l] - SEV[b.l]);
  return out;
}
function insList(items, limit) {
  const ul = document.createElement("ul"); ul.className = "ins";
  for (const it of items.slice(0, limit || items.length)) {
    const li = document.createElement("li"); li.className = it.l; li.textContent = it.t; ul.appendChild(li);
  }
  return ul;
}
function sigCell(ins) {
  const td = document.createElement("td"); td.className = "sgs";
  const bits = [["g", ins.good, "positive"], ["w", ins.warn, "caution"], ["b", ins.bad, "warning"]].filter(b => b[1] > 0);
  if (!bits.length) { td.textContent = "—"; return td; }
  for (const [cls, n, word] of bits) {
    const s = document.createElement("span"); s.className = cls; s.textContent = "● " + n; s.title = n + " " + word + (n > 1 ? "s" : "") ; td.appendChild(s);
  }
  td.title = ins.good + " positive · " + ins.warn + " caution · " + ins.bad + " warning. Click the row for details.";
  return td;
}
function legendEl() {
  const lg = document.createElement("div"); lg.className = "lg";
  for (const [txt, css] of [["20 EMA", "border-color:var(--e20)"], ["50 EMA", "border-color:var(--e50)"],
                            ["breakout level", "border-top-style:dashed;border-color:var(--fg)"]]) {
    const s = document.createElement("span"), sw = document.createElement("i");
    sw.className = "sw"; sw.style.cssText = css; s.appendChild(sw); s.appendChild(document.createTextNode(txt)); lg.appendChild(s);
  }
  return lg;
}
const yahooUrl = r => "https://finance.yahoo.com/quote/" + encodeURIComponent(CFG.bands ? r.sym + ".NS" : r.sym.replace(".", "-"));
const tvUrl = r => "https://www.tradingview.com/chart/?symbol=" +
  encodeURIComponent(CFG.tvPrefix ? CFG.tvPrefix + r.sym.replace(/[&-]/g, "_") : r.sym).replace("%3A", ":");   // TradingView writes M&M as NSE:M_M

function renderPanel() {
  const box = $("panel"), r = PANEL.r, N = parseInt($("n").value, 10);
  box.replaceChildren();
  const top = document.createElement("div"); top.className = "top";
  const l = document.createElement("div");
  const b = document.createElement("b"); b.textContent = r.sym; l.appendChild(b);
  const nm = document.createElement("div"); nm.className = "nm2"; nm.textContent = r.name + (r.sector ? " · " + r.sector : ""); l.appendChild(nm);
  const px = document.createElement("div"); px.textContent = CFG.currency + fmtPx(r.close) + "  (+" + r.chg.toFixed(2) + "% today)"; l.appendChild(px);
  const x = document.createElement("button"); x.type = "button"; x.className = "x"; x.textContent = "×"; x.setAttribute("aria-label", "Close details"); x.id = "panel-x";
  x.addEventListener("click", closePanel);
  top.appendChild(l); top.appendChild(x); box.appendChild(top);
  box.appendChild(legendEl()); box.appendChild(drawPreview(r, N));
  if (N < META.minLookback || isNaN(N)) return;
  const ins = insights(r, N);
  const ty = document.createElement("div"); ty.className = "tally";
  for (const [cls, n, w] of [["g", ins.good, "positive"], ["w", ins.warn, "caution"], ["b", ins.bad, "warning"]]) {
    const s = document.createElement("span"); s.className = "sgs"; const i = document.createElement("span"); i.className = cls; i.textContent = "● " + n; s.appendChild(i);
    s.appendChild(document.createTextNode(" " + w + (n === 1 ? "" : "s"))); ty.appendChild(s);
  }
  box.appendChild(ty);
  if (ins.stop) {
    const sb = document.createElement("div"); sb.className = "stop";
    const k = document.createElement("div"); k.textContent = "Reference stop (the higher of the breakout level and the day’s low)"; sb.appendChild(k);
    const v = document.createElement("b"); v.textContent = CFG.currency + fmtPx(ins.stop.px); sb.appendChild(v);
    sb.appendChild(document.createTextNode("   " + ins.stop.risk.toFixed(1) + "% below the close" + (ins.stop.atrMult !== null ? " · " + ins.stop.atrMult.toFixed(1) + "× normal daily range" : "")));
    box.appendChild(sb);
  }
  for (const g of ["Breakout", "Trend", "Risk", "Data check"]) {
    const items = ins.items.filter(i => i.g === g); if (!items.length) continue;
    const h = document.createElement("h3"); h.textContent = g === "Risk" ? "Risk & timing" : g; box.appendChild(h);
    box.appendChild(insList(items));
  }
  const lk = document.createElement("div"); lk.className = "links"; lk.style.marginTop = "14px";
  for (const [txt, url] of [["TradingView", tvUrl(r)], ["Yahoo Finance", yahooUrl(r)]]) {
    const a = document.createElement("a"); a.href = url; a.target = "_blank"; a.rel = "noopener"; a.textContent = txt + " ↗"; lk.appendChild(a);
  }
  { // hand the stock (and the reference stop) to the paper-trading page
    const pt = document.createElement("a");
    pt.href = "paper.html?m=" + (CFG.bands ? "IN" : "US") + "&sym=" + encodeURIComponent(r.sym) + "&px=" + r.close + (ins.stop ? "&stop=" + ins.stop.px : "");
    pt.textContent = "Paper trade this \u2192"; pt.style.fontWeight = "600"; lk.appendChild(pt);
  }
  box.appendChild(lk);
  const dc = document.createElement("div"); dc.className = "disc";
  dc.textContent = "Rule-based observations worked out from daily price data, for your own research. Not advice, and not a prediction. The reference stop is a chart level, not a recommendation.";
  box.appendChild(dc);
}
function openPanel(r, tr) {
  hidePv();
  PANEL = {r, tr};
  document.querySelectorAll("#tb tr.sel").forEach(e => e.classList.remove("sel"));
  if (tr) tr.classList.add("sel");
  renderPanel(); $("panel").hidden = false; $("panel").scrollTop = 0;
}
function closePanel() {
  if (!PANEL) return;
  PANEL = null; $("panel").hidden = true;
  document.querySelectorAll("#tb tr.sel").forEach(e => e.classList.remove("sel"));
}
document.addEventListener("keydown", e => { if (e.key === "Escape") closePanel(); });

function placePv(x, y) {
  const pad = 16, w = pvBox.offsetWidth, h = pvBox.offsetHeight;
  let left = x + pad;
  if (left + w > window.innerWidth - 8) left = x - pad - w;
  left = Math.max(8, left);
  const top = Math.max(8, Math.min(window.innerHeight - h - 8, y - h / 2));
  pvBox.style.left = left + "px"; pvBox.style.top = top + "px";
}
function showPv(r, x, y) {
  if (PANEL) return;                                   // while a stock is pinned the floating preview stays out of the way
  const N = parseInt($("n").value, 10);
  pvBox.replaceChildren();
  const hd = document.createElement("div"); hd.className = "hd";
  const b = document.createElement("b"); b.textContent = r.sym; hd.appendChild(b);
  hd.appendChild(document.createTextNode("  " + r.name + "  ·  " + CFG.currency + fmtPx(r.close) + "  (+" + r.chg.toFixed(2) + "%)"));
  const lg = legendEl();
  pvBox.appendChild(hd); pvBox.appendChild(lg); pvBox.appendChild(drawPreview(r, N));
  if (N >= META.minLookback) {
    const ins = insights(r, N);
    if (ins.items.length) {
      const sig = ins.items.filter(i => i.l !== "info");
      pvBox.appendChild(insList(sig.length ? sig : ins.items, 5));
      const mr = document.createElement("div"); mr.className = "more";
      mr.textContent = "Click the row for the full checklist and a reference stop."; pvBox.appendChild(mr);
    }
  }
  pvBox.hidden = false;
  placePv(x, y);
}
function hidePv() { pvBox.hidden = true; }
function attachPv(tr, r) {
  tr.tabIndex = 0;
  tr.addEventListener("mouseenter", e => showPv(r, e.clientX, e.clientY));
  tr.addEventListener("mousemove", e => placePv(e.clientX, e.clientY));
  tr.addEventListener("mouseleave", hidePv);
  tr.addEventListener("focus", () => { const b = tr.getBoundingClientRect(); showPv(r, b.left + b.width / 2, b.top + b.height / 2); });
  tr.addEventListener("blur", hidePv);
  tr.addEventListener("click", e => { if (!e.target.closest("a")) openPanel(r, tr); });
  tr.addEventListener("keydown", e => { if (e.key === "Enter" && e.target === tr) { e.preventDefault(); openPanel(r, tr); } });
}
window.addEventListener("scroll", hidePv, true);

function update() {
  hidePv();
  const ac = COLS.find(c => c.k === "adv"); ac.t = CFG.advHeader; ac.tip = CFG.advTip;
  const N = parseInt($("n").value, 10);
  document.querySelectorAll("#presets .chip").forEach(b => b.classList.toggle("on", +b.dataset.n === N));
  $("rule").textContent = N >= META.minLookback
    ? "Close is above the highest high of the previous " + N + " sessions, and yesterday’s close was not itself the highest close of its " + N + " sessions."
    : "Enter a lookback of at least " + META.minLookback + " sessions.";

  let list = matches();
  const matched = list ? list.length : 0;
  list = list ? list.slice() : [];
  for (const r of list) { const i = insights(r, N); r._sg = i.good - i.warn - 2 * i.bad; r._ins = i; }
  const c = COLS.find(x => x.k === sort.k);
  list.sort((a, b) => {
    let x = a[sort.k], y = b[sort.k], r;
    if (c.num) { x = x ?? -Infinity; y = y ?? -Infinity; r = x === y ? 0 : (x < y ? -1 : 1); }
    else r = String(x).localeCompare(String(y));
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
    td.colSpan = COLS.length + 1; tr.appendChild(td); tb.appendChild(tr);
    if (PANEL) renderPanel();
    return;
  }
  list.forEach((r, i) => {
    const tr = document.createElement("tr");
    attachPv(tr, r);
    tr.appendChild(cell(i + 1));
    const s = document.createElement("td");
    const a = document.createElement("a");
    const tv = CFG.tvPrefix ? CFG.tvPrefix + r.sym.replace(/[&-]/g, "_") : r.sym;   // TradingView writes M&M as NSE:M_M
    a.href = "https://www.tradingview.com/chart/?symbol=" + encodeURIComponent(tv).replace("%3A", ":");
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
    tr.appendChild(sigCell(r._ins));
    tr.appendChild(cell(r.rsi === null ? "—" : r.rsi.toFixed(1)));
    tr.appendChild(cell((r.ext20 >= 0 ? "+" : "") + r.ext20.toFixed(1) + "%"));
    tr.appendChild(cell(r.rs === null ? "—" : String(r.rs)));
    tr.appendChild(cell(r.rvol.toFixed(1) + "×"));
    tr.appendChild(cell(fmtAdv(r.adv)));
    tr.appendChild(cell((r.n1 >= r.bars ? "≥ " : "") + r.n1));
    if (PANEL && PANEL.r === r) { tr.classList.add("sel"); PANEL.tr = tr; }
    tb.appendChild(tr);
  });
  if (PANEL) renderPanel();                                 // keep an open panel in step with the lookback
}

buildStatic(); setDefaults();
(function () {
  let start = location.hash.replace("#", "").toUpperCase();
  if (!MK[start]) {
    start = null;
    try { const saved = localStorage.getItem("market"); if (saved && MK[saved]) start = saved; } catch (e) {}
  }
  setMarket(start || DATA.order[0]);
})();

// ---- new-data check: compares this page's build time with version.json on the server ----
let NEWER = null;
function showNew(on) { $("newdata").hidden = !on; }
async function checkNew(manual) {
  const msg = $("chk-msg");
  if (location.protocol === "file:") { if (manual) msg.textContent = "Only works on the published page."; return; }
  if (manual) msg.textContent = "Checking…";
  try {
    const r = await fetch("version.json?t=" + Date.now(), {cache: "no-store"});
    if (!r.ok) throw new Error(r.status);
    const v = await r.json();
    if (v.built && v.built > DATA.built) {
      NEWER = v.built; showNew(true); msg.textContent = manual ? "New data is available." : "";
    } else if (manual) {
      msg.textContent = "You have the latest data (checked " + new Date().toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"}) + ").";
    }
  } catch (e) {
    if (manual) msg.textContent = "Couldn’t check right now.";
  }
}
async function loadNew() {
  const msg = $("chk-msg");
  try {
    const r = await fetch("index.html?t=" + Date.now(), {cache: "no-store"});
    if (!r.ok) throw new Error(r.status);
    const html = await r.text();
    const nd = JSON.parse(html.split("const DATA = ", 2)[1].split(";\nconst MK", 1)[0]);
    if (nd.order.join() !== DATA.order.join()) { location.reload(); return; }
    const keep = {};
    for (const id of ["n", "adv", "px", "cap", "top", "rmin", "rmax", "ext", "rv", "rs"]) keep[id] = $(id).value;
    const off = [...document.querySelectorAll(".idx:not(:checked)")].map(e => e.value);
    prep(nd.markets);
    for (const code of nd.order) MK[code] = nd.markets[code];
    DATA.built = nd.built; NEWER = null;
    setMarket(CUR);                                        // rebinds rows/meta; then put the user's settings back
    for (const id in keep) $(id).value = keep[id];
    document.querySelectorAll(".idx").forEach(e => { e.checked = !off.includes(e.value); });
    update(); showNew(false); msg.textContent = "Updated.";
  } catch (e) {
    msg.textContent = "Couldn’t load the new data; try reloading the page.";
  }
}
$("chk").addEventListener("click", () => checkNew(true));
$("loadnew").addEventListener("click", loadNew);
document.addEventListener("visibilitychange", () => { if (!document.hidden) checkNew(false); });
setInterval(() => { if (!document.hidden) checkNew(false); }, 15 * 60 * 1000);
checkNew(false);
</script>
</body>
</html>
"""


BUILT = ""   # set by main(): UTC timestamp identifying this build


def render(markets: dict[str, dict]) -> str:
    order = [c for c in MARKETS if c in markets]
    payload = json.dumps({"markets": markets, "order": order, "built": BUILT}, separators=(",", ":")).replace("<", "\\u003c")
    return TEMPLATE.replace("__DATA__", payload)


# ---------------------------------------------------------------- markets ---
def page_cfg(code: str) -> dict:
    return {k: v for k, v in MARKETS[code].items() if k not in ("tz", "close", "min_tickers")}


def load_universe(code: str):
    return load_constituents() if code == "US" else load_india_constituents()


def expected_sources(code: str, loaded: dict) -> list[tuple[str, str]]:
    if code == "US":
        return [(c, label) for c, label, _, _ in SOURCES]
    if NSE_ALL[0] in loaded:                       # the combined list covered whatever was missing
        return []
    return [(c, label) for c, label, _, _ in NSE_LISTS]


def process_market(code: str, cons: pd.DataFrame, prices: dict, loaded: dict) -> dict:
    """Screen one market's stocks. Session date and RS ranks are computed within the market."""
    cfg = MARKETS[code]
    meta_by_yf = cons.set_index("yf")
    rows: list[dict] = []
    dates: list[str] = []
    ret6: dict[str, tuple[str, float]] = {}
    scanned = 0
    for yf_sym, df in prices.items():
        if yf_sym not in meta_by_yf.index:
            continue
        df = drop_incomplete_today(df, cfg["tz"], cfg["close"])
        if len(df) < MIN_BARS:
            continue
        scanned += 1
        last = df.index[-1].strftime("%Y-%m-%d")
        dates.append(last)
        r6 = six_month_return(df)
        if r6 is not None:
            ret6[yf_sym] = (last, r6)
        st = breakout_stats(df)
        if st:
            m = meta_by_yf.loc[yf_sym]
            st.update(yf=yf_sym, sym=m["symbol"], name=m["name"], sector=m["sector"], idx=list(m["idx"]))
            rows.append(st)

    if scanned < cfg["min_tickers"]:
        raise RuntimeError(f"only {scanned} tickers returned data (need {cfg['min_tickers']})")

    data_date = pd.Series(dates).mode().iloc[0]        # ignore stragglers with stale last bars
    print(f"  last-bar dates ({code}): " + ", ".join(f"{d} x{n}" for d, n in pd.Series(dates).value_counts().head(4).items()) + f"; using {data_date}")
    rows = [r for r in rows if r.pop("date") == data_date]
    ranks = rs_ranks({k: v for k, (d, v) in ret6.items() if d == data_date})
    pairs = []
    for r in rows:
        yf_sym = r.pop("yf")
        r["rs"] = ranks.get(yf_sym)
        pairs.append((r, yf_sym))
    try:
        attach_earnings(pairs)
    except Exception as e:                     # a nice-to-have must never break the run
        print(f"WARNING: earnings step skipped: {e}", file=sys.stderr)

    meta = {
        "date": data_date,
        "generated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "scanned": scanned,
        "minLookback": MIN_LOOKBACK,
        "indices": [{"code": c, "label": v["label"], "count": v["count"]} for c, v in loaded.items()],
        "failed": [label for c, label in expected_sources(code, loaded) if c not in loaded],
        "notes": [v["note"] for v in loaded.values() if v.get("note")],
        "cfg": page_cfg(code),
    }
    return {"rows": rows, "meta": meta}


# --------------------------------------------------------------- earnings --
EARNINGS_ENABLED = True
EARN_BUDGET_SEC = 240        # never spend longer than this asking Yahoo for earnings dates
EARN_WORKERS = 6


def _next_earnings(sym: str, today: dt.date) -> str:
    """Next earnings date (YYYY-MM-DD) from Yahoo, or '' if none is listed. Raises on a failed request."""
    import yfinance as yf

    cal = yf.Ticker(sym).calendar
    dates = cal.get("Earnings Date") if isinstance(cal, dict) else None
    out = []
    for d in dates or []:
        d = d.date() if isinstance(d, dt.datetime) else d
        if isinstance(d, dt.date) and d >= today - dt.timedelta(days=1):
            out.append(d)
    return min(out).isoformat() if out else ""


def fetch_earnings(syms: list[str]) -> dict[str, str]:
    """Best effort: {ticker: 'YYYY-MM-DD' or ''}. Tickers whose request failed are left out. Time-boxed."""
    from concurrent.futures import ThreadPoolExecutor

    today = dt.datetime.now(dt.timezone.utc).date()
    deadline = time.monotonic() + EARN_BUDGET_SEC
    out: dict[str, str] = {}

    def one(sym):
        if time.monotonic() > deadline:
            return
        try:
            out[sym] = _next_earnings(sym, today)
        except Exception:
            pass

    with ThreadPoolExecutor(max_workers=EARN_WORKERS) as pool:
        list(pool.map(one, syms))
    return out


def attach_earnings(pairs: list[tuple[dict, str]]) -> None:
    """Add r['earn'] (next earnings date) to each row that has one, using a small cache so most runs
    ask Yahoo for only a handful of tickers. Failures are silent: the page just omits the flag."""
    if not EARNINGS_ENABLED or not pairs:
        return
    today = dt.datetime.now(dt.timezone.utc).date()
    path = OUT_PATH.parent / "earnings_cache.json"
    try:
        cache = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(cache, dict):
            cache = {}
    except Exception:
        cache = {}
    orig = dict(cache)

    def fresh(e):
        try:
            age = (today - dt.date.fromisoformat(e["f"])).days
            return age <= 6 and e["d"] >= today.isoformat() if e["d"] else age <= 2
        except Exception:
            return False

    need = [yf for _, yf in pairs if not fresh(cache.get(yf, {}))]
    if need:
        try:
            got = fetch_earnings(need)
        except Exception as e:
            print(f"WARNING: earnings dates unavailable: {e}", file=sys.stderr)
            got = {}
        for yf, d in got.items():
            cache[yf] = {"d": d, "f": today.isoformat()}
        print(f"Earnings dates: asked for {len(need)}, received {len(got)}")
        keep = {k: v for k, v in cache.items() if isinstance(v, dict) and v.get("f", "") >= (today - dt.timedelta(days=30)).isoformat()}
        if keep != orig:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(keep, separators=(",", ":"), sort_keys=True), encoding="utf-8")
        cache = keep
    for r, yf in pairs:
        e = cache.get(yf)
        if e and e.get("d"):
            r["earn"] = e["d"]


def cache_path(code: str) -> Path:
    return OUT_PATH.parent / f"market_{code.lower()}.json"


def payload_sig(payload: dict) -> str:
    """Fingerprint of a market's results, ignoring the refresh time, so a re-run with nothing new changes nothing."""
    import hashlib
    body = {"rows": payload["rows"], "meta": {k: v for k, v in payload["meta"].items() if k != "generated"}}
    return hashlib.sha1(json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def save_cache(code: str, payload: dict) -> None:
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    old = load_cache(code)
    if old and payload_sig(old) == payload_sig(payload):
        return                                         # nothing new: keep the file as is (no pointless commit)
    cache_path(code).write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")


def load_cache(code: str) -> dict | None:
    try:
        data = json.loads(cache_path(code).read_text(encoding="utf-8"))
        if isinstance(data, dict) and "rows" in data and "meta" in data:
            return data
    except Exception:
        pass
    return None


# ------------------------------------------------------------------- main ---
def main() -> int:
    payloads: dict[str, dict] = {}
    refreshed = 0
    for code, cfg in MARKETS.items():
        try:
            cons, loaded = load_universe(code)
            prices = download_prices(cons["yf"].tolist())
            payloads[code] = process_market(code, cons, prices, loaded)
            save_cache(code, payloads[code])           # last good result, reused if a later refresh fails
            refreshed += 1
            m = payloads[code]["meta"]
            print(f"{cfg['name']}: scanned {m['scanned']}; {len(payloads[code]['rows'])} stocks are breakouts "
                  f"for at least one lookback; session {m['date']}")
        except Exception as e:
            print(f"WARNING: {cfg['name']} could not be refreshed: {e}", file=sys.stderr)
            cached = load_cache(code)
            if cached:
                cached["meta"]["stale"] = (f"{cfg['name']} could not be refreshed on this run, so this is the "
                                           f"session of {cached['meta']['date']}.")
                payloads[code] = cached

    if not refreshed:
        print("No market could be refreshed; leaving the page unchanged.", file=sys.stderr)
        return 1
    import hashlib                                  # the page design is part of the fingerprint, so a new version of this script always republishes
    sig = hashlib.sha1(TEMPLATE.encode()).hexdigest()[:12] + "|" + "|".join(f"{c}:{payload_sig(p)}" for c, p in payloads.items())
    vpath = OUT_PATH.parent / "version.json"
    try:
        if OUT_PATH.exists() and json.loads(vpath.read_text(encoding="utf-8")).get("sig") == sig:
            print("Nothing new since the last run; page left unchanged.")
            return 0
    except Exception:
        pass
    global BUILT
    BUILT = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(render(payloads), encoding="utf-8")
    (OUT_PATH.parent / "version.json").write_text(            # tiny file the page polls to learn about new data
        json.dumps({"built": BUILT, "sig": sig, "sessions": {c: p["meta"]["date"] for c, p in payloads.items()}}), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
