// Finds baskets that pay out in every outcome for less than their cost, after taker fees and at top-of-book depth.
// Research only: nothing here places orders.
import { fetchMarket as fetchKalshiMarket, fetchOpenEvents, fetchSeries, kalshiFee, quote } from './kalshi.js';
import { publicLookup } from './polymarket.js';
import { autoMatch } from './matching.js';
import { mapConcurrent } from './dryrun.js';
import { takerFeePerShare } from './fees.js';

const DAY_MS = 86400000;
const round = x => Math.round(x * 10000) / 10000;

// legs: [{ venue, ticker, side, price, size, fee(contracts) }]; payout is the guaranteed dollars per basket.
export function price(kind, title, legs, payout, { maxContracts = 100, now = Date.now(), slippageTicks = 1,
  event = {}, series = {}, verified = {}, maxDaysToClose = 60, longHold = {} } = {}) {
  const contracts = Math.floor(Math.min(maxContracts, ...legs.map(leg => leg.size)));
  if (contracts < 1) return null;
  const cost = legs.reduce((sum, leg) => {
    const p = Math.min(0.99, leg.price + (leg.maker ? 0 : slippageTicks * 0.01));
    return sum + p * contracts + leg.fee(contracts, p);
  }, 0);
  const profit = payout * contracts - cost;
  const closesAt = Math.max(...legs.map(leg => leg.closesAt));
  const expiresAt = Math.max(...legs.map(leg => leg.expiresAt ?? leg.closesAt));
  const days = Math.max(1 / 24, (expiresAt - now) / DAY_MS);
  const annualized = profit / cost * 365 / days;
  const extended = days > maxDaysToClose && days <= (longHold.maxDays ?? 400) &&
    profit / contracts >= (longHold.minProfitPerContract ?? 0.03) - 1e-9 && annualized >= (longHold.minAnnualized ?? 0.1) - 1e-9;
  const kalshi = legs.filter(l => l.venue === 'kalshi');
  const checks = [];
  if (!series[event.series_ticker]?.contract_url?.startsWith('https://assets.kalshi.com/regulatory/product-certifications/')) checks.push('kalshiCertified');
  if (!Array.isArray(event.settlement_sources) || !event.settlement_sources.length) checks.push('settlement');
  if (!kalshi.every(l => l.volume24h >= (verified.minLegVolume24h ?? 500))) checks.push('liquidity');
  if (!Number.isFinite(expiresAt) || expiresAt <= now || (days > maxDaysToClose && !extended)) checks.push('horizon');
  // A game in play keeps a far close_time; its expected expiration (or Polymarket end date) marks it as live.
  if (!legs.every(l => Math.min(l.closesAt, l.expiresAt ?? l.closesAt) - now > (verified.minHoursToClose ?? 2) * 3600000)) checks.push('notClosing');
  if (new Set(kalshi.map(l => l.closesAt)).size !== 1) checks.push('sameClose');
  if (legs.some(l => Number.isFinite(l.gameStartAt) && l.gameStartAt <= now)) checks.push('gameStarted');
  return {
    id: `${kind}:${legs.map(leg => `${leg.venue}:${leg.ticker}:${leg.side}`).join('+')}`,
    kind, title, event: event.event_ticker, series: event.series_ticker, verified: checks.length === 0, checks,
    reviewed: (verified.reviewedSeries ?? []).includes(event.series_ticker),
    contracts, cost: round(cost), payout: payout * contracts, profit: round(profit),
    returnPct: profit / cost, annualized: round(annualized), closesAt, expiresAt, longHold: extended,
    legs: legs.map(({ fee, ...leg }) => {
      const costPrice = Math.min(0.99, leg.price + (leg.maker ? 0 : slippageTicks * 0.01));
      return { ...leg, costPrice, ...(leg.venue === 'polymarket' ? { feePerShare: fee(1, costPrice) } : {}) };
    })
  };
}

function kalshiLeg(market, side, feeRate, series) {
  const ask = quote(market)[side];
  if (!ask || market.status !== 'active') return null;
  const rate = feeRate * (series?.fee_multiplier ?? 1);
  return { venue: 'kalshi', ticker: market.ticker, side, price: ask.price, size: ask.size,
    volume24h: Number(market.volume_24h_fp), feeRate: rate, bid: Number(market[`${side}_bid_dollars`] ?? NaN),
    closesAt: Date.parse(market.close_time), expiresAt: Date.parse(market.expected_expiration_time || market.close_time),
    fee: (contracts, p = ask.price) => kalshiFee(contracts, p, rate) };
}

