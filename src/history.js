// Converts settled-market history into the simulator's live recording format. Read-only research data; no orders.
export const HEARTBEAT_MS = 15 * 60000;

// One book row per minute candle whose closing bid or ask changed, plus a heartbeat so cutoffs and markouts see time pass.
// shortcut: candles carry no depth, so sizes are a nominal 1 contract; matches the sim's one-contract quotes, replace before sizing up.
export function candleRows(candles, market, fees = {}) {
  const rows = [];
  let last = null;
  for (const c of candles) {
    const yesBid = Number(c.yes_bid?.close_dollars), yesAsk = Number(c.yes_ask?.close_dollars), time = c.end_period_ts * 1000;
    if (!(yesBid > 0 && yesAsk < 1 && yesBid < yesAsk) || !Number.isFinite(time)) continue;
    if (last && last.yesBid === yesBid && last.yesAsk === yesAsk && time - last.time < HEARTBEAT_MS) continue;
    last = { ticker: market.ticker, time, yesBid, yesAsk, yesBidSize: 1, yesAskSize: 1, volume_24h: null, close_time: market.close_time,
      expected_expiration_time: market.expected_expiration_time ?? null, fee_type: fees.fee_type ?? null, fee_multiplier: fees.fee_multiplier ?? 1 };
    rows.push(last);
  }
  return rows;
}

// Last moment the sim may quote a market under the mm pull rules (close backstop or expected game end).
export function quoteEnd(market, { pullMinutes = 60, pullBeforeExpiryMinutes = null } = {}) {
  const close = Date.parse(market.close_time) - pullMinutes * 60000, expiry = Date.parse(market.expected_expiration_time);
  return pullBeforeExpiryMinutes !== null && Number.isFinite(expiry) ? Math.min(close, expiry - pullBeforeExpiryMinutes * 60000) : close;
}

// Quoting one tick inside needs a spread of at least 3 ticks somewhere before the pull time, inside the mid band.
// Markets that never offer it cannot fill in the sim, so their (often huge) trade tapes are not worth fetching.
export const quotable = (rows, end, { minMid = 0, maxMid = 1 } = {}) => rows.some(r => r.time < end && r.yesAsk - r.yesBid >= 0.03 - 1e-9 &&
  (r.yesBid + r.yesAsk) / 2 >= minMid - 1e-9 && (r.yesBid + r.yesAsk) / 2 <= maxMid + 1e-9);

// Binary outcome as the sim's $1/$0 settlement value; scalar or voided markets have none.
export const settlementValue = m => m.result === 'yes' ? 1 : m.result === 'no' ? 0 : null;

export const seriesOf = m => m.event_ticker?.split('-')[0];
