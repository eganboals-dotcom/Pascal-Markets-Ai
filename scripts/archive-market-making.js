// Simulates passive market making on the home outcome against archived order books.
// Usage: node scripts/archive-market-making.js <extract-dir> [inputs-dir] [results-dir]
// Rests SIZE shares at the best bid and best ask, rejoins the back of the queue when the touch moves,
// caps inventory, and holds what remains to settlement. Queue position is unknown, so two fill rules
// bound the result: "pessimistic" fills only when the opposite price crosses the order; "optimistic"
// counts every size decrease at the order's price as trades ahead of it.
import { readFileSync } from 'node:fs';
import { quotesFor } from './archive-books.js';
import { projectPath, writeProjectFile } from '../src/files.js';

const [extractDir, inputs = 'research/archive-replay/inputs', results = 'research/archive-replay/results'] = process.argv.slice(2);
if (!extractDir) throw new Error('Usage: node scripts/archive-market-making.js <extract-dir> [inputs-dir] [results-dir]');
const { markets } = JSON.parse(readFileSync(projectPath(`${inputs}/markets.json`), 'utf8'));
const SIZE = 10;
const MAX_INVENTORY = 100;
const REBATE = p => 0.15 * 0.05 * p * (1 - p); // assumed share of the taker fee returned to the maker, per share
const MARKOUTS_MS = [10000, 60000];

function simulate(quotes, homeWon, rule) {
  let cash = 0;
  let inventory = 0;
  let rebates = 0;
  const fills = [];
  const order = { bid: null, ask: null }; // { price, ahead }
  const live = quotes.filter(q => !q.invalidated && q.bid !== null && q.ask !== null);
  const fill = (side, price, at) => {
    const signed = side === 'bid' ? SIZE : -SIZE;
    inventory += signed;
    cash -= signed * price;
    rebates += SIZE * REBATE(price);
    fills.push({ side, price, at });
    order[side] = null;
  };
  for (const q of live) {
    for (const side of ['bid', 'ask']) {
      const o = order[side];
      if (!o) continue;
      const touch = q[side];
      const touchSize = side === 'bid' ? q.bidSize : q.askSize;
      const crossed = side === 'bid' ? q.ask <= o.price : q.bid >= o.price;
      if (crossed) { fill(side, o.price, q.receivedAt); continue; }
      if (touch === o.price) {
        if (rule === 'optimistic' && touchSize < o.ahead) o.ahead = touchSize; // size left ahead of us
        if (rule === 'optimistic' && o.ahead <= 0) fill(side, o.price, q.receivedAt);
        continue;
      }
      const worse = side === 'bid' ? touch < o.price : touch > o.price;
      if (worse && rule === 'optimistic') { fill(side, o.price, q.receivedAt); continue; } // level consumed
      order[side] = null; // touch moved: cancel and rejoin below
    }
    if (!order.bid && inventory + SIZE <= MAX_INVENTORY && q.bid > 0) order.bid = { price: q.bid, ahead: q.bidSize };
    if (!order.ask && inventory - SIZE >= -MAX_INVENTORY && q.ask < 1) order.ask = { price: q.ask, ahead: q.askSize };
  }
  const pnl = cash + inventory * homeWon;
  // Markout: midpoint after the delay minus the fill price, signed so positive means the fill was profitable.
  const markout = {};
  for (const ms of MARKOUTS_MS) {
    let j = 0;
    markout[ms] = 0;
    for (const f of fills) {
      while (j + 1 < live.length && live[j + 1].receivedAt <= f.at + ms) j++;
      const mid = (live[j].bid + live[j].ask) / 2;
      markout[ms] += (f.side === 'bid' ? mid - f.price : f.price - mid) * SIZE;
    }
  }
  return { fills: fills.length, endInventory: inventory, pnl, rebates, markout10s: markout[10000], markout60s: markout[60000] };
}

const games = [];
for (const market of markets) {
  const built = await quotesFor(extractDir, market);
  if (!built?.quotes.length) { games.push({ gameId: market.gameId, skipped: true }); continue; }
  const quotes = built.quotes.sort((a, b) => a.receivedAt - b.receivedAt);
  games.push({ gameId: market.gameId, slug: market.slug,
    pessimistic: simulate(quotes, market.homeWon, 'pessimistic'), optimistic: simulate(quotes, market.homeWon, 'optimistic') });
}
const played = games.filter(g => !g.skipped);
const total = rule => {
  const keys = ['fills', 'pnl', 'rebates', 'markout10s', 'markout60s'];
  const sum = Object.fromEntries(keys.map(k => [k, played.reduce((a, g) => a + g[rule][k], 0)]));
  return { ...sum, winningGames: played.filter(g => g[rule].pnl + g[rule].rebates > 0).length };
};
const summary = { pessimistic: total('pessimistic'), optimistic: total('optimistic') };
writeProjectFile(`${results}/market-making.json`, JSON.stringify({ createdAt: new Date().toISOString(),
  size: SIZE, maxInventory: MAX_INVENTORY, games: played.length, summary, perGame: games }, null, 1) + '\n');
const m = x => (x < 0 ? '-$' : '$') + Math.abs(x).toFixed(2);
const perShare = (x, s) => `${(x / Math.max(1, s.fills * SIZE) * 100).toFixed(2)}c`;
writeProjectFile(`${results}/market-making.md`, [
  '# Market-making simulation', '',
  `${played.length} games. ${SIZE} shares resting at the best bid and ask, inventory capped at ${MAX_INVENTORY} shares, held to settlement. No maker fee; the rebate column assumes 15% of the 5% taker fee is returned.`, '',
  '| Fill rule | Fills | Net P&L | Rebates | Markout 10s per share | Markout 60s per share | Games up |', '|---|---|---|---|---|---|---|',
  ...Object.entries(summary).map(([rule, s]) => `| ${rule} | ${s.fills} | ${m(s.pnl)} | ${m(s.rebates)} | ${perShare(s.markout10s, s)} | ${perShare(s.markout60s, s)} | ${s.winningGames} of ${played.length} |`), '',
  'Markout is the midpoint after the delay minus the fill price, from the market maker\'s side; negative values mean fills come from better-informed traders.',
  'Pessimistic fills only when the opposite price crosses the order. Optimistic treats every size decrease at the order\'s price as trades ahead of it. The true result lies between them.', ''
].join('\n'));
console.log(JSON.stringify(summary, null, 1));
