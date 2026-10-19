#!/usr/bin/env python3
"""
Paper-trading order engine (end-of-day). Runs in the daily GitHub Action right after the screener.

  1. writes docs/fx.json (latest USD/INR close, used to pre-fill the Add Funds dialog)
  2. if FIREBASE_SERVICE_ACCOUNT is set: reads each user's pending orders from Firestore, downloads daily bars,
     fills what the bars allow, stores the fills and daily closes, and updates order statuses.

Data layout (Firestore): users/{uid}/ledger | orders | fills | prices | settings. The security rules let a signed-in
user touch only their own folder; this script uses a service account, which bypasses the rules.

Fill rules (daily bars only, so deliberately simple and conservative):
  MARKET        fills at the first eligible session's open
  LIMIT buy     open <= limit -> open;  else low <= limit -> limit price        (sell: mirror with highs)
  STOP sell     open <= stop  -> open (a gap through the stop fills at the open); else low <= stop -> stop price
  STOP buy      open >= stop  -> open;  else high >= stop -> stop price
  Orders in one OCO group cancel each other; if both trigger on the same bar, the STOP wins (setting).
  Bracket children (parent_id) wait until the parent fills, then become live from the NEXT session.
  A buy without enough cash, or a sell of shares you do not hold, is rejected (no margin, no shorting).
An automatic fill is stored under the id "auto-<order id>", so running the engine twice can never fill an order twice.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))   # repo root, for screener.py
from fees import merged_settings, r2, trade_fees  # noqa: E402

DOCS = Path(__file__).resolve().parent.parent / "docs"
BENCH = {"IN": "^NSEI", "US": "^GSPC"}


# --------------------------------------------------------------- simulation --
def trigger_price(order: dict, bar: tuple, slip_bps: float = 0.0) -> float | None:
    """Price at which `order` fills on `bar` = (date, open, high, low, close), or None if it does not trigger."""
    _, o, h, l, _c = bar
    typ, side, p = order["type"], order["side"], order.get("price")
    px = None
    if typ == "MARKET":
        px = o
    elif typ == "LIMIT":
        if side == "BUY":
            px = o if o <= p else (p if l <= p else None)
        else:
            px = o if o >= p else (p if h >= p else None)
    elif typ == "STOP":
        if side == "SELL":
            px = o if o <= p else (p if l <= p else None)
        else:
            px = o if o >= p else (p if h >= p else None)
    if px is None:
        return None
    if typ in ("MARKET", "STOP") and slip_bps:      # a limit price is a promise; market/stop fills can slip
        px = px * (1 + slip_bps / 1e4) if side == "BUY" else px * (1 - slip_bps / 1e4)
    return round(px, 4)


def simulate(orders: list[dict], bars: dict[str, list[tuple]], cash: float, holdings: dict[str, float],
             dp_done: set, portfolio: str, settings: dict) -> dict:
    """Pure function: returns {"fills": [...], "updates": {order_id: {...patch}}, "cash": x, "holdings": {...}}.
    `orders` are this portfolio's pending/waiting orders (dicts as stored); `bars` maps yahoo ticker to
    ascending [(date, o, h, l, c)] of COMPLETE sessions only."""
    st = {o["id"]: dict(o) for o in orders if o["status"] in ("pending", "waiting")}
    updates: dict[str, dict] = {}
    fills: list[dict] = []
    holdings = dict(holdings)
    slip = settings["in" if portfolio == "IN" else "us"].get("slippage_bps", 0.0)
    prefer_stop = settings["engine"].get("same_bar_priority", "stop") == "stop"
    bar_by = {yf: {b[0]: b for b in rows} for yf, rows in bars.items()}
    first = min((o["after_date"] for o in st.values()), default=None)
    dates = sorted({d for m in bar_by.values() for d in m if first and d > first})

    def settle(oid: str, **patch):
        updates.setdefault(oid, {}).update(patch)
        st[oid].update(patch)

    def drop_group(group, keep_id, note):
        for oid, o in st.items():
            if oid != keep_id and o.get("oco_group") == group and o["status"] in ("pending", "waiting"):
                settle(oid, status="cancelled", status_note=note)

    for d in dates:
        # expiry and orphaned bracket children
        for oid, o in list(st.items()):
            if o["status"] == "pending" and o.get("expiry") and d > o["expiry"]:
                settle(oid, status="expired", status_note="expired unfilled")
            if o["status"] == "waiting":
                par = st.get(o["parent_id"])
                if par is not None and par["status"] in ("cancelled", "expired", "rejected"):
                    settle(oid, status="cancelled", status_note="entry order did not fill")

        hits = []
        for oid, o in st.items():
            if o["status"] != "pending" or d <= o["after_date"]:
                continue
            bar = bar_by.get(o["yf"], {}).get(d)
            if not bar:
                continue
            px = trigger_price(o, bar, slip)
            if px is not None:
                hits.append((oid, px))

        # same-bar conflicts inside an OCO group: stop (or target) first, otherwise the earlier order
        def rank(item):
            o = st[item[0]]
            is_stop = o["type"] == "STOP"
            return (0 if (is_stop == prefer_stop) else 1, o["created_at"])
        grouped: dict[str, list] = defaultdict(list)
        for h in hits:
            grouped[st[h[0]].get("oco_group") or "_" + h[0]].append(h)
        ordered = [sorted(items, key=rank)[0] for items in grouped.values()]
        ordered.sort(key=lambda h: (st[h[0]]["created_at"], h[0]))

        for oid, px in ordered:
            o = st[oid]
            if o["status"] != "pending":          # cancelled by an earlier fill this same session
                continue
            qty = float(o["qty"])
            dp_applies = (o["symbol"], d) not in dp_done
            fee = trade_fees(portfolio, o["side"], qty, px, settings, dp_applies)
            if o["side"] == "BUY":
                cost = qty * px + fee["total"]
                if cost > cash + 1e-9:
                    settle(oid, status="rejected", status_note=f"not enough cash on {d} (needed {r2(cost)}, had {r2(cash)})")
                    continue
                cash -= cost
                holdings[o["symbol"]] = holdings.get(o["symbol"], 0.0) + qty
            else:
                if holdings.get(o["symbol"], 0.0) + 1e-9 < qty:
                    settle(oid, status="rejected", status_note=f"not enough shares on {d} (held {holdings.get(o['symbol'], 0.0):g})")
                    continue
                cash += qty * px - fee["total"]
                holdings[o["symbol"]] -= qty
                if fee.get("dp"):
                    dp_done.add((o["symbol"], d))
            fills.append({"order_id": oid, "portfolio": portfolio, "symbol": o["symbol"], "yf": o["yf"], "side": o["side"],
                          "qty": qty, "price": px, "date": d, "fees": fee, "fees_total": fee["total"], "source": "auto",
                          "stop_ref": o.get("stop_ref"), "tag": o.get("tag"), "note": o.get("note")})
            settle(oid, status="filled", status_note=f"filled {d} @ {px:g}")
            if o.get("oco_group"):
                drop_group(o["oco_group"], oid, f"cancelled: the other leg filled {d}")
            for cid, c in st.items():                 # bracket children go live from the next session
                if c["status"] == "waiting" and c.get("parent_id") == oid:
                    settle(cid, status="pending", after_date=d, status_note=None)
    return {"fills": fills, "updates": updates, "cash": cash, "holdings": holdings}


def account_state(portfolio: str, ledger: list[dict], fills: list[dict]) -> tuple[float, dict, set]:
    """Cash, share counts and 'DP already charged' markers worked out from the stored records."""
    cash = 0.0
    for r in ledger:
        if r["portfolio"] == portfolio:
            cash += float(r["amount"]) if r["kind"] == "deposit" else -float(r["amount"])
    holdings: dict[str, float] = defaultdict(float)
    dp_done = set()
    for f in fills:
        if f["portfolio"] != portfolio:
            continue
        q, p, fee = float(f["qty"]), float(f["price"]), float(f.get("fees_total") or 0)
        if f["side"] == "BUY":
            cash -= q * p + fee
            holdings[f["symbol"]] += q
        else:
            cash += q * p - fee
            holdings[f["symbol"]] -= q
            if (f.get("fees") or {}).get("dp"):
                dp_done.add((f["symbol"], f["date"]))
    return cash, dict(holdings), dp_done


# ---------------------------------------------------------------------- io ---
class FirestoreStore:
    """All database access lives here, so the rest of the engine can be tested with a fake."""

    def __init__(self, service_account_json: str):
        import firebase_admin
        from firebase_admin import credentials, firestore
        app = firebase_admin.initialize_app(credentials.Certificate(json.loads(service_account_json)))
        self.db = firestore.client(app)

    def users(self) -> list[str]:
        # list_documents also returns users that only have sub-collections (no document of their own)
        return sorted(d.id for d in self.db.collection("users").list_documents())

    def rows(self, uid: str, name: str) -> list[dict]:
        return [{"id": d.id, **(d.to_dict() or {})} for d in self.db.collection(f"users/{uid}/{name}").stream()]

    def settings(self, uid: str) -> dict:
        d = self.db.document(f"users/{uid}/settings/main").get()
        return (d.to_dict() or {}).get("data", {}) if d.exists else {}

    def create_fill(self, uid: str, order_id: str, row: dict) -> bool:
        """False if this order already has its automatic fill (a previous run got there first)."""
        from google.api_core.exceptions import AlreadyExists
        try:
            self.db.document(f"users/{uid}/fills/auto-{order_id}").create(row)
            return True
        except AlreadyExists:
            return False

    def patch_order(self, uid: str, order_id: str, patch: dict) -> None:
        self.db.document(f"users/{uid}/orders/{order_id}").update(patch)

    def put_prices(self, uid: str, yf: str, dates: list[str], closes: list[float]) -> None:
        self.db.document(f"users/{uid}/prices/{yf.replace('/', '_')}").set({"yf": yf, "dates": dates, "closes": closes})


def fetch_bars(yfs: list[str], start: str) -> dict[str, list[tuple]]:
    """Complete daily bars from `start`: {ticker: [(date, o, h, l, c)]}. A session still forming is dropped."""
    import pandas as pd
    import yfinance as yf
    import screener as sc

    out: dict[str, list[tuple]] = {}
    for i in range(0, len(yfs), 40):
        chunk = yfs[i:i + 40]
        data = yf.download(chunk, start=start, interval="1d", auto_adjust=False, group_by="ticker",
                           threads=True, progress=False)
        for t in chunk:
            try:
                sub = data[t] if isinstance(data.columns, pd.MultiIndex) else data
                sub = sub[["Open", "High", "Low", "Close"]].dropna()
            except (KeyError, TypeError):
                continue
            if sub.empty:
                continue
            india = t.endswith(".NS") or t == BENCH["IN"]
            m = sc.MARKETS["IN" if india else "US"]
            sub = sc.drop_incomplete_today(sub, m["tz"], m["close"])
            out[t] = [(ix.strftime("%Y-%m-%d"), float(r.Open), float(r.High), float(r.Low), float(r.Close))
                      for ix, r in sub.iterrows()]
    return out


def write_fx() -> None:
    """docs/fx.json = latest USD/INR close. A failure keeps the old file."""
    try:
        import yfinance as yf
        h = yf.Ticker("USDINR=X").history(period="10d", interval="1d")["Close"].dropna()
        if h.empty:
            return
        payload = {"usdinr": round(float(h.iloc[-1]), 4), "date": h.index[-1].strftime("%Y-%m-%d")}
        path = DOCS / "fx.json"
        old = json.loads(path.read_text()) if path.exists() else {}
        if old != payload:
            path.write_text(json.dumps(payload))
        print("USD/INR", payload)
    except Exception as e:       # never fail the daily run because of FX
        print("fx skipped:", e)


def run_user(store, uid: str, fetch=None) -> dict:
    """Process one user. `store` is a FirestoreStore (or a fake in tests); `fetch(yfs, start)` returns the bars."""
    fetch = fetch or fetch_bars
    orders, ledger, fills = store.rows(uid, "orders"), store.rows(uid, "ledger"), store.rows(uid, "fills")
    settings = merged_settings(store.settings(uid))
    o_u = [o for o in orders if o.get("status") in ("pending", "waiting")]
    live_ids = {o["id"] for o in o_u}
    fill_date = {f["order_id"]: f["date"] for f in fills if f.get("order_id")}
    for o in list(o_u):                      # repair bracket children whose parent was settled by an earlier run
        if o["status"] == "waiting" and o.get("parent_id") not in live_ids:
            if o["parent_id"] in fill_date:
                patch = {"status": "pending", "after_date": fill_date[o["parent_id"]], "status_note": None}
            else:
                patch = {"status": "cancelled", "status_note": "entry order did not fill"}
            store.patch_order(uid, o["id"], patch)
            o.update(patch)
    o_u = [o for o in o_u if o["status"] in ("pending", "waiting")]
    portfolios = {r["portfolio"] for r in ledger + fills + o_u}
    yfs = {r["yf"] for r in o_u} | {r["yf"] for r in fills} | {BENCH[p] for p in portfolios}
    starts = [r["after_date"] for r in o_u] + [r["date"] for r in fills] + [r["date"] for r in ledger]
    summary = {"fills": 0, "updates": 0, "missing": []}
    if not yfs or not starts:
        return summary
    start = (dt.date.fromisoformat(min(starts)) - dt.timedelta(days=7)).isoformat()
    bars = fetch(sorted(yfs), start)
    missing = sorted(y for y in yfs if y not in bars)
    summary["missing"] = missing
    if missing:
        print("no price data for", missing)
    for t, rows in bars.items():             # the whole window every time, so the stored series is always complete
        store.put_prices(uid, t, [b[0] for b in rows], [round(b[4], 4) for b in rows])
    now = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    for p in ("IN", "US"):
        po = [o for o in o_u if o["portfolio"] == p]
        if not po:
            continue
        cash, hold, dp_done = account_state(p, ledger, fills)
        res = simulate(po, {y: bars[y] for y in {o["yf"] for o in po} if y in bars}, cash, hold, dp_done, p, settings)
        for f in res["fills"]:
            store.create_fill(uid, f["order_id"], {**f, "created_at": now})     # False = an earlier run already did this one
        for oid, patch in res["updates"].items():
            store.patch_order(uid, oid, patch)
        for o in po:                          # flag a ticker Yahoo has no data for (possible typo)
            if o["id"] not in res["updates"] and o["yf"] in missing and not o.get("status_note"):
                store.patch_order(uid, o["id"], {"status_note": f"no price data found for {o['yf']}"})
        summary["fills"] += len(res["fills"]); summary["updates"] += len(res["updates"])
        print(f"{p}: {len(res['fills'])} fill(s), {len(res['updates'])} order update(s)")
    return summary


def main() -> int:
    write_fx()
    sa = os.environ.get("FIREBASE_SERVICE_ACCOUNT", "").strip()
    if not sa:
        print("paper engine: FIREBASE_SERVICE_ACCOUNT is not set, nothing to do")
        return 0
    try:
        store = FirestoreStore(sa)
        users = store.users()
    except Exception as e:
        print("paper engine: could not open the database:", e)
        return 1
    for uid in users:
        run_user(store, uid)
    return 0


if __name__ == "__main__":
    sys.exit(main())
