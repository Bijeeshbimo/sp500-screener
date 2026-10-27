"""Run:  python3 paper/test_paper.py     (no network, no extra packages)"""
from __future__ import annotations

import copy
import json
import sys
import unittest
from unittest import mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from engine import FirestoreStore, account_state, run_user, simulate, trigger_price  # noqa: E402
from fees import merged_settings, trade_fees  # noqa: E402
from playbook import playbook_run  # noqa: E402

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
        self.assertEqual(trade_fees("US", "BUY", 1, 25, S, True, "2026-10-01")["brokerage"], 0.07)
        self.assertEqual(trade_fees("US", "SELL", 0.001, 1, S)["total"], 0.01)      # minimum $0.01
        self.assertEqual(trade_fees("US", "BUY", 100, 150, S, True, "2026-10-01")["total"], 12.55)        # old 0.25% = $37.50, capped at $10, plus exchange and GST
        self.assertEqual(trade_fees("US", "BUY", 100, 150, S, True, "2026-10-26")["brokerage"], 10.0)   # new 0.10% = 15.00, capped at $10
        self.assertEqual(trade_fees("US", "BUY", 10, 100, S, True, "2026-10-26")["brokerage"], 1.0)
        self.assertEqual(merged_settings({"us": {"brokerage_pct": 0.25}})["us"]["brokerage_pct"], 0.10)          # stale saved default is replaced
        self.assertEqual(merged_settings({"us": {"brokerage_pct": 0.25, "legacy_brokerage_pct": 0.25}})["us"]["brokerage_pct"], 0.25)   # a deliberate setting is kept

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
            got = trade_fees(c["portfolio"], c["side"], c["qty"], c["price"], v["settings"], c["dp"], c.get("date"))
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


class FakeStore:
    """In-memory stand-in for FirestoreStore (same methods)."""

    def __init__(self):
        self.d = {}

    def put(self, uid, name, key, row):
        self.d.setdefault((uid, name), {})[key] = copy.deepcopy(row)

    def users(self):
        return ["u1"]

    def rows(self, uid, name):
        return [{"id": k, **copy.deepcopy(v)} for k, v in self.d.get((uid, name), {}).items()]

    def settings(self, uid):
        return self.d.get((uid, "settings"), {}).get("main", {}).get("data", {})

    def create_fill(self, uid, order_id, row):
        coll = self.d.setdefault((uid, "fills"), {})
        if f"auto-{order_id}" in coll:
            return False
        coll[f"auto-{order_id}"] = copy.deepcopy(row)
        return True

    def patch_order(self, uid, oid, patch):
        self.d[(uid, "orders")][oid].update(patch)

    def put_prices(self, uid, yf, dates, closes, chart=None):
        self.put(uid, "prices", yf, {"yf": yf, "dates": dates, "closes": closes, **({"chart": chart} if chart else {})})


def stub_fetch(days):
    """fetch(yfs, start) returning the given sessions for ABC.NS and a benchmark."""
    def fetch(yfs, start):
        out = {"ABC.NS": [bar(*d) for d in days], "^NSEI": [bar(d[0], 100, 100, 100, 100) for d in days]}
        return {y: out[y] for y in yfs if y in out}
    return fetch


