// The week-long paper test of a $2,000 split (started 2026-11-12): node scripts/paper-portfolio.js. Each agent runs with its share
// as --budget (dollars held in open positions); this tallies what each made since the start. Reward-maker's figures are its whole
// run, from the last line of its log. Writes data/paper/portfolio.md. Paper only; no orders.
import { readFileSync } from 'node:fs';
import { openLedger } from '../src/paper.js';
import { projectPath, writeProjectFile } from '../src/files.js';
import { markdownTable } from '../src/report.js';

const START = Date.parse('2026-11-12T22:27:00Z'), DAY_MS = 86400000;
const SPLIT = { 'game-watch': 1200, 'station-watch': 150, 'reward-maker': 500, reserve: 150 };
const money = x => (x < 0 ? '−$' : '$') + Math.abs(x).toFixed(2), days = Math.max((Date.now() - START) / DAY_MS, 1 / 24);

const rows = ['game-watch', 'station-watch'].map(agent => {
  const ledger = openLedger(agent), trades = ledger.trades.filter(t => t.time >= START);
  const settled = trades.filter(t => ledger.settled.has(t.ticker)), pnl = settled.reduce((a, t) => a + ledger.settled.get(t.ticker), 0);
  const open = trades.filter(t => !ledger.settled.has(t.ticker)).reduce((a, t) => a + (t.price + t.fee) * (t.contracts ?? 1), 0);
  return { agent, budget: SPLIT[agent], trades: trades.length, contracts: trades.reduce((a, t) => a + (t.contracts ?? 1), 0), settled: settled.length, pnl, open };
});
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
