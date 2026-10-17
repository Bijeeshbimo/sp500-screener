"""Run:  python3 paper/test_paper.py     (no network, no extra packages)"""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from engine import account_state, simulate, trigger_price  # noqa: E402
from fees import merged_settings, trade_fees  # noqa: E402

S = merged_settings({})


def bar(d, o, h, l, c):
    return (d, o, h, l, c)


def order(i, **kw):
    base = {"id": i, "portfolio": "IN", "symbol": "ABC", "yf": "ABC.NS", "side": "BUY", "qty": 10, "type": "MARKET",
            "price": None, "after_date": "2026-10-01", "expiry": None, "oco_group": None, "parent_id": None,
            "stop_ref": None, "tag": None, "note": None, "status": "pending", "created_at": f"2026-10-01T00:00:0{i[-1]}"}
    base.update(kw)
    return base


class Fees(unittest.TestCase):
    def test_us_brokerage_rounds_up_to_the_cent(self):
        # reported on the ValuePickr forum: a $25 order attracted $0.07
        self.assertEqual(trade_fees("US", "BUY", 1, 25, S)["total"], 0.07)
        self.assertEqual(trade_fees("US", "SELL", 0.001, 1, S)["total"], 0.01)      # minimum $0.01
        self.assertEqual(trade_fees("US", "BUY", 100, 150, S)["total"], 37.5)

    def test_india_delivery_buy_and_sell(self):
        b = trade_fees("IN", "BUY", 100, 500, S)
        self.assertEqual((b["stt"], b["exchange"], b["sebi"], b["stamp"], b["gst"], b["dp"]), (50.0, 1.49, 0.05, 7.5, 0.28, 0.0))
        self.assertEqual(b["total"], 59.32)
        s = trade_fees("IN", "SELL", 100, 550, S)
        self.assertEqual((s["stt"], s["stamp"], s["dp"]), (55.0, 0.0, 14.75))
        self.assertEqual(s["total"], 71.74)
        self.assertEqual(trade_fees("IN", "SELL", 100, 550, S, dp_applies=False)["dp"], 0.0)

    def test_parity_vectors_exist(self):
        v = json.loads((Path(__file__).parent / "vectors.json").read_text())
        for c in v["cases"]:
            got = trade_fees(c["portfolio"], c["side"], c["qty"], c["price"], v["settings"], c["dp"])
            self.assertEqual(got, c["fees"])


class Triggers(unittest.TestCase):
    def test_market(self):
        self.assertEqual(trigger_price(order("o1"), bar("d", 100, 105, 99, 103)), 100)

    def test_limit_buy(self):
        o = order("o1", type="LIMIT", price=98)
        self.assertEqual(trigger_price(o, bar("d", 100, 105, 97, 103)), 98)        # dips to the limit
        self.assertEqual(trigger_price(o, bar("d", 96, 105, 95, 103)), 96)         # gaps below: better price at the open
        self.assertIsNone(trigger_price(o, bar("d", 100, 105, 99, 103)))

    def test_stop_sell_gap_fills_at_open(self):
        o = order("o1", side="SELL", type="STOP", price=95)
        self.assertEqual(trigger_price(o, bar("d", 90, 96, 88, 92)), 90)           # gapped through the stop
        self.assertEqual(trigger_price(o, bar("d", 100, 101, 94, 96)), 95)
        self.assertIsNone(trigger_price(o, bar("d", 100, 101, 96, 99)))

    def test_stop_buy_and_limit_sell(self):
        self.assertEqual(trigger_price(order("o1", type="STOP", price=110), bar("d", 108, 112, 107, 111)), 110)
        self.assertEqual(trigger_price(order("o1", side="SELL", type="LIMIT", price=110), bar("d", 112, 113, 111, 112)), 112)

    def test_slippage_hurts_market_but_not_limit(self):
        self.assertAlmostEqual(trigger_price(order("o1"), bar("d", 100, 101, 99, 100), 10), 100.1)
        self.assertEqual(trigger_price(order("o1", type="LIMIT", price=100), bar("d", 100, 101, 99, 100), 10), 100)


