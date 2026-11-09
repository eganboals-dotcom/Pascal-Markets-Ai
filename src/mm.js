import { kalshiFee } from './kalshi.js';

const minute = 60000;
const cents = x => Math.round(x * 100) / 100;
const metrics = () => ({ fills: 0, spreadCaptured: 0, fees: 0, adverseSelectionLoss: 0, markedFills: 0, unmarkedFills: 0, grossPnl: 0, netPnl: 0, staleIntervals: 0 });

export function simulate(snapshots, { maxInventory = 10, skewTicks = 1, pullMinutes = 60, makerFeeRate = 0.0175, maxQuoteAgeMs = 30000, maxMarkoutDelayMs = 30000, minQuoteEdge = 0.005, takerFeeRate = 0.07,
  pullBeforeExpiryMinutes = null, minMid = 0, maxMid = 1, jumpHalt = Infinity, settlements = {} } = {}) {
  if (!Number.isInteger(maxInventory) || maxInventory < 1 || !Number.isFinite(skewTicks) || skewTicks < 0 || !Number.isFinite(pullMinutes) || pullMinutes < 0 || !Number.isFinite(makerFeeRate) || makerFeeRate < 0 || !Number.isFinite(takerFeeRate) || takerFeeRate < 0) throw new Error('Invalid MM options');
  if (![maxQuoteAgeMs, maxMarkoutDelayMs, minQuoteEdge].every(n => Number.isFinite(n) && n >= 0)) throw new Error('Invalid MM freshness or edge');
  if ((pullBeforeExpiryMinutes !== null && !(pullBeforeExpiryMinutes >= 0)) || !(minMid >= 0 && maxMid <= 1 && minMid < maxMid) || !(jumpHalt > 0)) throw new Error('Invalid MM risk limits');
  const groups = new Map();
  for (const s of snapshots) {
    if (!s.ticker || !Number.isFinite(s.time) || !Number.isFinite(Date.parse(s.close_time)) || !(s.yesBid > 0 && s.yesAsk < 1 && s.yesBid < s.yesAsk) || ![s.yesBid, s.yesAsk, s.yesBidSize, s.yesAskSize].every(Number.isFinite) || !(s.yesBidSize > 0 && s.yesAskSize > 0)) continue;
    if (!groups.has(s.ticker)) groups.set(s.ticker, []);
    groups.get(s.ticker).push(s);
  }
  const markets = [], changes = [];
  for (const [ticker, rows] of groups) {
    // Open inventory is marked at its exit side (bid for long, ask for short) less the taker fee to flatten it.
    // Settled markets are valued at their $1/$0 outcome instead. shortcut: no depth-limited liquidation, add it before sizing up.
    const exitValue = (s, n) => n ? n * (n > 0 ? s.yesBid : s.yesAsk) - kalshiFee(Math.abs(n), n > 0 ? s.yesBid : s.yesAsk, takerFeeRate * (s.fee_multiplier ?? 1)) : 0;
    rows.sort((a, b) => a.time - b.time);
    let halted = false, priorMid = null;
    let inventory = 0, cash = 0, quotes = null, maxAbsInventory = 0, averageEntry = 0, closedGross = 0, priorRealized = 0, priorUnrealized = 0;
    const fills = [], result = { ticker, ...metrics() };
    for (const s of rows) {
      const mid = (s.yesBid + s.yesAsk) / 2;
      // A game market's close_time is a backstop days out; expected expiry tracks the game, so quoting stops before play starts.
      const expiry = Date.parse(s.expected_expiration_time);
      const cutoff = s.time >= Date.parse(s.close_time) - pullMinutes * minute ||
        (pullBeforeExpiryMinutes !== null && Number.isFinite(expiry) && s.time >= expiry - pullBeforeExpiryMinutes * minute);
      // shortcut: one contract per crossed quote and no queue model, upgrade with trade/depth recordings before execution research.
      if (quotes && s.time - quotes.time > maxQuoteAgeMs) result.staleIntervals++;
      if (quotes && s.time > quotes.time && s.time - quotes.time <= maxQuoteAgeMs && !cutoff) {
        for (const [side, p, crossed] of [['buy', quotes.bid, s.yesAskSize >= 1 && s.yesAsk <= quotes.bid + 1e-9], ['sell', quotes.ask, s.yesBidSize >= 1 && s.yesBid >= quotes.ask - 1e-9]]) {
          if (p == null || !crossed || (side === 'buy' ? inventory >= maxInventory : inventory <= -maxInventory)) continue;
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
          fills.push({ time: s.time, side, price: p, fee });
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
      const pulled = cutoff || halted;
      const skew = -inventory * skewTicks * 0.01;
      const bid = cents(Math.max(0.01, s.yesBid + 0.01 + skew));
      const ask = cents(Math.min(0.99, s.yesAsk - 0.01 + skew));
      const rate = s.fee_type === 'quadratic' ? 0 : makerFeeRate * (s.fee_multiplier ?? 1);
      const buy = inventory < maxInventory && mid - bid - kalshiFee(1, bid, rate) >= minQuoteEdge - 1e-9 ? bid : null;
      const sell = inventory > -maxInventory && ask - mid - kalshiFee(1, ask, rate) >= minQuoteEdge - 1e-9 ? ask : null;
      if (!pulled && mid >= minMid - 1e-9 && mid <= maxMid + 1e-9 && bid < ask && bid < s.yesAsk && ask > s.yesBid && (buy !== null || sell !== null)) {
        quotes = { time: s.time, mid, bid: buy, ask: sell,
          fee_type: s.fee_type, fee_multiplier: s.fee_multiplier ?? 1 };
      }
    }
    for (const fill of fills) {
      // Require a mark near the requested horizon; sparse later observations cannot establish a 15-minute markout.
      const mark = rows.find(s => s.time >= fill.time + 15 * minute);
      if (!mark || mark.time > fill.time + 15 * minute + maxMarkoutDelayMs) { result.unmarkedFills++; continue; }
      result.markedFills++;
      result.adverseSelectionLoss += (fill.side === 'buy' ? 1 : -1) * (fill.price - (mark.yesBid + mark.yesAsk) / 2);
    }
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
