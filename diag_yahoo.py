import datetime as dt, time, requests, pandas as pd, yfinance as yf
import screener
print("now UTC", dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), "yfinance", yf.__version__)
cons, _ = screener.load_universe("IN")
tk = cons["yf"].tolist()
fr = screener.download_prices(tk)
last = {t: str(df.index[-1].date()) for t, df in fr.items()}
stale = [t for t, d in last.items() if d == "2026-11-03"]
print("India:", len(fr), "tickers;", len(stale), "end on 2026-11-03;", "sample:", stale[:10])
S = stale[:6]
def lastd(df): return [str(i.date()) for i in df.index][-2:] if len(df) else []
print("\n-- 1) yf.Ticker.history(period=5d)")
for t in S: print(t, lastd(yf.Ticker(t).history(period="5d", auto_adjust=False)))
print("\n-- 2) yf.download single ticker period=5d")
for t in S: print(t, lastd(yf.download(t, period="5d", interval="1d", auto_adjust=False, progress=False)))
print("\n-- 3) yf.download list(6) period=1mo")
d = yf.download(S, period="1mo", interval="1d", auto_adjust=False, group_by="ticker", progress=False)
for t in S: print(t, lastd(d[t].dropna(subset=["Close"])))
print("\n-- 4) raw chart API range=5d")
for t in S:
    j = requests.get(f"https://query1.finance.yahoo.com/v8/finance/chart/{t}?interval=1d&range=5d", headers={"User-Agent": "Mozilla/5.0"}, timeout=20).json()["chart"]["result"][0]
    print(t, [dt.datetime.fromtimestamp(x, dt.timezone.utc).strftime("%m-%d %H:%M") for x in j["timestamp"][-2:]], "regMktTime", dt.datetime.fromtimestamp(j["meta"]["regularMarketTime"], dt.timezone.utc).strftime("%m-%d %H:%M"))
print("\n-- 5) raw API with a cache-busting parameter, 3y range")
for t in S[:3]:
    j = requests.get(f"https://query1.finance.yahoo.com/v8/finance/chart/{t}?interval=1d&range=3y&_={int(time.time())}", headers={"User-Agent": "Mozilla/5.0"}, timeout=20).json()["chart"]["result"][0]
    print(t, [dt.datetime.fromtimestamp(x, dt.timezone.utc).strftime("%m-%d %H:%M") for x in j["timestamp"][-2:]])
print("\n-- 6) how stale tickers behave in a fresh 3y re-download of only the stale ones")
again = screener._download(stale[:50]); print(pd.Series([str(df.index[-1].date()) for df in again.values()]).value_counts().to_dict())