// A resting bid only fills near fair value: on a wide spread, a bid one tick above an empty book fills only after
// the outcome has turned against it. So the maker leg must sit on a spread of at most makerMaxSpread.
function makerVariant(kind, event, legs, payout, options) {
  const maxSpread = options.makerMaxSpread ?? 0.04;
  const eligible = legs.filter(l => Number.isFinite(l.bid) && l.bid > 0 && l.bid + 0.01 < l.price - 1e-9 &&
    l.price - l.bid <= maxSpread + 1e-9);
  const leg = eligible.sort((a, b) => (b.price - b.bid) - (a.price - a.bid))[0];
  if (!leg) return null;
  const series = options.series?.[event.series_ticker];
  const feeRate = series?.fee_type === 'quadratic' ? 0 : (options.makerFeeRate ?? 0.0175) * (series?.fee_multiplier ?? 1);
  const p = round(leg.bid + 0.01);
  const maker = { ...leg, maker: true, price: p, feeRate, fee: n => kalshiFee(n, p, feeRate) };
  const basket = price(`maker-${kind}`, event.title, legs.map(l => l === leg ? maker : l), payout, { ...options, event });
  return basket && { ...basket, makerLeg: leg.ticker };
}

// At most one outcome of a mutually exclusive event wins, so No on k outcomes pays at least k - 1.
// Buying Yes on every outcome is not safe: the outcomes need not be exhaustive.
// shortcut: uses every outcome with a No ask; dropping a thin leg can allow more contracts, add a subset search if hits are size-limited.
export function noBaskets(events, { feeRate = 0.07, ...options } = {}) {
  const found = [];
  for (const event of events) {
    if (event.mutually_exclusive !== true) continue;
    const legs = (event.markets ?? []).map(market => kalshiLeg(market, 'no', feeRate, options.series?.[event.series_ticker])).filter(Boolean);
    if (legs.length < 2) continue;
    const basket = price('no-basket', event.title, legs, legs.length - 1, { ...options, event });
    if (basket) found.push({ ...basket, event: event.event_ticker });
    const maker = makerVariant('no-basket', event, legs, legs.length - 1, options);
    if (maker) found.push(maker);
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
          const yes = kalshiLeg(above ? rungs[i] : rungs[j], 'yes', feeRate, options.series?.[event.series_ticker]);
          const no = kalshiLeg(above ? rungs[j] : rungs[i], 'no', feeRate, options.series?.[event.series_ticker]);
          if (!yes || !no) continue;
          const pair = price('ladder', event.title, [yes, no], 1, { ...options, event });
          if (pair && yes.price + no.price < 1) found.push({ ...pair, event: event.event_ticker });
          // Posting one leg saves at most its spread, so pairs priced further above $1 cannot become a basket.
          if (yes.price + no.price >= 1 + (options.makerMaxSpread ?? 0.04)) continue;
          const maker = makerVariant('ladder', event, [yes, no], 1, options);
          if (maker) found.push(maker);
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
    return { venue: 'polymarket', ticker: `${pair.polymarketMarketId}#${tokens?.[index]}`, side: `outcome ${index}`,
      price: ask.price, size: ask.size, closesAt, gameStartAt: Date.parse(polymarketMarket.gameStartTime), fee: (contracts, p = ask.price) => contracts * (polymarketMarket.feesEnabled ? takerFeePerShare(p, polymarketMarket.feeSchedule) : 0) };
  };
  const same = pair.polymarketOutcome;
  const found = [];
  for (const [side, index] of [['yes', 1 - same], ['no', same]]) {
    const legs = [kalshiLeg(kalshiMarket, side, feeRate, options.series?.[options.event?.series_ticker]), polyLeg(index)];
    if (legs.every(Boolean)) {
      const basket = price('cross-venue', kalshiMarket.title, legs, 1, options);
      if (basket) found.push({ ...basket, autoMatched: pair.autoMatched === true,
        reviewed: pair.autoMatched ? false : basket.reviewed });
    }
  }
  return found;
}

export async function scanCrossVenue(pairs, options) {
  const found = [];
  const errors = [];
  await mapConcurrent(pairs, 8, async pair => {
    try {
      const lookup = options.lookup;
      const [kalshiMarket, polymarketMarket] = await Promise.all([pair.kalshiMarket ?? fetchKalshiMarket(pair.kalshiTicker), pair.polymarketMarket ?? lookup.market(pair.polymarketMarketId)]);
      const tokens = typeof polymarketMarket.clobTokenIds === 'string' ? JSON.parse(polymarketMarket.clobTokenIds) : polymarketMarket.clobTokenIds;
      if (!Array.isArray(tokens) || tokens.length !== 2) throw new Error('Polymarket market is not binary');
      const bookResults = await Promise.allSettled(tokens.map(token => lookup.book(token)));
      const failed = bookResults.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
      const books = bookResults.map(result => result.value);
      const event = pair.event ?? options.events?.find(e => e.event_ticker === kalshiMarket.event_ticker);
      if (!event) return;
      found.push(...crossVenue(pair, kalshiMarket, polymarketMarket, books, { ...options, event }));
    } catch (error) {
      errors.push({ pair: pair.kalshiTicker, error: error.message });
    }
  });
  return { found, errors };
}

