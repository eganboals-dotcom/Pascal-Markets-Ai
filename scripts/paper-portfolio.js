// The paper test of a $2,000 split (started 2026-11-12, split changed 2026-11-13, rebalanced nightly from 2026-11-13 by
// scripts/rebalance.js): node scripts/paper-portfolio.js. Each agent's P&L since the start and the cash it holds now, under the
// budgets in force at each moment (tally in src/portfolio.js). Reward-maker's figures are its whole run, from the last line of its
// log. Writes data/paper/portfolio.md. Paper only; no orders.
import { writeProjectFile } from '../src/files.js';
import { markdownTable } from '../src/report.js';
import { BASE, START, budgetRows, tally } from '../src/portfolio.js';

const money = x => (x < 0 ? '−$' : '$') + Math.abs(x).toFixed(2), days = Math.max((Date.now() - START) / 86400000, 1 / 24);
const { rows, total, reserve } = tally(), last = budgetRows().at(-1);

writeProjectFile('data/paper/portfolio.md', [`# Paper test of a $2,000 split, since ${new Date(START).toISOString().slice(0, 16)} UTC (${days.toFixed(1)} days)`, '',
  markdownTable(['Agent', 'Budget', 'Trades', 'Contracts', 'Settled', 'P&L', 'Held now', 'Note'],
    rows.map(r => [r.agent, money(r.budget), r.trades, r.contracts ?? '', r.settled ?? '', money(r.pnl), money(r.open), r.note ?? ''])), '',
  `Reserve ${money(reserve)}. Total ${money(total)}, ${money(total / days)} a day; bankroll ${money(BASE + total)}.`,
  last ? `Last rebalance: ${last.day} (Pacific), bankroll ${money(last.bankroll)}${last.notes?.length ? `; ${last.notes.join('; ')}` : ''}.` : 'No rebalance yet: the SPLIT shares apply.', ''].join('\n'));
console.log(JSON.stringify({ days: +days.toFixed(2), total: +total.toFixed(2), rows: rows.map(r => [r.agent, r.trades, +r.pnl.toFixed(2), +r.open.toFixed(0)]) }));
