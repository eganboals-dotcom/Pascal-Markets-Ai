import { kalshiFee } from './kalshi.js';

const minute = 60000;
const cents = x => Math.round(x * 100) / 100;
const metrics = () => ({ fills: 0, spreadCaptured: 0, fees: 0, adverseSelectionLoss: 0, markedFills: 0, unmarkedFills: 0, grossPnl: 0, netPnl: 0, staleIntervals: 0, tradeFills: 0, clv: 0, availableContracts: 0 });

// Quote size: a filled quote gets the smaller of its size and the contracts that traded through it (at least the one that filled),
// held to settlement, with the fee charged on the whole order. Returns contracts, stake, closing-line value and settled P&L (null unsettled).
// shortcut: first in line for every traded contract, inventory cap scaled with size; an upper bound until real fills measure the queue.
export function sizedFill(fill, size, outcome) {
  if (!Number.isInteger(size) || size < 1) throw new Error('Quote size must be a whole number of contracts');
  const n = Math.max(1, Math.min(size, Math.floor(fill.available))), dir = fill.side === 'buy' ? 1 : -1, fee = kalshiFee(n, fill.price, fill.feeRate);
  return { contracts: n, stake: n * (dir > 0 ? fill.price : 1 - fill.price), clv: n * (fill.clv + fill.fee) - fee,
    settled: outcome === 0 || outcome === 1 ? n * dir * (outcome - fill.price) - fee : null };
}

// The paper test's cash cap for quoting: fills in time order at `size`, each cut to what `budget` (dollars) leaves room for, and
// skipped when not one contract fits. A fill's cash is freed settleMs after its market's expected expiration (expiresAt).
// shortcut: a buy and a sell in one market are not netted, so the cash held is overstated; fine while mm.maxInventory caps a market.
export function budgetedFills(fills, size, budget, outcomes = {}, { now = Date.now(), settleMs = 3600000 } = {}) {
  const open = [], t = { taken: 0, skipped: 0, contracts: 0, settledFills: 0, settledPnl: 0, held: 0 };
  let held = 0;
  for (const f of [...fills].sort((a, b) => a.time - b.time)) {
    for (let i = open.length - 1; i >= 0; i--) if (open[i].at <= f.time) { held -= open[i].cash; open.splice(i, 1); }
    let r = sizedFill(f, size, outcomes[f.ticker]);
    if (held + r.stake > budget + 1e-9) {
      const fits = Math.floor((budget - held) / (r.stake / r.contracts) + 1e-9);
      if (fits < 1) { t.skipped++; continue; }
      r = sizedFill(f, fits, outcomes[f.ticker]);
    }
    open.push({ at: Number.isFinite(f.expiresAt) ? f.expiresAt + settleMs : Infinity, cash: r.stake }); held += r.stake;
    t.taken++; t.contracts += r.contracts;
    if (r.settled !== null) { t.settledFills++; t.settledPnl += r.settled; }
  }
  t.held = open.filter(o => o.at > now).reduce((a, o) => a + o.cash, 0);
  return t;
}

// One tick inside the touch, skewed against inventory, kept only where the edge over mid beats the maker fee.
// Returns null when no side can be quoted (outside the mid band or no room inside the spread).
export function quotePrices(s, inventory, { maxInventory = 10, skewTicks = 1, makerFeeRate = 0.0175, minQuoteEdge = 0.005, minMid = 0, maxMid = 1 } = {}) {
  const mid = (s.yesBid + s.yesAsk) / 2, skew = -inventory * skewTicks * 0.01;
  const bid = cents(Math.max(0.01, s.yesBid + 0.01 + skew)), ask = cents(Math.min(0.99, s.yesAsk - 0.01 + skew));
  const rate = s.fee_type === 'quadratic' ? 0 : makerFeeRate * (s.fee_multiplier ?? 1);
  if (!(mid >= minMid - 1e-9 && mid <= maxMid + 1e-9 && bid < ask && bid < s.yesAsk && ask > s.yesBid)) return null;
  const buy = inventory < maxInventory && mid - bid - kalshiFee(1, bid, rate) >= minQuoteEdge - 1e-9 ? bid : null;
  const sell = inventory > -maxInventory && ask - mid - kalshiFee(1, ask, rate) >= minQuoteEdge - 1e-9 ? ask : null;
  return buy === null && sell === null ? null : { buy, sell, rate };
}

