// Market-making research recordings: public top of book for the full scan's quoting cohort; no orders.
import { fetchMarkets, fetchTrades } from './kalshi.js';

export const bookRow = (m, fees, time) => ({ ticker: m.ticker, time, yesBid: Number(m.yes_bid_dollars), yesAsk: Number(m.yes_ask_dollars),
  yesBidSize: Number(m.yes_bid_size_fp), yesAskSize: Number(m.yes_ask_size_fp), volume_24h: Number(m.volume_24h_fp),
  close_time: m.close_time, expected_expiration_time: m.expected_expiration_time ?? null, fee_type: fees.fee_type, fee_multiplier: fees.fee_multiplier ?? 1 });

export const tradeRow = t => ({ ticker: t.ticker, tradeId: t.trade_id, time: Date.parse(t.created_time), price: Number(t.yes_price_dollars),
  count: Number(t.count_fp), takerSide: t.taker_side });

// New public trades since the cursor, from one poll of the exchange-wide tape (about 19 pages a minute on 2026-11-12), so the cohort can be any size.
// Ids from the cursor's second are kept because min_ts is whole seconds. One cursor for the tape; prints outside the cohort are dropped. A poll that hits maxPages has lost its oldest prints and says so.
export async function recordTape(cursor, tickers, load = fetchTrades, maxPages = 100) {
  const raw = await load(null, cursor.time, undefined, maxPages);
  const fresh = raw.map(tradeRow).filter(t => Number.isFinite(t.time) && Number.isFinite(t.price) && t.time >= cursor.time && !cursor.ids.has(t.tradeId));
  if (!fresh.length) return { rows: [], cursor, truncated: false };
  const time = Math.max(...fresh.map(t => t.time)), second = Math.floor(time / 1000) * 1000;
  const carried = Math.floor(cursor.time / 1000) * 1000 === second ? [...cursor.ids] : [];
  return { rows: fresh.filter(t => tickers.has(t.ticker)).sort((a, b) => a.time - b.time), truncated: raw.length >= maxPages * 1000,
    cursor: { time, ids: new Set([...carried, ...fresh.filter(t => t.time >= second).map(t => t.tradeId)]) } };
}

// A missing or inactive market is left out, so the simulator sees a gap rather than a stale price.
export async function recordBooks(cohort, time, load = fetchMarkets) {
  const fees = new Map(cohort.map(c => [c.ticker, c]));
  const markets = await load([...fees.keys()]);
  return markets.filter(m => m?.status === 'active' && fees.has(m.ticker)).map(m => bookRow(m, fees.get(m.ticker), time));
}
