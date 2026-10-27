// Run:  node paper/test_core.js     (no packages needed)
const assert = require("assert");
const path = require("path");
const fs = require("fs");
const C = require(path.join(__dirname, "..", "docs", "paper-core.js"));
const S = C.mergeSettings({});
let n = 0;
const test = (name, fn) => { fn(); n++; console.log("ok   " + name); };
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test("fee parity with the Python engine on 150 random cases", () => {
  const v = JSON.parse(fs.readFileSync(path.join(__dirname, "vectors.json"), "utf8"));
  for (const c of v.cases) assert.deepStrictEqual(C.tradeFees(c.portfolio, c.side, c.qty, c.price, v.settings, c.dp, c.date || undefined), c.fees, JSON.stringify(c));
});

test("Dhan top-up screen: Rs 1,00,000 at 95.71 gives $1,042.95 (GST Rs 179, no pay-in fee)", () => {
  const r = C.fundCalc({ inr: 100000, rate: 95.71, settings: S });
  assert.strictEqual(r.gst, 179); assert.strictEqual(r.payin_fee_usd, 0); assert.strictEqual(r.net_usd, 1042.95);
  close(r.effective_rate, 95.88, 0.006);
});

test("pay-in fee is zero by default (from Oct 2026); a configured fee applies below the free limit; overrides win", () => {
  assert.strictEqual(C.fundCalc({ inr: 5000, rate: 96.12, settings: S }).payin_fee_usd, 0);
  const S1 = JSON.parse(JSON.stringify(S)); S1.fx.payin_fee_usd = 1;
  const r = C.fundCalc({ inr: 5000, rate: 96.12, settings: S1 });
  assert.strictEqual(r.gst, 8.95); assert.strictEqual(r.gross_usd, 51.93); assert.strictEqual(r.payin_fee_usd, 1); assert.strictEqual(r.net_usd, 50.93);
  const o = C.fundCalc({ inr: 5000, rate: 96.12, gst: 10, bank: 25, payin: 0, settings: S });
  assert.strictEqual(o.gross_usd, r2((5000 - 10 - 25) / 96.12)); assert.strictEqual(o.net_usd, o.gross_usd);
});
function r2(x) { return C.r2(x); }

test("TCS applies only to the part of this transfer above Rs 10 lakh in the financial year", () => {
  const s = C.mergeSettings({ fx: { tcs_enabled: true } });
  assert.strictEqual(C.fundCalc({ inr: 100000, rate: 95, settings: s, applyTcs: true, fyRemittedBefore: 0 }).tcs, 0);
  assert.strictEqual(C.fundCalc({ inr: 100000, rate: 95, settings: s, applyTcs: true, fyRemittedBefore: 950000 }).tcs, 10000);   // 50k over x 20%
  const all = C.fundCalc({ inr: 100000, rate: 95, settings: s, applyTcs: true, fyRemittedBefore: 1200000 });
  assert.strictEqual(all.tcs, 20000); assert.strictEqual(all.total_inr_out, 120000);
  assert.strictEqual(C.fyOf("2026-03-31"), 2025); assert.strictEqual(C.fyOf("2026-04-01"), 2026);
});

test("rejects nonsense input", () => {
  assert.strictEqual(C.fundCalc({ inr: 0, rate: 95, settings: S }).ok, false);
  assert.strictEqual(C.fundCalc({ inr: 50, rate: 95, gst: 10, bank: 50, settings: S }).ok, false);
});

// ---------------------------------------------------------------- account ----
const fee = (pf, side, q, p, dp) => C.tradeFees(pf, side, q, p, S, dp);
const fill = (id, side, q, p, date, extra = {}) => ({ id, portfolio: "IN", symbol: "ABC", yf: "ABC.NS", side, qty: q, price: p, date,
  fees: fee("IN", side, q, p, true), fees_total: fee("IN", side, q, p, true).total, created_at: date + "T0" + id, ...extra });

test("cash, positions, FIFO P&L and R-multiple from records", () => {
  const ledger = [{ kind: "deposit", date: "2026-10-01", amount: 100000 }];
  const fills = [fill("1", "BUY", 100, 500, "2026-10-02", { stop_ref: 480, tag: "breakout" }),
                 fill("2", "BUY", 100, 520, "2026-10-05", { stop_ref: 500, tag: "breakout" }),
                 fill("3", "SELL", 150, 560, "2026-10-08")];
  const prices = { "ABC.NS": [{ date: "2026-10-08", close: 560 }, { date: "2026-10-09", close: 570 }], "^NSEI": [{ date: "2026-10-01", close: 100 }, { date: "2026-10-09", close: 102 }] };
  const a = C.buildAccount(ledger, fills, prices, "^NSEI");
  const f = fills.map(x => x.fees_total);
  const expectedCash = 100000 - (50000 + f[0]) - (52000 + f[1]) + (84000 - f[2]);
  close(a.cash, expectedCash, 0.005);
  assert.strictEqual(a.positions.length, 1); assert.strictEqual(a.positions[0].qty, 50);
  close(a.positions[0].value, 50 * 570);
  // sold 100 @ lot1 (500 + fee) and 50 @ lot2
  const t = a.trades[0];
  assert.strictEqual(t.qty, 150);
  const cost = 100 * (500 + f[0] / 100) + 50 * (520 + f[1] / 100), proceeds = 150 * 560 - f[2];
  close(t.pnl, proceeds - cost, 1e-6);
  close(t.r, (proceeds - cost) / (100 * 20 + 50 * 20), 1e-9);               // risk = (entry - stop) per share
  close(a.equity, a.cash + 50 * 570, 1e-6); close(a.pnl, a.equity - 100000, 1e-6);
  assert.strictEqual(a.stats.n, 1); assert.strictEqual(a.stats.winRate, 100);
  close(a.benchPct, 2); assert.ok(a.curve.length >= 5);
});

