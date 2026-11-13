// The week-long paper test of a $2,000 split (started 2026-11-12, split changed 2026-11-13): node scripts/paper-portfolio.js. Each
// taker runs with its share as --budget (dollars held in open positions); quoting's share caps the learned policy's fills at
// mm.quoteSize here (budgetedFills in src/mm.js), from the switch on. This tallies what each made since the start. Reward-maker's figures are its whole
// run, from the last line of its log. Writes data/paper/portfolio.md. Paper only; no orders.
import { readFileSync } from 'node:fs';
import { openLedger } from '../src/paper.js';
import { budgetedFills } from '../src/mm.js';
import { readResearch } from '../src/report.js';
import { projectPath, writeProjectFile } from '../src/files.js';
import { markdownTable } from '../src/report.js';

const START = Date.parse('2026-11-12T22:27:00Z'), DAY_MS = 86400000;
const SWITCH = Date.parse('2026-11-13T03:10:00Z'); // game-watch 1,200 -> 850, quoting 0 -> 350
const SPLIT = { 'game-watch': 850, 'quoting': 350, 'station-watch': 150, 'reward-maker': 500, reserve: 150 };
const money = x => (x < 0 ? '−$' : '$') + Math.abs(x).toFixed(2), days = Math.max((Date.now() - START) / DAY_MS, 1 / 24);

const rows = ['game-watch', 'station-watch'].map(agent => {
  const ledger = openLedger(agent), trades = ledger.trades.filter(t => t.time >= START);
  const settled = trades.filter(t => ledger.settled.has(t.ticker)), pnl = settled.reduce((a, t) => a + ledger.settled.get(t.ticker), 0);
  const open = trades.filter(t => !ledger.settled.has(t.ticker)).reduce((a, t) => a + (t.price + t.fee) * (t.contracts ?? 1), 0);
  return { agent, budget: SPLIT[agent], trades: trades.length, contracts: trades.reduce((a, t) => a + (t.contracts ?? 1), 0), settled: settled.length, pnl, open };
});
let fills = [];
try { fills = readFileSync(projectPath('data/maker/quoting-fills.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(f => f.time >= SWITCH); }
catch { /* no fills kept yet */ }
const size = readResearch('config/scan.json', {}).mm?.quoteSize ?? 1, q = budgetedFills(fills, size, SPLIT.quoting, readResearch('data/maker/settlements.json', {}));
rows.push({ agent: 'quoting', budget: SPLIT.quoting, trades: q.taken, contracts: q.contracts, settled: q.settledFills, pnl: q.settledPnl, open: q.held,
  note: `learned policy at ${size} a quote, since ${new Date(SWITCH).toISOString().slice(0, 16)}; ${q.skipped} fills skipped for cash; first in line (an upper bound)` });
let reward = null;
try { reward = JSON.parse(readFileSync(projectPath('data/paper/reward-maker.log'), 'utf8').trim().split('\n').filter(l => l.startsWith('{')).at(-1)); }
catch { /* no log yet: reported as missing */ }
rows.push({ agent: 'reward-maker', budget: SPLIT['reward-maker'], trades: reward?.fills ?? 0, contracts: null, settled: null,
  pnl: reward ? reward.accrued + reward.settledPnl : 0, open: reward?.cash ?? 0, note: reward ? `rewards ${money(reward.accrued)} (paper estimate), fills settled ${money(reward.settledPnl)}, open marked ${money(reward.openMarked)}` : 'no log' });
const total = rows.reduce((a, r) => a + r.pnl, 0);

writeProjectFile('data/paper/portfolio.md', [`# Paper test of a $2,000 split, since ${new Date(START).toISOString().slice(0, 16)} UTC (${days.toFixed(1)} days)`, '',
  markdownTable(['Agent', 'Budget', 'Trades', 'Contracts', 'Settled', 'P&L', 'Held now', 'Note'],
    rows.map(r => [r.agent, money(r.budget), r.trades, r.contracts ?? '', r.settled ?? '', money(r.pnl), money(r.open), r.note ?? ''])), '',
  `Reserve ${money(SPLIT.reserve)}. Total ${money(total)}, ${money(total / days)} a day.`, ''].join('\n'));
console.log(JSON.stringify({ days: +days.toFixed(2), total: +total.toFixed(2), rows: rows.map(r => [r.agent, r.trades, +r.pnl.toFixed(2), +r.open.toFixed(0)]) }));
