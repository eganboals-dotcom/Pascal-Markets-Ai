import { kalshiFee } from './kalshi.js';

const minute = 60000;
const cents = x => Math.round(x * 100) / 100;
const metrics = () => ({ fills: 0, spreadCaptured: 0, fees: 0, adverseSelectionLoss: 0, markedFills: 0, unmarkedFills: 0, grossPnl: 0, netPnl: 0 });

export function simulate(snapshots, { maxInventory = 10, skewTicks = 1, pullMinutes = 60, makerFeeRate = 0.0175 } = {}) {
  if (!Number.isInteger(maxInventory) || maxInventory < 1 || !Number.isFinite(skewTicks) || skewTicks < 0 || !Number.isFinite(pullMinutes) || pullMinutes < 0 || !Number.isFinite(makerFeeRate) || makerFeeRate < 0) throw new Error('Invalid MM options');
  const groups = new Map();
  for (const s of snapshots) {
    if (!s.ticker || !Number.isFinite(s.time) || !Number.isFinite(Date.parse(s.close_time)) || !(s.yesBid > 0 && s.yesAsk < 1 && s.yesBid < s.yesAsk) || !(s.yesBidSize > 0 && s.yesAskSize > 0)) continue;
    if (!groups.has(s.ticker)) groups.set(s.ticker, []);
    groups.get(s.ticker).push(s);
  }
  const markets = [];
  for (const [ticker, rows] of groups) {
    // shortcut: final inventory is marked at the last sampled mid without settlement/liquidation, add terminal outcomes for realized-return studies.
    rows.sort((a, b) => a.time - b.time);
    let inventory = 0, cash = 0, quotes = null, maxAbsInventory = 0;
    const fills = [], result = { ticker, ...metrics() };
    for (const s of rows) {
      const mid = (s.yesBid + s.yesAsk) / 2;
      const pulled = s.time >= Date.parse(s.close_time) - pullMinutes * minute;
      // shortcut: one contract per crossed quote and no queue model, upgrade with trade/depth recordings before execution research.
      if (quotes && s.time > quotes.time && !pulled) {
        for (const [side, p, crossed] of [['buy', quotes.bid, s.yesAsk <= quotes.bid + 1e-9], ['sell', quotes.ask, s.yesBid >= quotes.ask - 1e-9]]) {
          if (p == null || !crossed || (side === 'buy' ? inventory >= maxInventory : inventory <= -maxInventory)) continue;
          const direction = side === 'buy' ? 1 : -1;
          const feeRate = quotes.fee_type === 'quadratic' ? 0 : makerFeeRate * quotes.fee_multiplier;
          const fee = kalshiFee(1, p, feeRate);
          cash -= direction * p + fee;
          inventory += direction;
          maxAbsInventory = Math.max(maxAbsInventory, Math.abs(inventory));
          result.fees += fee;
          result.spreadCaptured += direction * (quotes.mid - p);
          fills.push({ time: s.time, side, price: p, fee });
        }
      }
      quotes = null;
      const skew = -inventory * skewTicks * 0.01;
      const bid = cents(Math.max(0.01, s.yesBid + 0.01 + skew));
      const ask = cents(Math.min(0.99, s.yesAsk - 0.01 + skew));
      if (!pulled && bid <= ask && bid < s.yesAsk && ask > s.yesBid) {
        quotes = { time: s.time, mid, bid: inventory < maxInventory ? bid : null, ask: inventory > -maxInventory ? ask : null,
          fee_type: s.fee_type, fee_multiplier: s.fee_multiplier ?? 1 };
      }
    }
    for (const fill of fills) {
      // shortcut: first observed mid at least 15 minutes later approximates markout, upgrade to denser snapshots for exact 15-minute marks.
      const mark = rows.find(s => s.time >= fill.time + 15 * minute);
      if (!mark) { result.unmarkedFills++; continue; }
      result.markedFills++;
      result.adverseSelectionLoss += (fill.side === 'buy' ? 1 : -1) * (fill.price - (mark.yesBid + mark.yesAsk) / 2);
    }
    const last = rows.at(-1);
    result.fills = fills.length;
    result.inventory = inventory;
    result.maxAbsInventory = maxAbsInventory;
    result.netPnl = cash + inventory * (last.yesBid + last.yesAsk) / 2;
    result.grossPnl = result.netPnl + result.fees;
    markets.push(result);
  }
  const total = metrics();
  for (const result of markets) for (const key of Object.keys(total)) total[key] += result[key];
  return { markets, total };
}
