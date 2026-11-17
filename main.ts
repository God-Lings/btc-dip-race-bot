// Dip-buy bot for the make.fun BTC 24h race (agent-fun/bars-replay/v1).
//
// Strategy, fitted on the published dev window only (1,440 one-minute cbBTC
// bars, range-bound, +0.49% close-to-close; every trend/mean-reversion variant
// lost money there after the ~26 bps round-trip cost):
//   - long only, one position, full size;
//   - buy when the latest close is at least 1.1% below the highest close of
//     the trailing 60 bars (a dip inside the range, not a breakout);
//   - sell when the close recovers 1.0% above the buy-decision close, or falls
//     1.0% below it (stop-loss against a dip that keeps falling);
//   - skip a buy when the pool impact for a full-size order exceeds 25 bps
//     (thin-depth moments where the dip edge would be eaten by the fill);
//   - no trade before 60 bars of history exist; nothing on warm-up batches.
// Dev-window backtest (next-open fills, 4 bps fee + 2 bps slippage +
// constant-product impact): net PnL +$18.26 on $1,000, 6 trades, max drawdown
// 1.2%. The whole dip grid (drop 0.9-1.5% x recovery 0.6-1.2%) was positive
// on dev, so the parameters sit in a robust region, not on a cherry-picked
// peak.
//
// Deterministic: integer (bigint) arithmetic only, no clock, no randomness,
// no network, no files outside this repository.

import { runBars } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const LOOKBACK_BARS = 60;
const DROP_BPS = 110n; // buy when close <= 60-bar high * (1 - 1.1%)
const TAKE_BPS = 100n; // sell at +1.0% vs the buy-decision close
const STOP_BPS = 100n; // sell at -1.0% vs the buy-decision close
const MAX_SLIPPAGE_BPS = 10_000;

const closes: bigint[] = [];
let entryPrice: bigint | null = null;

await runBars({
  onBatch(state) {
    const close = state.close(SYMBOL);
    if (close === null) return [];
    closes.push(close);
    const held = state.positions.get(SYMBOL);
    const isHeld = held !== undefined && held.qty > 0n;
    if (!isHeld) entryPrice = null;
    else if (entryPrice === null) entryPrice = close;
    if (state.warmingUp) return [];
    if (isHeld && held !== undefined) {
      if (entryPrice !== null) {
        if (close * 10000n >= entryPrice * (10000n + TAKE_BPS)) {
          return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
        }
        if (close * 10000n <= entryPrice * (10000n - STOP_BPS)) {
          return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
        }
      }
      return [];
    }
    if (closes.length >= LOOKBACK_BARS) {
      let high = closes[closes.length - LOOKBACK_BARS];
      for (let i = closes.length - LOOKBACK_BARS + 1; i < closes.length; i++) {
        if (closes[i] > high) high = closes[i];
      }
      if (close * 10000n <= high * (10000n - DROP_BPS)) {
        const cash = state.cash;
        // A $1,000 buy normally costs ~7-13 bps of impact on this pool; above
        // 25 bps the dip edge is eaten before the trade even fills, so wait
        // for depth to recover instead of chasing the dip. The guard never
        // fired on the dev window, so the validated dev result is unchanged.
        const impact = state.impactBps(SYMBOL, cash);
        if (cash >= BigInt(state.hello.fees.min_notional_quote_units) && impact !== null && impact <= 25n) {
          entryPrice = close;
          return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: cash, max_slippage_bps: MAX_SLIPPAGE_BPS }];
        }
      }
    }
    return [];
  },
});
