// Finds baskets that pay out in every outcome for less than their cost, after taker fees and at top-of-book depth.
// Research only: nothing here places orders.
import { fetchMarket as fetchKalshiMarket, fetchOpenEvents, kalshiFee, quote } from './kalshi.js';
import { fetchBook, fetchMarket as fetchPolymarketMarket } from './polymarket.js';
import { takerFeePerShare } from './fees.js';

const DAY_MS = 86400000;
const round = x => Math.round(x * 10000) / 10000;

// legs: [{ venue, ticker, side, price, size, fee(contracts) }]; payout is the guaranteed dollars per basket.
export function price(kind, title, legs, payout, { maxContracts = 100, now = Date.now() } = {}) {
  const contracts = Math.floor(Math.min(maxContracts, ...legs.map(leg => leg.size)));
  if (contracts < 1) return null;
  const cost = legs.reduce((sum, leg) => sum + leg.price * contracts + leg.fee(contracts), 0);
  const profit = payout * contracts - cost;
  const closesAt = Math.max(...legs.map(leg => leg.closesAt));
  const days = Math.max(1 / 24, (closesAt - now) / DAY_MS);
  return {
    id: `${kind}:${legs.map(leg => `${leg.venue}:${leg.ticker}:${leg.side}`).join('+')}`,
    kind, title, contracts, cost: round(cost), payout: payout * contracts, profit: round(profit),
    returnPct: round(profit / cost), annualized: round(profit / cost * 365 / days), closesAt,
    legs: legs.map(({ fee, ...leg }) => leg)
  };
}

function kalshiLeg(market, side, feeRate) {
  const ask = quote(market)[side];
  if (!ask || market.status !== 'active') return null;
  return { venue: 'kalshi', ticker: market.ticker, side, price: ask.price, size: ask.size,
    closesAt: Date.parse(market.close_time), fee: contracts => kalshiFee(contracts, ask.price, feeRate) };
}

// At most one outcome of a mutually exclusive event wins, so No on k outcomes pays at least k - 1.
// Buying Yes on every outcome is not safe: the outcomes need not be exhaustive.
// shortcut: uses every outcome with a No ask; dropping a thin leg can allow more contracts, add a subset search if hits are size-limited.
export function noBaskets(events, { feeRate = 0.07, ...options } = {}) {
  const found = [];
  for (const event of events) {
    if (event.mutually_exclusive !== true) continue;
    const legs = (event.markets ?? []).map(market => kalshiLeg(market, 'no', feeRate)).filter(Boolean);
    if (legs.length < 2) continue;
    const basket = price('no-basket', event.title, legs, legs.length - 1, options);
    if (basket) found.push({ ...basket, event: event.event_ticker });
  }
  return found;
}

// Strike ladders in one event share a settlement value S. For "greater" markets with X1 < X2,
// Yes(X1) pays when S > X1 and No(X2) pays when S <= X2, so the pair always pays at least 1. "less" mirrors it.
export function ladders(events, { feeRate = 0.07, ...options } = {}) {
  const found = [];
  const shapes = { greater: 'floor_strike', greater_or_equal: 'floor_strike', less: 'cap_strike', less_or_equal: 'cap_strike' };
  // One event can hold ladders on different underlyings (one per player, say). Rungs share an underlying
  // when their settlement rule reads the same once the numbers are removed and they close together
  // (the close time keeps "by 2025" and "by 2030" deadlines apart).
  const underlying = market => `${market.strike_type}|${market.close_time}|${String(market.rules_primary ?? '').replace(/[\d.,]+/g, '#')}`;
  for (const event of events) {
    const groups = new Map();
    for (const market of event.markets ?? []) {
      const field = shapes[market.strike_type];
      const other = field === 'floor_strike' ? 'cap_strike' : 'floor_strike';
      // Kalshi labels some "exactly N" buckets "less" with both bounds set; a one-sided strike has only one bound.
      if (!field || !Number.isFinite(market[field]) || market[other] != null) continue;
      const key = underlying(market);
      groups.set(key, [...(groups.get(key) ?? []), market]);
    }
    for (const group of groups.values()) {
      const type = group[0].strike_type;
      const field = shapes[type];
      const rungs = group.sort((a, b) => a[field] - b[field]);
      const above = type.startsWith('greater');
      for (let i = 0; i < rungs.length; i++) {
        for (let j = i + 1; j < rungs.length; j++) {
          if (rungs[i][field] === rungs[j][field]) continue;
          const yes = kalshiLeg(above ? rungs[i] : rungs[j], 'yes', feeRate);
          const no = kalshiLeg(above ? rungs[j] : rungs[i], 'no', feeRate);
          if (!yes || !no || yes.price + no.price >= 1) continue;
          const pair = price('ladder', event.title, [yes, no], 1, options);
          if (pair) found.push({ ...pair, event: event.event_ticker });
        }
      }
    }
  }
  return found;
}

