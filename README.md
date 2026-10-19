# 📈 Breakout Screener — US + India, refreshed daily, free forever

**Find stocks breaking out to fresh highs, and see at a glance whether each one is a clean breakout or a trap.**
One web page. No server, no subscription, no app to install. It updates itself after each market closes.

> **The scan** — the one you'd build on Chartink:
> `Close > highest High of the last N sessions` **and** `yesterday's Close was not already the highest Close of its last N sessions`.
> So you only see **fresh** breakouts, not stocks that have been sitting at highs for days. **N is yours to change** (default 200).

---

## ✨ What you get

### Two markets, two tabs
| | 🇺🇸 US | 🇮🇳 India (NSE) |
|---|---|---|
| Universe | S&P 500, S&P 400, S&P 600, Nasdaq-100 | Nifty 50, Next 50, Midcap 150, Smallcap 250 |
| Liquidity default | $10M average daily volume, min price $5 | ₹10 crore average daily turnover, min price ₹50 |
| Max one-day move | 15% (filters out data glitches) | 15% |
| Refreshes | after the US close | after the NSE close |

Every filter is editable on the page, and **Reset** puts the defaults back.

### A table you can actually think with
- **Adjustable lookback** (20 / 50 / 100 / 150 / 200 / 252 chips, or type any number from 5 up).
- **1-month bar chart** in every row: green bars above where the stock was a month ago, red below.
- **Entry-quality columns** with optional filters: RSI(14), % above the 20 EMA, relative volume, and a 0–99 **RS rank** (6-month strength versus every stock scanned in that market).
- **Sort** by any column. **Index chips** to include or exclude Nifty 50, S&P 500 and so on.

### 🧠 Insights on every stock (new)
Each stock gets a handful of plain-language checks worked out from its price data:

| Group | Examples |
|---|---|
| **Breakout** | how far above the old high it closed, where the candle closed in its day's range, gap-and-fade, volume vs normal, a quiet base before the move |
| **Trend** | price above 20 EMA above 50 EMA, 50 EMA vs the 200-day average, new 52-week high or still far below it, RS rank |
| **Risk & timing** | RSI stretched, extended from the 20 EMA, a **reference stop** (the higher of the breakout level and the day's low) with its distance in % and in "normal daily ranges", **earnings coming up** |
| **Data checks** | a 40%+ one-day move that is probably a split or bonus, India: a close at the high right at a 5/10/20% price band (possible upper circuit, so you may not have been able to buy) |

You see them three ways:
1. **Signals column** — green / amber / red dots with counts. Click the header to sort.
2. **Hover a row** — a 6-month candle chart (20 EMA red, 50 EMA blue, volume, the breakout level for *your* lookback) plus the 5 most important checks.
3. **Click a row** — pins a side panel (a bottom sheet on phones) with the full checklist, the reference stop, and links to TradingView and Yahoo Finance. `Esc` or × closes it. It follows the lookback box if you change it.

> These are **observations, not signals to buy or sell.** They summarise a chart. They don't predict anything.

### 🔄 Stays fresh on its own
- **Runs automatically** after each close (see *Schedule* below), with backup runs in case GitHub is late.
- **"Check for new data" button** on the page, plus a **"New data is available — Load it"** banner when a newer run is published. Loading it keeps your filters.
- **Safe failures:** if one market can't be fetched, its last good result stays on the page with a clear notice. The other market still updates.
- **Quiet when nothing changed:** a run with no new data makes no commit and shows no banner.

---

## 🚀 Setup (about 10 minutes, no coding, all in the browser)

1. **Create a GitHub account** at github.com and a **new public repository**, for example `breakout-screener`.
2. **Upload the files.** In the repo click **Add file → Upload files** and drag in:
   - `screener.py`
   - `requirements.txt`
   - `README.md`
   - the folder `.github/workflows/` containing `daily.yml`
     *(If the web uploader won't take the folder, use **Add file → Create new file**, type `.github/workflows/daily.yml` as the name, and paste the contents.)*
3. **Allow the bot to save results:** **Settings → Actions → General → Workflow permissions → Read and write permissions → Save.**
4. **Run it once:** **Actions** tab → **Daily breakout screen (US + India)** → **Run workflow**. It takes about 5–8 minutes. A green tick means it worked, and it creates the `docs/` folder with your page.
5. **Switch on the website:** **Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: `main`, folder `/docs` → Save.**
6. After a minute your page is live at `https://<your-username>.github.io/<repo-name>/`. Bookmark it, and add it to your phone's home screen if you like.

**From now on you do nothing.** It updates itself.

### Updating to a new version of the script
Open `screener.py` in your repo → pencil icon → select all, paste the new contents → **Commit changes**. Do the same for `daily.yml` if it changed. Then **Actions → Run workflow** to publish right away. A new version always republishes, even if the market data hasn't changed.

---

## 🕒 Schedule

Mon–Fri, in UTC (GitHub's clock). Each run refreshes both markets and only publishes what is final.

| Market | Closes | Runs |
|---|---|---|
| India | 15:30 IST (10:00 UTC) | 16:00, 17:00, 18:00 IST |
| US | 16:00 New York (20:00 UTC in summer, 21:00 UTC in winter) | 20:35, 21:35, 22:35, 23:35 UTC |

- A day's candle is trusted only **15 minutes after the close**, worked out from real closing times, so daylight saving is handled automatically.
- GitHub treats scheduled runs as "best effort" and can start them late or skip one. That is why there are several triggers. If you're ever in a hurry: **Actions → Run workflow**, then press **Check for new data** on the page.

---

## 🧾 Paper trading

A practice account that lives beside the screener: add (pretend) funds, place orders, edit fills, and watch a dashboard of how the strategy is doing. Open it from the **Paper trading →** link at the top of the screener, or press **Paper trade this →** in any stock's panel (it arrives with the symbol and the reference stop filled in).

- **India** (rupees) and **US** (dollars) are separate portfolios. Equities only, end-of-day fills, no margin, no shorting.
- **Orders:** market, limit, stop, and brackets (stop-loss + target that cancel each other). A stop that gaps is filled at the open, not at your stop price. If a stop and a target could both trigger in one session, the stop is assumed first (changeable).
- **Funds:** US top-ups are entered in rupees and show the exchange rate, GST, pay-in charge and the dollars credited (the layout of Dhan's own top-up screen). Every rate and charge can be overridden, and the page tracks the ₹10 lakh yearly TCS threshold.
- **Charges** follow Dhan's published pricing (India delivery: zero brokerage + statutory charges + DP fee; US: 0.25% per trade, minimum $0.01). All rates are editable in **Settings**.
- **Blocked funds:** like a broker, a pending buy sets money aside (quantity × price + estimated charges). The page shows cash, blocked and available, refuses a buy larger than the available funds, and releases the money when the order fills, is cancelled or expires.
- **Editing:** any executed order can be corrected; positions, P&L and the dashboard recalculate from the records.
- **Dashboard:** equity curve against your deposits, deposit-adjusted return vs Nifty 50 / S&P 500, win rate, profit factor, expectancy, R-multiples, holding times, drawdown, results by tag, and plain-language observations.

### One-time setup (about 10 minutes)

1. **Supabase** (free): create a project, then **SQL Editor → New query**, paste all of `paper/schema.sql` and press **Run**.
2. **Connect the page:** put the Project URL and the *publishable* (anon) key in `docs/paper-config.js`. These are meant to be public; your data is protected by your login and row-level security. Never put the `service_role` key in the repo.
3. **Let the daily job fill orders:** in GitHub go to **Settings → Secrets and variables → Actions → New repository secret** and add `SUPABASE_URL` (the same URL) and `SUPABASE_SERVICE_KEY` (the `service_role` / secret key from Supabase → Project Settings → API). Without these the page still works, but orders are never filled.
4. Open `paper.html`, press **Create account**, and sign in. In Supabase → Authentication → URL Configuration, set **Site URL** to your page's address (the one ending in `/paper.html`'s folder, e.g. `https://YOURNAME.github.io/sp500-screener/`) and add the same address under **Redirect URLs**; otherwise confirmation emails link to `localhost:3000`, which does not exist. If you want to skip the confirmation email, turn off **Confirm email** under Supabase → Authentication → Sign In / Providers → Email. Afterwards, consider turning off **Allow new users to sign up** so nobody else can register.

Until step 2 is done the page runs in **demo mode**: everything is saved in that browser only.

The order engine (`paper/engine.py`) runs in the same daily workflow right after the screener. It uses only completed daily bars, never fills an order twice, and its failure cannot stop the screener.

### If Supabase is blocked on your internet provider

Since February 2026 several Indian providers (Jio, Airtel, ACT) block `supabase.co`. The symptom is **"NetworkError when attempting to fetch resource"** when you sign in. To check, open `https://<your-project>.supabase.co/auth/v1/health` in the same browser: a short message such as *No API key found* means it is reachable; a page that never loads means it is blocked. The Supabase dashboard (`supabase.com`) is not affected, and neither is the daily job, because GitHub's servers are not behind these providers.

Fix: a free relay on Cloudflare that only forwards your own sign-in and table requests (`paper/cloudflare-worker.js`).

1. Sign up at cloudflare.com (free), then **Workers & Pages → Create → Create Worker**, name it (for example `paper-relay`), **Deploy**, then **Edit code**.
2. Replace everything with the contents of `paper/cloudflare-worker.js` and **Deploy**. Check the two lines at the top (your Supabase URL and `https://<you>.github.io`).
3. Copy the worker's address (`https://paper-relay.<name>.workers.dev`) into `supabaseUrl` in `docs/paper-config.js`. Keep the same publishable key.
4. Leave the GitHub secret `SUPABASE_URL` as the original `supabase.co` address.
5. The confirmation email's link points at `supabase.co` and will not open on a blocked network. Create your user in the dashboard instead: **Authentication → Users → Add user**, tick **Auto Confirm User**.

Test it with `node paper/test_worker.mjs`. Quick but per-device alternatives: switch to mobile data or another network, or change DNS to `1.1.1.1`.

**Tests:** `python3 paper/test_paper.py` (fees, fills, brackets, gaps) and `node paper/test_core.js` (funds maths, positions, P&L, insights).

---

## 🔧 Tweaking

Everything lives near the top of `screener.py`:

| Setting | What it does |
|---|---|
| `MARKETS` → `defaults` | the starting liquidity, price and max-move filters for each market |
| `MIN_LOOKBACK` | the shortest lookback the page accepts (5) |
| `SETTLE_MINUTES` | how long after the close to wait before trusting the day's candle (15) |
| `EARNINGS_ENABLED` | set to `False` to skip the earnings-date lookup |
| `HISTORY_PERIOD` | how much price history to download (3 years) |

You can also run it on your own computer: `pip install -r requirements.txt`, then `python screener.py`, and open `docs/index.html`.

---

## ❓ Troubleshooting

- **The page still shows yesterday.** Open **Actions** and check the latest run. A green tick with a recent time means it's published, so press **Check for new data**. If no run happened, use **Run workflow** (see *Schedule*).
- **A market shows "could not be refreshed".** That market's data source or Yahoo failed on the last run, so you're seeing its last good result. It retries on the next run. Open the run's **Run screener** log and look for lines starting `WARNING`.
- **India fails but the US works.** NSE sometimes blocks cloud servers. The script tries two NSE addresses, then the combined Nifty 500 list, before giving up.
- **A stock shows a huge one-day jump.** Check the "Data check" line in its panel. Splits and bonus issues are sometimes reported late by Yahoo and can look like a breakout.
- **No earnings date.** Yahoo's earnings dates are patchy, and the script looks them up only for stocks that appear in the results. When none is available the panel says so. Check before entering.

---

## ⚠️ Good to know

- **Data** comes from Yahoo Finance through `yfinance` (unofficial, occasionally gappy). Prices are split-adjusted but not dividend-adjusted, like most charting platforms.
- **End-of-day only.** It screens completed daily candles, so it is for planning, not intraday trading.
- **Not financial advice.** It's a screening tool. A breakout is a starting point for your own research, not a recommendation. The reference stop is a chart level, not a risk plan.

## 📁 What's in the repo

```
screener.py                  the whole program: fetch, screen, build the page
requirements.txt             Python packages
.github/workflows/daily.yml  the schedule (and the Run workflow button)
docs/index.html              the page GitHub serves (written by the script)
docs/market_us.json          last good US result (used if a refresh fails)
docs/market_in.json          last good India result
docs/version.json            tiny file the page checks for "new data"
docs/earnings_cache.json     remembered earnings dates, so runs stay fast
docs/paper.html              the paper-trading page (hand-written, not overwritten by the script)
docs/paper-core.js           its calculations (funds, fees, positions, stats)
docs/paper-config.js         your Supabase URL + publishable key
docs/fx.json                 latest USD/INR, written by the daily job
paper/schema.sql             database tables to paste into Supabase
paper/cloudflare-worker.js   optional relay for networks that block supabase.co
paper/engine.py, fees.py     the daily order engine and the Dhan charges
paper/test_*.py, test_core.js  tests
```
