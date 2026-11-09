// Market-making research recordings: public top of book for the full scan's quoting cohort; no orders.
import { fetchMarkets, fetchTrades } from './kalshi.js';

export const bookRow = (m, fees, time) => ({ ticker: m.ticker, time, yesBid: Number(m.yes_bid_dollars), yesAsk: Number(m.yes_ask_dollars),
  yesBidSize: Number(m.yes_bid_size_fp), yesAskSize: Number(m.yes_ask_size_fp), volume_24h: Number(m.volume_24h_fp),
  close_time: m.close_time, expected_expiration_time: m.expected_expiration_time ?? null, fee_type: fees.fee_type, fee_multiplier: fees.fee_multiplier ?? 1 });

export const tradeRow = t => ({ ticker: t.ticker, tradeId: t.trade_id, time: Date.parse(t.created_time), price: Number(t.yes_price_dollars),
  count: Number(t.count_fp), takerSide: t.taker_side });

// New public trades per market since its cursor. Ids from the cursor's second are kept because min_ts is whole seconds.
// A market that fails keeps its cursor and is retried on the next poll.
export async function recordTrades(cursors, load = fetchTrades) {
  const rows = [], errors = [], next = new Map(cursors);
  for (const [ticker, c] of cursors) {
    try {
      const fresh = (await load(ticker, c.time)).map(tradeRow)
        .filter(t => t.ticker === ticker && Number.isFinite(t.time) && Number.isFinite(t.price) && t.time >= c.time && !c.ids.has(t.tradeId));
      if (!fresh.length) continue;
      rows.push(...fresh);
      const time = Math.max(...fresh.map(t => t.time)), second = Math.floor(time / 1000) * 1000;
      const carried = Math.floor(c.time / 1000) * 1000 === second ? [...c.ids] : [];
      next.set(ticker, { time, ids: new Set([...carried, ...fresh.filter(t => t.time >= second).map(t => t.tradeId)]) });
    } catch (error) { errors.push({ ticker, error: error.message }); }
  }
  return { rows: rows.sort((a, b) => a.time - b.time), cursors: next, errors };
}

// A missing or inactive market is left out, so the simulator sees a gap rather than a stale price.
export async function recordBooks(cohort, time, load = fetchMarkets) {
  const fees = new Map(cohort.map(c => [c.ticker, c]));
  const markets = await load([...fees.keys()]);
  return markets.filter(m => m?.status === 'active' && fees.has(m.ticker)).map(m => bookRow(m, fees.get(m.ticker), time));
}
