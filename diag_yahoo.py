import traceback, datetime as dt, pandas as pd, yfinance as yf
import screener
print("now UTC", dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), "yfinance", yf.__version__)
cons, _ = screener.load_universe("IN")
tk = cons["yf"].tolist()[:200]
fr = screener.download_prices(tk)
stale = [t for t, df in fr.items() if str(df.index[-1].date()) == "2026-11-03"]
print(len(fr), "tickers,", len(stale), "stale; sample", stale[:5])
for t in stale[:4]:
    print("\n==", t, "old last:", fr[t].index[-1], "index dtype:", fr[t].index.dtype)
    try:
        r = screener.fetch_recent_one(t); print("fetch_recent_one ->", len(r), "rows; last:", [str(i) for i in r.index[-2:]], "cols", list(r.columns))
        extra = r[r.index > fr[t].index[-1]]; print("extra rows:", len(extra))
    except Exception:
        traceback.print_exc()
    try:
        raw = yf.Ticker(t).history(period="5d", interval="1d", auto_adjust=False); print("raw history:", [str(i) for i in raw.index[-2:]])
    except Exception:
        traceback.print_exc()
