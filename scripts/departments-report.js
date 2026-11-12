// The department leaderboard from the history tests: every saved trade (quoting engine, agents A, C, D, F, station-watch, weather-maker and game-watch) split into the
// seven departments of config/departments.json. Research only; it reads reports and writes one. An agent whose report is missing
// or predates saved trades is listed, not guessed.
import { loadDepartments, scoreboard, ARBITRAGE } from '../src/departments.js';
import { markdownTable, readResearch } from '../src/report.js';
import { writeProjectFile } from '../src/files.js';

const root = process.argv.slice(2).find(a => !a.startsWith('--')) ?? 'data/history';
const WEEKLY_TARGET = 1000;
const SOURCES = [
  { agent: 'maker', path: 'bandit-report.json', key: 'markets' },
  { agent: 'sportsbook', path: 'agents/sportsbook-report.json', key: 'trades' },
  { agent: 'longshot', path: 'agents/longshot-report.json', key: 'trades' },
  { agent: 'weather', path: 'agents/weather-report.json', key: 'trades' },
  { agent: 'station-watch', path: 'agents/station-watch-report.json', key: 'trades' },
  { agent: 'game-watch', path: 'agents/game-watch-report.json', key: 'trades' },
  { agent: 'weather-maker', path: 'agents/weather-maker-report.json', key: 'trades' },
  { agent: 'crossvenue', path: 'agents/crossvenue-report.json', key: 'trades', department: ARBITRAGE },
];

const departments = loadDepartments(), results = [], missing = [];
for (const s of SOURCES) {
  const trades = readResearch(`${root}/${s.path}`, null)?.[s.key];
  if (Array.isArray(trades)) results.push({ agent: s.agent, department: s.department, trades });
  else missing.push(s.agent);
}
const board = scoreboard(results, departments).map(row => ({ ...row, mode: 'research' }));
const days = results.flatMap(r => r.trades.map(t => t.day)).sort();
writeProjectFile(`${root}/departments-report.json`, JSON.stringify({ generatedAt: Date.now(), firstDay: days[0] ?? null, lastDay: days.at(-1) ?? null,
  weeklyTarget: WEEKLY_TARGET, missing, departments: board }, null, 2) + '\n');

const money = x => (x < 0 ? '−$' : '$') + Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const share = x => `${x < 0 ? '−' : ''}${Math.abs(x * 100).toFixed(1)}%`;
writeProjectFile(`${root}/departments-report.md`, ['# Departments, history test', '',
  `Research only: every trade the history tests made, split by department. ${days.length ? `Trades from ${days[0]} to ${days.at(-1)}.` : 'No trades yet.'} Ranges are 97.5%, resampling whole events. The quoting engine counts with its fixed rules. "Last 7 days" ends on the newest traded day; the target is $${WEEKLY_TARGET.toLocaleString('en-US')} a week. The quoting engine's trades are its fills.`, '',
  missing.length ? `Not counted (report missing or without saved trades): ${missing.join(', ')}.` : 'Every agent report was counted.', '',
  markdownTable(['#', 'Department', 'Trades', 'Settled P&L (range)', 'Last day', 'Last 7 days', 'Share of target', 'Closing-line value', 'Gate', 'Agents'],
    board.map((r, i) => [i + 1, r.name, r.trades, `${money(r.settled.total)} (${money(r.settled.low)} to ${money(r.settled.high)})`, money(r.lastDay), money(r.week),
      share(r.week / WEEKLY_TARGET), r.clv === null ? '' : money(r.clv), r.records ? (r.passes ? 'passes' : 'fails') : '',
      Object.entries(r.agents).map(([a, v]) => `${a} ${v.trades} (${money(v.pnl)})`).join(', ')])), ''].join('\n'));
console.log(JSON.stringify({ missing, departments: board.map(r => ({ id: r.id, trades: r.trades, settled: r.settled.total })) }));