export function simulate(snapshots, { maxInventory = 10, skewTicks = 1, pullMinutes = 60, makerFeeRate = 0.0175, maxQuoteAgeMs = 30000, maxMarkoutDelayMs = 30000, minQuoteEdge = 0.005, takerFeeRate = 0.07,
  pullBeforeExpiryMinutes = null, minMid = 0, maxMid = 1, jumpHalt = Infinity, settlements = {}, trades = [], allow = null, strictFills = false } = {}) {
  if (!Number.isInteger(maxInventory) || maxInventory < 1 || !Number.isFinite(skewTicks) || skewTicks < 0 || !Number.isFinite(pullMinutes) || pullMinutes < 0 || !Number.isFinite(makerFeeRate) || makerFeeRate < 0 || !Number.isFinite(takerFeeRate) || takerFeeRate < 0) throw new Error('Invalid MM options');
  if (![maxQuoteAgeMs, maxMarkoutDelayMs, minQuoteEdge].every(n => Number.isFinite(n) && n >= 0)) throw new Error('Invalid MM freshness or edge');
  if ((pullBeforeExpiryMinutes !== null && !(pullBeforeExpiryMinutes >= 0)) || !(minMid >= 0 && maxMid <= 1 && minMid < maxMid) || !(jumpHalt > 0)) throw new Error('Invalid MM risk limits');
  // strictFills: only a print or a book strictly through the quote fills it (a lower bound: the quote surely traded before a worse
  // price did). The default, at or through, assumes the quote was first in line at its own price (an upper bound).
  const slack = strictFills ? -1e-9 : 1e-9;
  const groups = new Map();
  for (const s of snapshots) {
    if (!s.ticker || !Number.isFinite(s.time) || !Number.isFinite(Date.parse(s.close_time)) || !(s.yesBid > 0 && s.yesAsk < 1 && s.yesBid < s.yesAsk) || ![s.yesBid, s.yesAsk, s.yesBidSize, s.yesAskSize].every(Number.isFinite) || !(s.yesBidSize > 0 && s.yesAskSize > 0)) continue;
    if (!groups.has(s.ticker)) groups.set(s.ticker, []);
    groups.get(s.ticker).push(s);
  }
  const tapes = new Map();
  for (const t of trades) {
    if (!t?.ticker || !Number.isFinite(t.time) || !Number.isFinite(t.price) || !['yes', 'no'].includes(t.takerSide)) continue;
    if (!tapes.has(t.ticker)) tapes.set(t.ticker, []);
    tapes.get(t.ticker).push(t);
  }
  for (const tape of tapes.values()) tape.sort((a, b) => a.time - b.time);
  const markets = [], changes = [];
  for (const [ticker, rows] of groups) {
    // Open inventory is marked at its exit side (bid for long, ask for short) less the taker fee to flatten it.
    // Settled markets are valued at their $1/$0 outcome instead. shortcut: no depth-limited liquidation, add it before sizing up.
    const exitValue = (s, n) => n ? n * (n > 0 ? s.yesBid : s.yesAsk) - kalshiFee(Math.abs(n), n > 0 ? s.yesBid : s.yesAsk, takerFeeRate * (s.fee_multiplier ?? 1)) : 0;
    rows.sort((a, b) => a.time - b.time);
    let halted = false, priorMid = null;
    let inventory = 0, cash = 0, quotes = null, maxAbsInventory = 0, averageEntry = 0, closedGross = 0, priorRealized = 0, priorUnrealized = 0, lastOpenMid = null;
    const fills = [], result = { ticker, ...metrics() }, tape = tapes.get(ticker) ?? [];
    let next = 0;
    for (let i = 0; i < rows.length; i++) {
      const s = rows[i], mid = (s.yesBid + s.yesAsk) / 2;
      // A game market's close_time is a backstop days out; expected expiry tracks the game, so quoting stops before play starts.
      const expiry = Date.parse(s.expected_expiration_time);
      const cutoff = s.time >= Date.parse(s.close_time) - pullMinutes * minute ||
        (pullBeforeExpiryMinutes !== null && Number.isFinite(expiry) && s.time >= expiry - pullBeforeExpiryMinutes * minute);
      // A recorded trade while the quote rested also fills it: a seller at or below the model bid would have hit that better
      // price first, and a buyer at or above the model ask likewise. Without trades, only a crossed book counts.
      let soldInto = false, boughtFrom = false, soldSize = 0, boughtSize = 0;
      while (next < tape.length && tape[next].time <= s.time) {
        const t = tape[next++];
        if (!quotes || t.time <= quotes.time) continue;
        if (t.takerSide === 'no' && quotes.bid != null && t.price <= quotes.bid + slack) { soldInto = true; soldSize += t.count ?? 1; }
        if (t.takerSide === 'yes' && quotes.ask != null && t.price >= quotes.ask - slack) { boughtFrom = true; boughtSize += t.count ?? 1; }
      }
      if (!cutoff) lastOpenMid = mid;
      // shortcut: one contract per side per interval and no queue model, upgrade with depth recordings before sizing up.
      if (quotes && s.time - quotes.time > maxQuoteAgeMs) result.staleIntervals++;
      if (quotes && s.time > quotes.time && s.time - quotes.time <= maxQuoteAgeMs && !cutoff) {
        for (const [side, p, crossed, traded, size] of [['buy', quotes.bid, s.yesAskSize >= 1 && s.yesAsk <= quotes.bid + slack, soldInto, Math.max(soldSize, s.yesAsk <= quotes.bid + slack ? s.yesAskSize : 0)],
          ['sell', quotes.ask, s.yesBidSize >= 1 && s.yesBid >= quotes.ask - slack, boughtFrom, Math.max(boughtSize, s.yesBid >= quotes.ask - slack ? s.yesBidSize : 0)]]) {
          if (p == null || !(crossed || traded) || (side === 'buy' ? inventory >= maxInventory : inventory <= -maxInventory)) continue;
          if (!crossed) result.tradeFills++;
          const direction = side === 'buy' ? 1 : -1;
          const feeRate = quotes.fee_type === 'quadratic' ? 0 : makerFeeRate * quotes.fee_multiplier;
          const fee = kalshiFee(1, p, feeRate);
          cash -= direction * p + fee;
          if (inventory && Math.sign(inventory) !== direction) closedGross += (p - averageEntry) * Math.sign(inventory);
          else averageEntry = (averageEntry * Math.abs(inventory) + p) / (Math.abs(inventory) + 1);
          inventory += direction;
          if (!inventory) averageEntry = 0;
          maxAbsInventory = Math.max(maxAbsInventory, Math.abs(inventory));
          result.fees += fee;
          result.spreadCaptured += direction * (quotes.mid - p);
          fills.push({ time: s.time, side, price: p, fee, feeRate, available: size });
        }
      }
      const realizedPnl = closedGross - result.fees;
      const unrealizedPnl = exitValue(s, inventory) - inventory * averageEntry;
      changes.push({ time: s.time, realized: realizedPnl - priorRealized, unrealized: unrealizedPnl - priorUnrealized });
      priorRealized = realizedPnl; priorUnrealized = unrealizedPnl;
      quotes = null;
      // A jump in the mid means news or live play. The move already hit any resting quote above; nothing is quoted again.
      if (priorMid !== null && Math.abs(mid - priorMid) >= jumpHalt - 1e-9) halted = true;
      priorMid = mid;
      const prices = cutoff || halted ? null : quotePrices(s, inventory, { maxInventory, skewTicks, makerFeeRate, minQuoteEdge, minMid, maxMid });
      // An optional policy (for example the learned bandit) may decline a side the fixed rules would quote; it cannot add one.
      const buy = prices?.buy != null && (!allow || allow(rows, i, 'buy', prices.buy)) ? prices.buy : null;
      const sell = prices?.sell != null && (!allow || allow(rows, i, 'sell', prices.sell)) ? prices.sell : null;
      if (buy !== null || sell !== null) quotes = { time: s.time, mid, bid: buy, ask: sell, fee_type: s.fee_type, fee_multiplier: s.fee_multiplier ?? 1 };
    }
    for (const fill of fills) {
      // Require a mark near the requested horizon; sparse later observations cannot establish a 15-minute markout.
      const mark = rows.find(s => s.time >= fill.time + 15 * minute);
      if (!mark || mark.time > fill.time + 15 * minute + maxMarkoutDelayMs) { result.unmarkedFills++; continue; }
      result.markedFills++;
      result.adverseSelectionLoss += (fill.side === 'buy' ? 1 : -1) * (fill.price - (mark.yesBid + mark.yesAsk) / 2);
    }
    // Closing-line value: each fill against the last mid before quoting stopped, after its fee. Far less noisy than settlement,
    // which swings each contract by its whole price. Contracts traded through the quote bound how much size the edge supports.
    // shortcut: the closing mid of a wide, thin book is not a fair price, so this score flatters; read it beside settled P&L.
    for (const fill of fills) {
      fill.clv = (fill.side === 'buy' ? 1 : -1) * (lastOpenMid - fill.price) - fill.fee;
      result.clv += fill.clv;
      result.availableContracts += fill.available;
    }
    result.fillLog = fills;
    const last = rows.at(-1);
    result.fills = fills.length;
    result.inventory = inventory;
    result.maxAbsInventory = maxAbsInventory;
    const settle = settlements[ticker];
    result.settled = settle === 0 || settle === 1;
    if (result.settled) {
      const realizedPnl = closedGross - result.fees + inventory * (settle - averageEntry);
      changes.push({ time: last.time, realized: realizedPnl - priorRealized, unrealized: -priorUnrealized });
      priorRealized = realizedPnl; priorUnrealized = 0;
    }
    result.netPnl = cash + (result.settled ? inventory * settle : exitValue(last, inventory));
    result.grossPnl = result.netPnl + result.fees;
    result.realizedPnl = priorRealized;
    result.unrealizedPnl = priorUnrealized;
    markets.push(result);
  }
  const total = metrics();
  for (const result of markets) for (const key of Object.keys(total)) total[key] += result[key];
  total.realizedPnl = markets.reduce((n, m) => n + m.realizedPnl, 0);
  total.unrealizedPnl = markets.reduce((n, m) => n + m.unrealizedPnl, 0);
  const grouped = new Map();
  for (const change of changes) {
    const point = grouped.get(change.time) ?? { realized: 0, unrealized: 0 };
    point.realized += change.realized; point.unrealized += change.unrealized;
    grouped.set(change.time, point);
  }
  let realizedPnl = 0, unrealizedPnl = 0;
  const equity = [...grouped].sort(([a], [b]) => a - b).map(([time, delta]) => {
    realizedPnl += delta.realized; unrealizedPnl += delta.unrealized;
    return { time, realizedPnl, unrealizedPnl, netPnl: realizedPnl + unrealizedPnl };
  });
  return { markets, total, equity };
}
