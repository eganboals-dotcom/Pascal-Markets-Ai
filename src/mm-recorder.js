// Market-making research recordings: public top of book for the full scan's quoting cohort; no orders.
import { fetchMarkets } from './kalshi.js';

export const bookRow = (m, fees, time) => ({ ticker: m.ticker, time, yesBid: Number(m.yes_bid_dollars), yesAsk: Number(m.yes_ask_dollars),
  yesBidSize: Number(m.yes_bid_size_fp), yesAskSize: Number(m.yes_ask_size_fp), volume_24h: Number(m.volume_24h_fp),
  close_time: m.close_time, fee_type: fees.fee_type, fee_multiplier: fees.fee_multiplier ?? 1 });

// A missing or inactive market is left out, so the simulator sees a gap rather than a stale price.
export async function recordBooks(cohort, time, load = fetchMarkets) {
  const fees = new Map(cohort.map(c => [c.ticker, c]));
  const markets = await load([...fees.keys()]);
  return markets.filter(m => m?.status === 'active' && fees.has(m.ticker)).map(m => bookRow(m, fees.get(m.ticker), time));
}
