"""Profit-booking playbook: partial sells at R multiples, stop to cost, exit on a close below an EMA.
Mirrors docs/paper-core.js (playbookRun); both are checked against paper/vectors.json, so change them together.

1R = entry price - initial stop. Walking the daily bars after the entry session:
  * the hard stop is checked first (a gap through it fills at the open), then the targets (a gap up fills at the open);
    with same_bar_priority = "target" the targets go first;
  * target 1 sells t1_pct % of the ORIGINAL quantity at entry + t1_r * R, target 2 sells t2_pct % at entry + t2_r * R;
  * once price has reached entry + be_r * R the stop moves to cost (average cost including the buy charges),
    effective from the NEXT session;
  * from then on, a close below the ema_len EMA sells everything that is left at the next session's open.
"""
from __future__ import annotations

import math

PLAYBOOK_DEFAULTS = {"t1_r": 3.0, "t1_pct": 30.0, "t2_r": 6.0, "t2_pct": 20.0, "be_r": 3.0, "ema_len": 20, "default_on": True}


def r4(x: float) -> float:
    return math.floor(x * 1e4 + 0.5 + 1e-9) / 1e4


def ema_series(closes: list[float], n: int) -> list[float | None]:
    out: list[float | None] = [None] * len(closes)
    n = int(n)
    if n < 1 or len(closes) < n:
        return out
    k = 2 / (n + 1)
    e = sum(closes[:n]) / n
    out[n - 1] = e
    for i in range(n, len(closes)):
        e = closes[i] * k + e * (1 - k)
        out[i] = e
    return out


def share_amount(x: float, india: bool) -> float:
    """Whole shares for India (nearest), fractional (4 decimals) for the US."""
    return float(math.floor(x + 0.5 + 1e-9)) if india else r4(x)


def playbook_run(bars: list[tuple], entry_date: str, entry_px: float, qty: float, cost_px: float, stop: float,
                 cfg: dict, india: bool, stop_first: bool = True) -> dict | None:
    """`bars` = ascending [(date, o, h, l, c)] INCLUDING history before the entry (it warms up the EMA).
    Returns {"events": [{"reason", "date", "qty", "price"}], "state": {...}} or None if the setup is invalid."""
    R = entry_px - stop
    if not (R > 0 and qty > 0):
        return None
    targets = [("t1", entry_px + cfg["t1_r"] * R, cfg["t1_pct"]), ("t2", entry_px + cfg["t2_r"] * R, cfg["t2_pct"])]
    be_level = entry_px + cfg["be_r"] * R
    ema = ema_series([b[4] for b in bars], cfg["ema_len"])
    rem, cur_stop, done = float(qty), float(stop), set()
    be, exit_next, events = False, False, []

    def sell(date, q, px, reason):
        nonlocal rem
        q = min(q, rem)
        if q > 1e-9:
            events.append({"reason": reason, "date": date, "qty": r4(q), "price": r4(px)})
            rem -= q

    for i, (d, o, h, l, c) in enumerate(bars):
        if d <= entry_date:
            continue
        if rem <= 1e-9:
            break
        if exit_next:
            sell(d, rem, o, "ema")
            break

        def hit_stop():
            nonlocal rem
            px = o if o <= cur_stop else (cur_stop if l <= cur_stop else None)
            if px is not None:
                sell(d, rem, px, "stop")
                return True
            return False

        def hit_targets():
            for name, lvl, pct in targets:
                if name not in done and h >= lvl and rem > 1e-9:
                    done.add(name)
                    sell(d, share_amount(qty * pct / 100, india), max(o, lvl), name)

        if stop_first:
            if hit_stop():
                break
            hit_targets()
        else:
            hit_targets()
            if rem > 1e-9 and hit_stop():
                break
        if rem <= 1e-9:
            break
        if not be and h >= be_level:
            be, cur_stop = True, max(cur_stop, cost_px)
        if be and ema[i] is not None and c < ema[i]:
            exit_next = True
    last_ema = next((e for e in reversed(ema) if e is not None), None)
    state = {"R": r4(R), "stop": r4(cur_stop), "remaining": r4(rem), "be": be, "exit_next": exit_next,
             "ema": None if last_ema is None else r4(last_ema), "finished": rem <= 1e-9,
             "targets": [{"reason": n, "price": r4(p)} for n, p, _ in targets if n not in done]}
    return {"events": events, "state": state}
