"""Trade charges for the paper-trading engine (Dhan delivery pricing). Mirrors docs/paper-core.js exactly;
both are checked against paper/vectors.json by the tests, so change them together.

India (equity delivery): zero brokerage, STT both sides, stamp duty on buys, exchange + SEBI fees, 18% GST on
(brokerage + exchange + SEBI), and a DP charge (plus GST) once per stock per day on sells.
US (Dhan US Stocks): brokerage on both sides, rounded up to the cent, minimum $0.01 and maximum $10 per order.
Dhan cut it from 0.25% to 0.10% for trades from 26 Oct 2026 (US_RATE_CHANGE); earlier fills keep the old rate.
Every rate is a setting; these are only the starting values.
"""
from __future__ import annotations

import copy
import math

DEFAULT_SETTINGS = {
    "in": {"brokerage_pct": 0.0, "stt_pct": 0.1, "stamp_buy_pct": 0.015, "exch_pct": 0.00297, "sebi_pct": 0.0001,
           "gst_pct": 18.0, "dp_charge": 12.5, "slippage_bps": 0.0},
    "us": {"brokerage_pct": 0.10, "legacy_brokerage_pct": 0.25, "min_brokerage": 0.01, "max_brokerage": 10.0, "exch_pct": 0.005, "gst_pct": 18.0, "other_pct": 0.0, "slippage_bps": 0.0},
    "fx": {"markup_pct": 1.0, "gst_pct_of_inr": 0.179, "bank_charge_inr": 0.0, "payin_fee_usd": 0.0,
           "payin_free_from_usd": 100.0, "tcs_enabled": False, "tcs_rate_pct": 20.0,
           "tcs_threshold_inr": 1000000.0, "fallback_rate": 95.0},
    "engine": {"same_bar_priority": "stop"},
}


def merged_settings(saved: dict | None) -> dict:
    """Saved settings laid over the defaults, so a newly added setting always has a value."""
    out = copy.deepcopy(DEFAULT_SETTINGS)
    saved = copy.deepcopy(saved) if saved else {}
    if isinstance(saved.get("us"), dict) and "legacy_brokerage_pct" not in saved["us"]:
        # settings saved before the 26 Oct 2026 price cut still hold the old defaults: let the new ones apply
        if saved["us"].get("brokerage_pct") == 0.25:
            del saved["us"]["brokerage_pct"]
        if isinstance(saved.get("fx"), dict) and saved["fx"].get("payin_fee_usd") == 1:
            del saved["fx"]["payin_fee_usd"]
    for group, vals in (saved or {}).items():
        if isinstance(vals, dict) and isinstance(out.get(group), dict):
            out[group].update(vals)
    return out


def r2(x: float) -> float:
    """Round half up to 2 decimals (same formula as the JavaScript side)."""
    return math.floor(x * 100 + 0.5 + 1e-9) / 100


US_RATE_CHANGE = "2026-10-26"      # first session on Dhan's lower US brokerage


def trade_fees(portfolio: str, side: str, qty: float, price: float, settings: dict, dp_applies: bool = True,
               on_date: str | None = None) -> dict:
    """Itemised charges for one fill. `dp_applies` is False when a DP charge was already taken for this
    stock on this day (India sells only). The dict always carries a `total`."""
    value = qty * price
    if portfolio == "IN":
        c = settings["in"]
        brokerage = r2(value * c["brokerage_pct"] / 100)
        stt = r2(value * c["stt_pct"] / 100)
        exch = r2(value * c["exch_pct"] / 100)
        sebi = r2(value * c["sebi_pct"] / 100)
        stamp = r2(value * c["stamp_buy_pct"] / 100) if side == "BUY" else 0.0
        gst = r2((brokerage + exch + sebi) * c["gst_pct"] / 100)
        dp = r2(c["dp_charge"] * (1 + c["gst_pct"] / 100)) if side == "SELL" and dp_applies else 0.0
        parts = {"brokerage": brokerage, "stt": stt, "exchange": exch, "sebi": sebi, "stamp": stamp, "gst": gst, "dp": dp}
    else:
        c = settings["us"]
        pct = c["legacy_brokerage_pct"] if on_date and on_date < US_RATE_CHANGE else c["brokerage_pct"]
        raw = value * pct / 100
        brokerage = min(c["max_brokerage"], max(c["min_brokerage"], math.ceil(raw * 100 - 1e-9) / 100))
        other = r2(value * c["other_pct"] / 100)
        exch = r2(value * c["exch_pct"] / 100)
        gst = r2(brokerage * c["gst_pct"] / 100)
        parts = {"brokerage": brokerage, "exchange": exch, "gst": gst, "other": other}
    parts["total"] = r2(sum(parts.values()))
    return parts