test("deposits do not count as profit in the deposit-adjusted return", () => {
  const ledger = [{ kind: "deposit", date: "2026-10-01", amount: 1000 }, { kind: "deposit", date: "2026-10-05", amount: 1000 }];
  const prices = { "^NSEI": [{ date: "2026-10-01", close: 1 }, { date: "2026-10-09", close: 1 }] };
  const a = C.buildAccount(ledger, [], prices, "^NSEI");
  assert.strictEqual(a.equity, 2000); assert.strictEqual(a.pnl, 0); close(a.twrPct, 0);
});

test("selling more than held is flagged instead of silently accepted", () => {
  const a = C.buildAccount([{ kind: "deposit", date: "2026-10-01", amount: 1000 }], [fill("1", "BUY", 1, 100, "2026-10-02"), fill("2", "SELL", 3, 100, "2026-10-03")], {}, "^NSEI");
  assert.ok(a.issues.length === 1 && /more ABC than held/.test(a.issues[0]));
});

test("an edited fill flows through to every total", () => {
  const ledger = [{ kind: "deposit", date: "2026-10-01", amount: 100000 }];
  const mk = price => [fill("1", "BUY", 10, price, "2026-10-02"), fill("2", "SELL", 10, 110, "2026-10-03")];
  const a = C.buildAccount(ledger, mk(100), {}, "^NSEI"), b = C.buildAccount(ledger, mk(105), {}, "^NSEI");
  assert.ok(a.realized > b.realized); close(a.realized - b.realized, 50, 1);                // 10 shares x Rs 5 (fees move slightly)
});

test("insights: flags missing stops and a losing profit factor", () => {
  const ledger = [{ kind: "deposit", date: "2026-10-01", amount: 100000 }];
  const fills = [fill("1", "BUY", 10, 100, "2026-10-02"), fill("2", "SELL", 10, 90, "2026-10-03"), fill("3", "BUY", 10, 100, "2026-10-04"),
                 fill("4", "SELL", 10, 95, "2026-10-05"), fill("5", "BUY", 10, 100, "2026-10-06"), fill("6", "SELL", 10, 99, "2026-10-07"),
                 fill("7", "BUY", 5, 100, "2026-10-08", { symbol: "XYZ", yf: "XYZ.NS" })];
  const a = C.buildAccount(ledger, fills, {}, "^NSEI");
  const text = C.insights(a, { currency: "₹", stopSymbols: new Set(), benchName: "Nifty 50" }).map(i => i.text).join("\n");
  assert.ok(/profit factor/.test(text)); assert.ok(/No pending stop order for: XYZ/.test(text));
});

console.log(`\n${n} tests passed`);

test("playbook matches the Python implementation on 120 random price paths", () => {
  const cases = JSON.parse(fs.readFileSync(path.join(__dirname, "playbook_vectors.json"), "utf8"));
  for (const c of cases) {
    const got = C.playbookRun(c.bars, c.entry_date, c.entry_px, c.qty, c.cost_px, c.stop, c.cfg, c.india, c.stop_first);
    assert.deepStrictEqual(got, c.result);
  }
});

test("backtest replays the playbook on a closed buy and compares it with what was actually made", () => {
  const S0 = C.mergeSettings({ us: { brokerage_pct: 0, min_brokerage: 0, exch_pct: 0, gst_pct: 0, legacy_brokerage_pct: 0 } });
  const d = [], o = [], h = [], l = [], c = [];
  for (let i = 0; i < 30; i++) { d.push("2026-09-" + String(i + 1).padStart(2, "0")); o.push(100); h.push(101); l.push(99); c.push(100); }
  d.push("2026-10-01", "2026-10-02"); o.push(105, 126); h.push(131, 127); l.push(104, 99); c.push(128, 101);       // 3R hit, then back to cost
  const fills = [
    { id: "b", portfolio: "US", symbol: "ABC", yf: "ABC", side: "BUY", qty: 10, price: 100, date: "2026-09-30", fees_total: 0, stop_ref: 90 },
    { id: "s", portfolio: "US", symbol: "ABC", yf: "ABC", side: "SELL", qty: 10, price: 104, date: "2026-10-02", fees_total: 0 }];
  const cfg = { t1_r: 3, t1_pct: 30, t2_r: 6, t2_pct: 20, be_r: 3, ema_len: 20 };
  const bt = C.playbookBacktest(fills, { ABC: { d, o, h, l, c } }, S0, [{ cfg }, { cfg: { ...cfg, t1_pct: 0, t2_pct: 0 } }]);
  assert.strictEqual(bt.rows.length, 1);
  assert.strictEqual(r2(bt.actual), 40); assert.strictEqual(r2(bt.totals[0]), 90); assert.strictEqual(r2(bt.totals[1]), 0);
  assert.strictEqual(C.playbookBacktest(fills.slice(0, 1), { ABC: { d, o, h, l, c } }, S0, [{ cfg }]).rows.length, 0);     // still open: not compared
});
