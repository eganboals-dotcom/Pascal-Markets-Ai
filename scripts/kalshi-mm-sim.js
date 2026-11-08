import { readFileSync } from 'node:fs';
import { simulate } from '../src/mm.js';
import { readResearch, markdownTable } from '../src/report.js';
import { projectPath, writeProjectFile } from '../src/files.js';

const out = process.argv[2] ?? 'research/kalshi';
const config = readResearch('config/scan.json', {});
// The game-day recorder may be appending while this replay reads; an unfinished final line is left for the next run.
function readBooks(path) {
  let text;
  try { text = readFileSync(projectPath(path), 'utf8'); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const lines = text.split(/\r?\n/);
  if (!text.endsWith('\n')) lines.pop();
  // shortcut: the live recording is read whole and only the last seven days are replayed, rotate the file if it outgrows memory.
  const since = Date.now() - 7 * 86400000;
  return lines.filter(Boolean).map(line => JSON.parse(line)).filter(row => row.time >= since);
}
const result = { generatedAt: Date.now(), ...simulate(readBooks(`${out}/books.jsonl`), { ...config.mm, makerFeeRate: config.makerFeeRate ?? 0.0175, takerFeeRate: config.feeRate ?? 0.07 }) };
const rows = [...result.markets, { ticker: 'TOTAL', ...result.total }];
writeProjectFile(`${out}/mm-sim.md`, ['# Market-making simulation', '', 'Research only. One-contract quotes, replaced at each snapshot. Quotes are pulled before close.', '',
  `Quote lifetime: ${config.mm?.maxQuoteAgeMs ?? 30000} ms. Expired quote intervals: ${result.total.staleIntervals}. Sparse intervals cannot establish fills.`, '',
  'Net P&L is cash plus final inventory at its exit side (bid for a long, ask for a short) less the taker fee to flatten it, after fees. Spread captured measures quote improvement versus the posting mid. Signed adverse-selection loss measures fill price against the first observed mid at least 15 minutes later; negative values are favorable. This diagnostic is not subtracted from net P&L again. Unmarked fills lack a later observation. Realized P&L is closed inventory profit less all incurred fees. Unrealized P&L is the remaining inventory at that exit value against average entry cost. No settlement or liquidation is simulated.', '',
  markdownTable(['Market', 'Fills', 'Spread captured', 'Fees', 'Adverse-selection loss', 'Unmarked fills', 'Realized P&L', 'Unrealized P&L', 'Net P&L'], rows.map(r => [r.ticker, r.fills, r.spreadCaptured.toFixed(4), r.fees.toFixed(4), r.adverseSelectionLoss.toFixed(4), r.unmarkedFills, r.realizedPnl.toFixed(4), r.unrealizedPnl.toFixed(4), r.netPnl.toFixed(4)])), ''].join('\n'));
writeProjectFile(`${out}/mm-sim.json`, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