class Simulation(unittest.TestCase):
    def run_sim(self, orders, bars, cash=100000.0, hold=None, dp=None):
        return simulate(orders, {"ABC.NS": bars}, cash, hold or {}, dp or set(), "IN", S)

    def test_market_buy_fills_next_open_and_charges_fees(self):
        bars = [bar("2026-10-01", 50, 51, 49, 50), bar("2026-10-02", 100, 102, 99, 101)]
        res = self.run_sim([order("o1")], bars)
        f = res["fills"][0]
        self.assertEqual((f["date"], f["price"]), ("2026-10-02", 100))       # not the order-day bar
        self.assertEqual(res["updates"]["o1"]["status"], "filled")
        self.assertAlmostEqual(res["cash"], 100000 - 1000 - f["fees_total"])
        self.assertEqual(res["holdings"]["ABC"], 10)

    def test_bracket_children_wait_then_stop_beats_target_on_the_same_bar(self):
        bars = [bar("2026-10-02", 100, 101, 99, 100),     # entry fills at this open
                bar("2026-10-03", 100, 112, 94, 100)]     # touches both the target and the stop
        entry = order("o1", stop_ref=95)
        stop = order("o2", side="SELL", type="STOP", price=95, status="waiting", parent_id="o1", oco_group="g1")
        tgt = order("o3", side="SELL", type="LIMIT", price=110, status="waiting", parent_id="o1", oco_group="g1")
        res = self.run_sim([entry, stop, tgt], bars)
        self.assertEqual([(f["side"], f["date"], f["price"]) for f in res["fills"]],
                         [("BUY", "2026-10-02", 100), ("SELL", "2026-10-03", 95)])
        self.assertEqual(res["updates"]["o3"]["status"], "cancelled")
        self.assertEqual(res["holdings"]["ABC"], 0)

    def test_children_do_not_trigger_on_the_entry_session(self):
        bars = [bar("2026-10-02", 100, 120, 90, 100)]     # wild entry day
        res = self.run_sim([order("o1"), order("o2", side="SELL", type="STOP", price=95, status="waiting", parent_id="o1")], bars)
        self.assertEqual(len(res["fills"]), 1)
        self.assertEqual(res["updates"]["o2"]["status"], "pending")
        self.assertEqual(res["updates"]["o2"]["after_date"], "2026-10-02")

    def test_target_wins_when_setting_says_so(self):
        s2 = merged_settings({"engine": {"same_bar_priority": "target"}})
        bars = [bar("2026-10-03", 100, 112, 94, 100)]
        orders = [order("o2", side="SELL", type="STOP", price=95, oco_group="g"),
                  order("o3", side="SELL", type="LIMIT", price=110, oco_group="g")]
        res = simulate(orders, {"ABC.NS": bars}, 0.0, {"ABC": 10}, set(), "IN", s2)
        self.assertEqual(res["fills"][0]["price"], 110)

    def test_insufficient_cash_and_shares_are_rejected(self):
        bars = [bar("2026-10-02", 100, 101, 99, 100)]
        self.assertEqual(self.run_sim([order("o1")], bars, cash=500.0)["updates"]["o1"]["status"], "rejected")
        res = self.run_sim([order("o1", side="SELL")], bars, hold={"ABC": 3})
        self.assertEqual(res["updates"]["o1"]["status"], "rejected")
        self.assertEqual(res["fills"], [])

    def test_unfilled_limit_stays_pending_then_expires(self):
        bars = [bar("2026-10-02", 100, 101, 99, 100), bar("2026-10-03", 100, 101, 99, 100), bar("2026-10-06", 100, 101, 99, 100)]
        res = self.run_sim([order("o1", type="LIMIT", price=90, expiry="2026-10-03")], bars)
        self.assertEqual(res["fills"], [])
        self.assertEqual(res["updates"]["o1"]["status"], "expired")
        res = self.run_sim([order("o1", type="LIMIT", price=90)], bars)
        self.assertEqual(res["updates"], {})                 # still pending, nothing to write

    def test_dp_charge_taken_once_per_stock_per_day(self):
        bars = [bar("2026-10-02", 100, 101, 99, 100)]
        orders = [order("o1", side="SELL", qty=4), order("o2", side="SELL", qty=6)]
        res = self.run_sim(orders, bars, hold={"ABC": 10})
        self.assertEqual([f["fees"]["dp"] for f in res["fills"]], [14.75, 0.0])

    def test_filled_orders_are_ignored_and_orders_before_after_date_wait(self):
        bars = [bar("2026-10-01", 100, 101, 99, 100)]
        self.assertEqual(self.run_sim([order("o1", status="filled")], bars)["fills"], [])
        self.assertEqual(self.run_sim([order("o1")], bars)["fills"], [])       # bar is not after `after_date`

    def test_account_state_from_records(self):
        ledger = [{"portfolio": "IN", "kind": "deposit", "amount": 1000}, {"portfolio": "US", "kind": "deposit", "amount": 5}]
        fills = [{"portfolio": "IN", "symbol": "ABC", "side": "BUY", "qty": 2, "price": 100, "fees_total": 1, "date": "d", "fees": {}},
                 {"portfolio": "IN", "symbol": "ABC", "side": "SELL", "qty": 1, "price": 110, "fees_total": 15, "date": "d2", "fees": {"dp": 14.75}}]
        cash, hold, dp = account_state("IN", ledger, fills)
        self.assertEqual((cash, hold["ABC"], dp), (1000 - 201 + 95, 1, {("ABC", "d2")}))


if __name__ == "__main__":
    unittest.main(verbosity=2)
