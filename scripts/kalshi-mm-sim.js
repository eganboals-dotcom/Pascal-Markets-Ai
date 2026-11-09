import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { simulate } from '../src/mm.js';
import { fetchMarkets } from '../src/kalshi.js';
import { readResearch, markdownTable } from '../src/report.js';
import { projectPath, writeProjectFile } from '../src/files.js';

const out = process.argv[2] ?? 'research/kalshi';
const config = readResearch('config/scan.json', {});
// Streamed line by line: a week of 100-market recordings is larger than Node can hold as one string.
// The game-day recorder may be appending while this replay reads; an unfinished final line is left for the next run.
// shortcut: the file is never rotated and is re-read in full each run, rotate it daily once runs get slow.
async function readRecent(path, days = config.mm?.replayDays ?? 7) {
  const since = Date.now() - days * 86400000, rows = [];
  const keep = line => { const row = JSON.parse(line); if (row.time >= since) rows.push(row); };
  let pending = null;
  try {
    for await (const line of createInterface({ input: createReadStream(projectPath(path)), crlfDelay: Infinity })) {
      if (pending) keep(pending);
      pending = line || null;
    }
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  if (pending) { try { keep(pending); } catch { /* unfinished final line */ } }
  return rows;
}
// Settled outcomes are permanent, so they are cached; only markets missing from recent books are asked about again.
async function readSettlements(books, now = Date.now()) {
  const path = `${out}/settlements.json`, known = readResearch(path, {});
  const lastSeen = new Map(books.map(b => [b.ticker, b.time]));
  const ask = [...lastSeen].filter(([t, time]) => !(t in known) && now - time > 5 * 60000).map(([t]) => t);
  try {
    for (const m of ask.length ? await fetchMarkets(ask) : []) if (m.result === 'yes' || m.result === 'no') known[m.ticker] = m.result === 'yes' ? 1 : 0;
    if (ask.length) writeProjectFile(path, JSON.stringify(known) + '\n');
  } catch (error) { console.error(JSON.stringify({ settlementError: error.message })); } // Unsettled marks still stand; the next run retries.
  return known;
}
const books = await readRecent(`${out}/books.jsonl`), trades = await readRecent(`${out}/trades.jsonl`);
const settlements = await readSettlements(books);
const result = { generatedAt: Date.now(), ...simulate(books, { ...config.mm, makerFeeRate: config.makerFeeRate ?? 0.0175, takerFeeRate: config.feeRate ?? 0.07, settlements, trades }) };
const rows = [...result.markets, { ticker: 'TOTAL', ...result.total }];
writeProjectFile(`${out}/mm-sim.md`, ['# Market-making simulation', '', 'Research only. One-contract quotes, replaced at each snapshot. Quotes stop before a game starts, after a mid jump, and outside the mid-price band.', '',
  `Settled markets: ${result.markets.filter(m => m.settled).length} of ${result.markets.length}, valued at their $1/$0 outcome. Recorded trades: ${trades.length}; fills from trades: ${result.total.tradeFills}.`, '',
  `Quote lifetime: ${config.mm?.maxQuoteAgeMs ?? 30000} ms. Expired quote intervals: ${result.total.staleIntervals}. Sparse intervals cannot establish fills.`, '',
  'Net P&L is cash plus final inventory at its exit side (bid for a long, ask for a short) less the taker fee to flatten it, after fees. Spread captured measures quote improvement versus the posting mid. Signed adverse-selection loss measures fill price against the first observed mid at least 15 minutes later; negative values are favorable. This diagnostic is not subtracted from net P&L again. Unmarked fills lack a later observation. Realized P&L is closed inventory profit less all incurred fees. Unrealized P&L is the remaining inventory at that exit value against average entry cost. A settled market has no unrealized P&L: its inventory is valued at the outcome, without an exit fee. Liquidation depth is not simulated.', '',
  markdownTable(['Market', 'Fills', 'Spread captured', 'Fees', 'Adverse-selection loss', 'Unmarked fills', 'Realized P&L', 'Unrealized P&L', 'Net P&L'], rows.map(r => [r.ticker, r.fills, r.spreadCaptured.toFixed(4), r.fees.toFixed(4), r.adverseSelectionLoss.toFixed(4), r.unmarkedFills, r.realizedPnl.toFixed(4), r.unrealizedPnl.toFixed(4), r.netPnl.toFixed(4)])), ''].join('\n'));
writeProjectFile(`${out}/mm-sim.json`, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