function bestAsk(book) {
  const asks = (book?.asks ?? []).map(level => ({ price: Number(level.price), size: Number(level.size) }))
    .filter(level => level.price > 0 && level.price < 1 && level.size > 0);
  return asks.length ? asks.reduce((best, level) => level.price < best.price ? level : best) : null;
}

// pair: { kalshiTicker, polymarketMarketId, polymarketOutcome } where polymarketOutcome is the index of the
// Polymarket outcome that settles exactly like Kalshi Yes. Matching is manual: settlement rules must be read and agreed first.
export function crossVenue(pair, kalshiMarket, polymarketMarket, books, { feeRate = 0.07, ...options } = {}) {
  const tokens = typeof polymarketMarket.clobTokenIds === 'string' ? JSON.parse(polymarketMarket.clobTokenIds) : polymarketMarket.clobTokenIds;
  const closesAt = Date.parse(polymarketMarket.endDate);
  const polyLeg = index => {
    const ask = bestAsk(books[index]);
    if (!ask || polymarketMarket.acceptingOrders !== true) return null;
    const perShare = polymarketMarket.feesEnabled ? takerFeePerShare(ask.price, polymarketMarket.feeSchedule) : 0;
    return { venue: 'polymarket', ticker: `${pair.polymarketMarketId}#${tokens?.[index]}`, side: `outcome ${index}`,
      price: ask.price, size: ask.size, closesAt, fee: contracts => perShare * contracts };
  };
  const same = pair.polymarketOutcome;
  const found = [];
  for (const [side, index] of [['yes', 1 - same], ['no', same]]) {
    const legs = [kalshiLeg(kalshiMarket, side, feeRate), polyLeg(index)];
    if (legs.every(Boolean)) {
      const basket = price('cross-venue', kalshiMarket.title, legs, 1, options);
      if (basket) found.push(basket);
    }
  }
  return found;
}

export async function scanCrossVenue(pairs, options) {
  const found = [];
  const errors = [];
  for (const pair of pairs) {
    try {
      const [kalshiMarket, polymarketMarket] = await Promise.all([fetchKalshiMarket(pair.kalshiTicker), fetchPolymarketMarket(pair.polymarketMarketId)]);
      const tokens = typeof polymarketMarket.clobTokenIds === 'string' ? JSON.parse(polymarketMarket.clobTokenIds) : polymarketMarket.clobTokenIds;
      if (!Array.isArray(tokens) || tokens.length !== 2) throw new Error('Polymarket market is not binary');
      const books = await Promise.all(tokens.map(fetchBook));
      found.push(...crossVenue(pair, kalshiMarket, polymarketMarket, books, options));
    } catch (error) {
      errors.push({ pair: pair.kalshiTicker, error: error.message });
    }
  }
  return { found, errors };
}

export async function runScan(config, pairs = [], now = Date.now()) {
  const options = { feeRate: config.feeRate, maxContracts: config.maxContracts, now };
  const events = await fetchOpenEvents();
  const cross = await scanCrossVenue(pairs, options);
  const candidates = [...noBaskets(events, options), ...ladders(events, options), ...cross.found];
  return { scannedAt: now, events: events.length, markets: events.reduce((n, e) => n + (e.markets?.length ?? 0), 0),
    candidates, hits: candidates.filter(c => c.profit >= config.minProfit), errors: cross.errors };
}

// Keeps hits open across scans so each one's lifetime can be measured. Duration is a lower bound:
// the gap between the first and last scan that saw it.
export function track(state, hits, now) {
  const previous = state?.open ?? {};
  const open = {};
  for (const hit of hits) {
    const before = previous[hit.id];
    open[hit.id] = { ...hit, firstSeen: before?.firstSeen ?? now, lastSeen: now, scans: (before?.scans ?? 0) + 1,
      bestProfit: Math.max(before?.bestProfit ?? -Infinity, hit.profit) };
  }
  const closed = Object.values(previous).filter(hit => !open[hit.id])
    .map(hit => ({ ...hit, goneBy: now, minDurationMs: hit.lastSeen - hit.firstSeen }));
  return { state: { open }, closed };
}