class EngineRun(unittest.TestCase):
    def setUp(self):
        self.st = FakeStore()
        self.st.put("u1", "ledger", "l1", {"portfolio": "IN", "kind": "deposit", "date": "2026-10-01", "amount": 100000.0, "inr": 100000.0})
        self.st.put("u1", "orders", "o1", order("o1", stop_ref=95))
        self.st.put("u1", "orders", "o2", order("o2", side="SELL", type="STOP", price=95, status="waiting", parent_id="o1", oco_group="g"))
        self.st.put("u1", "orders", "o3", order("o3", side="SELL", type="LIMIT", price=110, status="waiting", parent_id="o1", oco_group="g"))
        for k in ("o1", "o2", "o3"):
            self.st.d[("u1", "orders")][k].pop("id", None)

    def status(self, oid):
        return self.st.d[("u1", "orders")][oid]["status"]

    def test_full_lifecycle_over_several_daily_runs(self):
        day1 = [("2026-10-02", 100, 102, 99, 101)]
        r = run_user(self.st, "u1", stub_fetch(day1))
        self.assertEqual((r["fills"], self.status("o1"), self.status("o2"), self.status("o3")), (1, "filled", "pending", "pending"))
        fill = self.st.d[("u1", "fills")]["auto-o1"]
        self.assertEqual((fill["price"], fill["source"], fill["order_id"]), (100, "auto", "o1"))
        self.assertTrue(fill["created_at"])
        # prices stored as one document per ticker, whole window
        self.assertEqual(self.st.d[("u1", "prices")]["ABC.NS"]["dates"], ["2026-10-02"])
        self.assertIn("^NSEI", self.st.d[("u1", "prices")])
        ch = self.st.d[("u1", "prices")]["ABC.NS"]["chart"]            # candles for the positions preview
        self.assertEqual(set(ch), {"d", "o", "h", "l", "c"}); self.assertEqual(len(ch["d"]), len(ch["h"]))

        again = run_user(self.st, "u1", stub_fetch(day1))                      # same data again: nothing changes
        self.assertEqual((again["fills"], len(self.st.d[("u1", "fills")])), (0, 1))

        day2 = day1 + [("2026-10-03", 100, 112, 94, 100)]                       # touches both stop and target
        r = run_user(self.st, "u1", stub_fetch(day2))
        self.assertEqual(r["fills"], 1)
        sell = self.st.d[("u1", "fills")]["auto-o2"]
        self.assertEqual((sell["side"], sell["price"], sell["date"]), ("SELL", 95, "2026-10-03"))
        self.assertEqual((self.status("o2"), self.status("o3")), ("filled", "cancelled"))
        self.assertEqual(self.st.d[("u1", "prices")]["ABC.NS"]["closes"], [101, 100])
        self.assertEqual(run_user(self.st, "u1", stub_fetch(day2))["fills"], 0)  # everything settled: no work

    def test_children_are_repaired_if_a_run_stopped_after_the_fill_was_saved(self):
        self.st.create_fill("u1", "o1", {"order_id": "o1", "portfolio": "IN", "symbol": "ABC", "yf": "ABC.NS", "side": "BUY", "qty": 10,
                                         "price": 100, "date": "2026-10-02", "fees": {"total": 0}, "fees_total": 0, "source": "auto"})
        self.st.d[("u1", "orders")]["o1"]["status"] = "filled"                 # parent settled, children still 'waiting'
        run_user(self.st, "u1", stub_fetch([("2026-10-02", 100, 102, 99, 101)]))
        self.assertEqual((self.status("o2"), self.st.d[("u1", "orders")]["o2"]["after_date"]), ("pending", "2026-10-02"))

    def test_children_cancelled_when_the_entry_never_filled(self):
        self.st.d[("u1", "orders")]["o1"]["status"] = "cancelled"
        run_user(self.st, "u1", stub_fetch([("2026-10-02", 100, 102, 99, 101)]))
        self.assertEqual((self.status("o2"), self.status("o3")), ("cancelled", "cancelled"))

    def test_unknown_ticker_is_flagged_not_crashed(self):
        run_user(self.st, "u1", lambda yfs, start: {})
        self.assertIn("no price data", self.st.d[("u1", "orders")]["o1"]["status_note"])
        self.assertEqual(self.status("o1"), "pending")

    def test_user_with_no_records_is_skipped(self):
        empty = FakeStore()
        self.assertEqual(run_user(empty, "u1", stub_fetch([]))["fills"], 0)

    def test_user_settings_are_applied(self):
        self.st.put("u1", "settings", "main", {"data": {"in": {"slippage_bps": 100}}})
        run_user(self.st, "u1", stub_fetch([("2026-10-02", 100, 102, 99, 101)]))
        self.assertEqual(self.st.d[("u1", "fills")]["auto-o1"]["price"], 101.0)   # 1% slippage on a market buy at 100


