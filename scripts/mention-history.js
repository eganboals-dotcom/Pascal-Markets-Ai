// Out-of-sample check of the "mention" finding (scripts/becker-mention.py) on the project's own history (unlocked days only; run from the project root), like for like with the
// Becker test: (1) copy the day's first taker on each side in each market, at the price that taker paid, 7% fee, hold to
// settlement; (2) from the books, buy No (or Yes) at its ask at the first book at least an hour before the close whose spread is
// at most `maxSpread` and whose price is in the band. Ranges are 95%, by event. Read-only.
import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { historyDays } from '../src/history.js';
const { days } = historyDays('data/history');
const lines = async function* (path) { if (!existsSync(path)) return; for await (const l of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) if (l.includes('MENTION')) { try { yield JSON.parse(l); } catch { /* skip */ } } };
const markets = new Map();
for (const day of days) {
  const want = new Map();
  for await (const m of lines(`data/history/${day}/markets.jsonl`)) if (/MENTION/.test(m.series ?? m.ticker) && !/DURATION/.test(m.ticker) && (m.result === 'yes' || m.result === 'no')) want.set(m.ticker, { ticker: m.ticker, day, yes: m.result === 'yes', rows: [], trades: [] });
  if (!want.size) continue;
  for await (const r of lines(`data/history/${day}/books.jsonl`)) want.get(r.ticker)?.rows.push(r);
  for await (const t of lines(`data/history/${day}/trades.jsonl`)) want.get(t.ticker)?.trades.push(t);
  for (const [k, v] of want) markets.set(k, v);
}
const fee = p => 0.07 * p * (1 - p), event = t => t.split('-').slice(0, 2).join('-');
let seed = 23; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
const mid = days[Math.floor(days.length / 2)];
function line(name, trades) {
  if (trades.length < 40) return;
  const by = new Map(); for (const t of trades) by.set(t.event, (by.get(t.event) ?? 0) + t.pnl);
  const v = [...by.values()], n = v.length, tot = [];
  for (let i = 0; i < 1000; i++) { let s = 0; for (let j = 0; j < n; j++) s += v[(rnd() * n) | 0]; tot.push(s); }
  tot.sort((a, b) => a - b);
  const k = trades.length, sum = trades.reduce((a, t) => a + t.pnl, 0), part = q => `${(100 * q.reduce((a, t) => a + t.pnl, 0) / Math.max(1, q.length)).toFixed(2)}c (n ${q.length})`;
  console.log(`  ${name.padEnd(30)} n ${String(k).padStart(5)} events ${String(n).padStart(4)} | paid ${(100 * trades.reduce((a, t) => a + t.price, 0) / k).toFixed(1)}c won ${(100 * trades.filter(t => t.win).length / k).toFixed(1)}% | ${(100 * sum / k).toFixed(2)}c a contract (${(100 * tot[25] / k).toFixed(2)} to ${(100 * tot[974] / k).toFixed(2)}) | halves ${part(trades.filter(t => t.day < mid))} / ${part(trades.filter(t => t.day >= mid))}`);
}
const withTrades = [...markets.values()].filter(m => m.trades.length).length, withBooks = [...markets.values()].filter(m => m.rows.length).length;
console.log(`unlocked days ${days.length}; mention markets ${markets.size} (${withTrades} with trades, ${withBooks} with books), events ${new Set([...markets.keys()].map(event)).size}`);
// (1) Copy the first taker of each side on each UTC day.
const copied = [];
for (const m of markets.values()) {
  const seen = new Set();
  for (const t of m.trades.sort((a, b) => a.time - b.time)) {
    const key = t.takerSide + new Date(t.time).toISOString().slice(0, 10);
    if (seen.has(key) || (t.takerSide !== 'yes' && t.takerSide !== 'no')) continue;
    seen.add(key);
    const price = t.takerSide === 'yes' ? t.price : 1 - t.price, win = t.takerSide === 'yes' ? m.yes : !m.yes;
    if (!(price > 0 && price < 1)) continue;
    copied.push({ event: event(m.ticker), day: m.day, side: t.takerSide, price, win, pnl: (win ? 1 : 0) - price - fee(price) });
  }
}
const BANDS = [[0.01, 0.10], [0.11, 0.20], [0.21, 0.35], [0.36, 0.50], [0.51, 0.65], [0.66, 0.80], [0.81, 0.90], [0.91, 0.99]];
for (const side of ['yes', 'no']) {
  console.log(`\n(1) Copying takers who bought ${side.toUpperCase()}, 2026 trades:`);
  line('all prices', copied.filter(t => t.side === side));
  line('21-90c', copied.filter(t => t.side === side && t.price >= 0.21 - 1e-9 && t.price <= 0.90 + 1e-9));
  for (const [lo, hi] of BANDS) line(`${Math.round(lo * 100)}-${Math.round(hi * 100)}c`, copied.filter(t => t.side === side && t.price >= lo - 1e-9 && t.price <= hi + 1e-9));
}
// (2) Books: the first book that fits.
function run(side, lo, hi, maxSpread) {
  const out = [];
  for (const m of markets.values()) for (const r of m.rows.sort((a, b) => a.time - b.time)) {
    const hours = (Date.parse(r.close_time) - r.time) / 3600000, price = side === 'no' ? 1 - r.yesBid : r.yesAsk, spread = r.yesAsk - r.yesBid;
    if (!(hours >= 1) || !(price >= lo - 1e-9 && price <= hi + 1e-9) || !(r.yesBid > 0 && r.yesAsk < 1) || spread > maxSpread + 1e-9) continue;
    const win = side === 'no' ? !m.yes : m.yes;
    out.push({ event: event(m.ticker), day: m.day, price, win, pnl: (win ? 1 : 0) - price - fee(price) });
    break;
  }
  return out;
}
for (const side of ['no', 'yes']) {
  console.log(`\n(2) Buy ${side.toUpperCase()} at its ask in the books, first fit, by the widest spread allowed:`);
  for (const s of [0.01, 0.02, 0.03, 0.05]) line(`21-90c, spread up to ${Math.round(s * 100)}c`, run(side, 0.21, 0.90, s));
  for (const [lo, hi] of BANDS.slice(2, 7)) line(`${Math.round(lo * 100)}-${Math.round(hi * 100)}c, spread up to 3c`, run(side, lo, hi, 0.03));
}
