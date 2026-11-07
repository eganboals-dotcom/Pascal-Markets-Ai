import { simulate } from '../src/mm.js';
import { readResearch, markdownTable } from '../src/report.js';
import { writeProjectFile } from '../src/files.js';

const out = process.argv[2] ?? 'research/kalshi';
const config = readResearch('config/scan.json', {});
const result = { generatedAt: Date.now(), ...simulate(readResearch(`${out}/books.jsonl`, [], true), { ...config.mm, makerFeeRate: config.makerFeeRate ?? 0.0175 }) };
const rows = [...result.markets, { ticker: 'TOTAL', ...result.total }];
writeProjectFile(`${out}/mm-sim.md`, ['# Market-making simulation', '', 'Research only. One-contract quotes, replaced at each snapshot. Quotes are pulled before close.', '',
  'Net P&L is cash plus final inventory at the last observed mid, after fees. Spread captured measures quote improvement versus the posting mid. Signed adverse-selection loss measures fill price against the first observed mid at least 15 minutes later; negative values are favorable. This diagnostic is not subtracted from net P&L again. Unmarked fills lack a later observation. No settlement or liquidation is simulated.', '',
  markdownTable(['Market', 'Fills', 'Spread captured', 'Fees', 'Adverse-selection loss', 'Unmarked fills', 'Net P&L'], rows.map(r => [r.ticker, r.fills, r.spreadCaptured.toFixed(4), r.fees.toFixed(4), r.adverseSelectionLoss.toFixed(4), r.unmarkedFills, r.netPnl.toFixed(4)])), ''].join('\n'));
writeProjectFile(`${out}/mm-sim.json`, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