class FirestoreAdapter(unittest.TestCase):
    """Checks the calls FirestoreStore makes, against a mock of the Firestore client (needs firebase-admin installed)."""

    def setUp(self):
        try:
            import firebase_admin  # noqa: F401
            from google.api_core.exceptions import AlreadyExists  # noqa: F401
        except ImportError:
            self.skipTest("firebase-admin not installed")
        self.db = mock.MagicMock()
        with mock.patch("firebase_admin.initialize_app"), mock.patch("firebase_admin.credentials.Certificate") as cert, \
                mock.patch("firebase_admin.firestore.client", return_value=self.db):
            self.store = FirestoreStore('{"type": "service_account"}')
            cert.assert_called_once_with({"type": "service_account"})

    def test_paths_and_documents(self):
        self.db.collection.return_value.list_documents.return_value = [mock.Mock(id="zed"), mock.Mock(id="abc")]
        self.assertEqual(self.store.users(), ["abc", "zed"])
        self.db.collection.assert_called_with("users")
        doc = mock.Mock(id="o1"); doc.to_dict.return_value = {"status": "pending"}
        self.db.collection.return_value.stream.return_value = [doc]
        self.assertEqual(self.store.rows("u1", "orders"), [{"id": "o1", "status": "pending"}])
        self.db.collection.assert_called_with("users/u1/orders")
        self.store.patch_order("u1", "o1", {"status": "filled"})
        self.db.document.assert_called_with("users/u1/orders/o1"); self.db.document.return_value.update.assert_called_with({"status": "filled"})
        self.store.put_prices("u1", "^NSEI", ["2026-10-02"], [1.5])
        self.db.document.assert_called_with("users/u1/prices/^NSEI")
        self.db.document.return_value.set.assert_called_with({"yf": "^NSEI", "dates": ["2026-10-02"], "closes": [1.5]})

    def test_settings_present_and_absent(self):
        snap = mock.Mock(exists=True); snap.to_dict.return_value = {"data": {"us": {"min_brokerage": 0.02}}}
        self.db.document.return_value.get.return_value = snap
        self.assertEqual(self.store.settings("u1"), {"us": {"min_brokerage": 0.02}})
        self.db.document.assert_called_with("users/u1/settings/main")
        self.db.document.return_value.get.return_value = mock.Mock(exists=False)
        self.assertEqual(self.store.settings("u1"), {})

    def test_create_fill_uses_a_fixed_id_and_reports_duplicates(self):
        from google.api_core.exceptions import AlreadyExists
        self.assertTrue(self.store.create_fill("u1", "o9", {"x": 1}))
        self.db.document.assert_called_with("users/u1/fills/auto-o9"); self.db.document.return_value.create.assert_called_with({"x": 1})
        self.db.document.return_value.create.side_effect = AlreadyExists("exists")
        self.assertFalse(self.store.create_fill("u1", "o9", {"x": 1}))