export async function runScan(config, pairs = [], now = Date.now()) {
  // seriesTickers narrows a scan to named series (a game-day loop), avoiding the ~3-minute full listing.
  const fetchEvents = config.seriesTickers?.length ?
    Promise.all(config.seriesTickers.map(seriesTicker => fetchOpenEvents({ seriesTicker }))).then(lists => lists.flat()) : fetchOpenEvents();
  const [allEvents, seriesList] = await Promise.all([fetchEvents, fetchSeries()]);
  const series = Object.fromEntries(seriesList.map(s => [s.ticker, s]));
  const events = allEvents.filter(e => inFocus(e, series, config.focus));
  const lookup = publicLookup();
  const options = { ...config, now, events, series, lookup };
  const minVolume = config.verified?.minLegVolume24h ?? 500;
  const auto = await autoMatch(events.filter(e => e.markets?.some(m => Number(m.volume_24h_fp) >= minVolume)), lookup);
  const reviewedTickers = new Set(pairs.map(p => p.kalshiTicker));
  const cross = await scanCrossVenue([...pairs, ...auto.pairs.filter(p => !reviewedTickers.has(p.kalshiTicker) &&
    Number(p.kalshiMarket.volume_24h_fp) >= minVolume)], options);
  const candidates = [...noBaskets(events, options), ...ladders(events, options), ...cross.found].filter(c => !c.checks.includes('horizon'));
  const hits = candidates.filter(c => isHit(c, config));
  return { scannedAt: now, events: events.length, markets: events.reduce((n, e) => n + (e.markets?.length ?? 0), 0),
    candidates, hits, books: quotingCandidates(events, series, config, now), nearMissSummary: nearMissSummary(candidates.filter(c => !hits.includes(c))), errors: [...auto.errors, ...cross.errors] };
}

export function quotingCandidates(events, series, config, now = Date.now()) {
  // shortcut: eligibility is sampled anew each scan, retain a fixed cohort through close when measuring selection bias and off-focus moves.
  const cap = config.mm?.maxMarkets ?? 50;
  if (!Number.isInteger(cap) || cap < 0) throw new Error('Invalid MM market cap');
  const books = [];
  for (const event of events) {
    const s = series[event.series_ticker];
    if (!inFocus(event, series, config.focus) || !s?.contract_url?.startsWith('https://assets.kalshi.com/regulatory/product-certifications/') || !event.settlement_sources?.length) continue;
    for (const m of event.markets ?? []) {
      const bid = Number(m.yes_bid_dollars), ask = Number(m.yes_ask_dollars), spread = ask - bid;
      const close = Date.parse(m.close_time), expiry = Date.parse(m.expected_expiration_time || m.close_time);
      if (m.status !== 'active' || !(bid > 0 && ask < 1) || spread < 0.02 - 1e-9 || spread > 0.06 + 1e-9 ||
          Number(m.volume_24h_fp) < 500 || !Number.isFinite(Number(m.volume_24h_fp)) || !(Number(m.yes_bid_size_fp) > 0 && Number(m.yes_ask_size_fp) > 0) ||
          !(Math.min(close, expiry) - now > 2 * 3600000)) continue;
      books.push({ ticker: m.ticker, time: now, yesBid: bid, yesAsk: ask, yesBidSize: Number(m.yes_bid_size_fp), yesAskSize: Number(m.yes_ask_size_fp),
        volume_24h: Number(m.volume_24h_fp), close_time: m.close_time, fee_type: s.fee_type, fee_multiplier: s.fee_multiplier ?? 1 });
    }
  }
  return books.sort((a, b) => b.volume_24h - a.volume_24h || a.ticker.localeCompare(b.ticker)).slice(0, cap);
}

export function nearMissSummary(candidates) {
  const buckets = { '<-2c': 0, '-2..0c': 0, '0..1c': 0, '1..2c': 0, '>=2c': 0 };
  for (const c of candidates) {
    const p = c.profit / c.contracts;
    if (!Number.isFinite(p)) continue;
    buckets[p < -0.02 ? '<-2c' : p < 0 ? '-2..0c' : p < 0.01 ? '0..1c' : p < 0.02 ? '1..2c' : '>=2c']++;
  }
  return buckets;
}

export function inFocus(event, series, focus = {}) {
  const s = series[event.series_ticker];
  return (focus.seriesPrefixes ?? []).some(prefix => event.series_ticker?.startsWith(prefix)) ||
    (s?.tags ?? []).some(tag => (focus.sportTags ?? []).includes(tag)) || (focus.categories ?? []).includes(s?.category);
}

export function isHit(candidate, { minProfit = 1, minReturn = 0.03 } = {}) {
  return candidate.verified === true && candidate.profit >= minProfit && candidate.returnPct >= minReturn;
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