class PlaybookRules(unittest.TestCase):
    CFG = {"t1_r": 3, "t1_pct": 30, "t2_r": 6, "t2_pct": 20, "be_r": 3, "ema_len": 5}

    def run_pb(self, days, **kw):
        bars = [("2026-09-%02d" % (i + 1), 100, 101, 99, 100) for i in range(8)] + days      # eight flat sessions warm up the EMA
        a = dict(entry_date="2026-09-08", entry_px=100.0, qty=10.0, cost_px=100.3, stop=90.0, cfg=self.CFG, india=False)
        a.update(kw)
        return playbook_run(bars, **a)

    def test_partials_then_stop_to_cost(self):
        r = self.run_pb([("2026-09-09", 105, 131, 104, 128), ("2026-09-10", 126, 127, 100, 101)])
        self.assertEqual([(e["reason"], e["qty"], e["price"]) for e in r["events"]], [("t1", 3.0, 130.0), ("stop", 7.0, 100.3)])
        self.assertTrue(r["state"]["finished"])

    def test_gap_up_fills_at_the_open_and_both_targets_can_fill(self):
        r = self.run_pb([("2026-09-09", 165, 170, 164, 168)])
        self.assertEqual([(e["reason"], e["qty"], e["price"]) for e in r["events"]], [("t1", 3.0, 165.0), ("t2", 2.0, 165.0)])
        self.assertEqual(r["state"]["remaining"], 5.0)
        self.assertTrue(r["state"]["be"])

    def test_stop_beats_target_on_the_same_bar_unless_told_otherwise(self):
        day = [("2026-09-09", 100, 131, 89, 100)]
        self.assertEqual([e["reason"] for e in self.run_pb(day)["events"]], ["stop"])
        self.assertEqual([e["reason"] for e in self.run_pb(day, stop_first=False)["events"]], ["t1", "stop"])

    def test_gap_through_the_stop_fills_at_the_open(self):
        r = self.run_pb([("2026-09-09", 85, 86, 84, 85)])
        self.assertEqual((r["events"][0]["reason"], r["events"][0]["price"]), ("stop", 85.0))

    def test_ema_exit_after_breakeven_sells_next_open(self):
        up = [("2026-09-%02d" % (9 + i), 130 + i, 132 + i, 129 + i, 131 + i) for i in range(3)]          # rises through 3R
        r = self.run_pb(up + [("2026-09-12", 120, 121, 118, 119), ("2026-09-13", 117, 118, 110, 112)])    # closes under the 5 EMA
        self.assertEqual([e["reason"] for e in r["events"]], ["t1", "ema"])
        self.assertEqual(r["events"][-1]["date"], "2026-09-13")
        self.assertEqual(r["events"][-1]["price"], 117.0)

    def test_india_rounds_the_slices_to_whole_shares(self):
        r = self.run_pb([("2026-09-09", 165, 170, 164, 168)], india=True, qty=7.0)
        self.assertEqual([(e["reason"], e["qty"]) for e in r["events"]], [("t1", 2.0), ("t2", 1.0)])      # 2.1 -> 2, 1.4 -> 1

    def test_no_valid_risk_means_no_playbook(self):
        self.assertIsNone(self.run_pb([], stop=100.0))


class EnginePlaybook(unittest.TestCase):
    def test_entry_with_a_playbook_sells_in_stages_without_duplicates(self):
        st = FakeStore()
        st.put("u1", "ledger", "l1", {"portfolio": "IN", "kind": "deposit", "date": "2026-10-01", "amount": 100000.0, "inr": 100000.0})
        pb = {"t1_r": 3, "t1_pct": 30, "t2_r": 6, "t2_pct": 20, "be_r": 3, "ema_len": 20, "stop": 90}
        st.put("u1", "orders", "o1", order("o1", stop_ref=90, pb=pb))
        st.d[("u1", "orders")]["o1"].pop("id", None)
        days = [("2026-10-02", 100, 102, 99, 101), ("2026-10-03", 105, 131, 104, 128), ("2026-10-06", 126, 127, 100, 101)]
        run_user(st, "u1", stub_fetch(days[:2]))
        fills = st.d[("u1", "fills")]
        self.assertEqual(sorted(fills), ["auto-o1", "auto-o1-pb-t1"])
        t1 = fills["auto-o1-pb-t1"]
        self.assertEqual((t1["side"], t1["qty"], t1["price"], t1["source"], t1["date"]), ("SELL", 3.0, 130.0, "playbook", "2026-10-03"))
        self.assertEqual(st.d[("u1", "orders")]["o1"]["pb_state"]["be"], True)
        run_user(st, "u1", stub_fetch(days[:2]))
        self.assertEqual(len(st.d[("u1", "fills")]), 2)                                       # rerun adds nothing
        run_user(st, "u1", stub_fetch(days))
        self.assertEqual(sorted(st.d[("u1", "fills")]), ["auto-o1", "auto-o1-pb-stop", "auto-o1-pb-t1"])
        self.assertEqual(st.d[("u1", "fills")]["auto-o1-pb-stop"]["qty"], 7.0)
        self.assertTrue(st.d[("u1", "orders")]["o1"]["pb_state"]["finished"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
