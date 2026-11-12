// The walk-forward picker on the downloaded history (research only; no orders): for each market group of each agent that writes a
// settings grid (game-watch and station-watch write <root>/agents/<agent>-grid.json), which setting has the best profit-to-risk,
// chosen each day from the days before it only (src/tuner.js). The report compares that walk with the agent's fixed default on
// the same days, and lists what each group should run next: a setting, "off" when at least --min-events (10) events show no
// setting above zero, or "default" when there are too few events to say. The live agents read the "next" picks from
// data/history/agents/tune-report.json. The grids hold unlocked days only, so the locked final exam stays unseen.
import { existsSync, readFileSync } from 'node:fs';
import { profitToRisk, walkForward } from '../src/tuner.js';
import { markdownTable } from '../src/report.js';
import { projectPath, writeProjectFile } from '../src/files.js';

const root = process.argv.slice(2).find(a => !a.startsWith('--')) ?? 'data/history';
const minEvents = Number(process.argv.find(a => a.startsWith('--min-events='))?.split('=')[1] ?? 10);
// low (the default, chosen 2026-11-12 to grow total profit): the highest low end of the profit range in dollars; ratio: the highest profit-to-risk.
const objective = process.argv.find(a => a.startsWith('--objective='))?.split('=')[1] ?? 'low';
if (!['ratio', 'low'].includes(objective)) throw new Error('--objective must be ratio or low');
const AGENTS = [{ agent: 'game-watch', fixed: 0.01 }, { agent: 'station-watch', fixed: 0.01 }];
const money = x => (x < 0 ? '−$' : '$') + Math.abs(x).toFixed(2), pct = x => `${(x * 100).toFixed(1)}%`;

const results = {};
for (const { agent, fixed } of AGENTS) {
  const path = `${root}/agents/${agent}-grid.json`;
  if (!existsSync(projectPath(path))) continue;
  const { trades, setting } = JSON.parse(readFileSync(projectPath(path), 'utf8'));
  const walk = walkForward(trades, { minEvents, objective });
  const events = group => new Set(trades.filter(t => t.group === group).map(t => t.event ?? t.ticker.slice(0, t.ticker.lastIndexOf('-')))).size;
  const next = Object.fromEntries(Object.entries(walk.next).map(([group, pick]) => [group,
    pick ? { pick: pick.setting, score: pick.score, pnl: pick.pnl, trades: pick.trades, events: pick.events, worstEvent: pick.worstEvent }
      : { pick: events(group) >= minEvents ? 'off' : 'default', events: events(group) }]));
  results[agent] = { setting, fixed, days: walk.days, walk: profitToRisk(walk.taken), fixedResult: profitToRisk(trades.filter(t => t.setting === fixed && t.day > walk.days[0])), next };
}

writeProjectFile(`${root}/agents/tune-report.json`, JSON.stringify({ generatedAt: Date.now(), minEvents, objective, agents: results }, null, 2) + '\n');
const lines = ['# Walk-forward picker: the best profit-to-risk setting per market group', '',
  `Research only. Profit-to-risk is the low end of the 97.5% profit range (resampling whole events) divided by the money staked. Each day, every group runs the setting that scored best on the days before it (${objective === 'low' ? 'ranked by the low end of the profit range in dollars' : 'ranked by profit-to-risk'}), or nothing when no setting scores above zero on at least ${minEvents} earlier events. "Fixed" runs every group at the agent's default on the same days (all but the first, which the picker has nothing to choose from). The locked final exam is not in the grids.`, ''];
for (const [agent, r] of Object.entries(results)) {
  const row = (name, s) => [name, s.trades, money(s.pnl), money(s.low), money(s.stake), pct(s.score), money(s.worstEvent)];
  lines.push(`## ${agent} (setting: ${r.setting}, ${r.days.length} days)`, '',
    markdownTable(['', 'Trades', 'P&L', 'Range low', 'Staked', 'Profit-to-risk', 'Worst event'],
      [row('Walk-forward picker', r.walk), row(`Fixed ${r.setting} ${r.fixed}`, r.fixedResult)]), '',
    markdownTable(['Group', 'Next', 'Profit-to-risk', 'P&L', 'Trades', 'Events', 'Worst event'],
      Object.entries(r.next).sort().map(([g, n]) => [g, n.pick, n.score === undefined ? '' : pct(n.score), n.pnl === undefined ? '' : money(n.pnl), n.trades ?? '', n.events, n.worstEvent === undefined ? '' : money(n.worstEvent)])), '');
}
if (!Object.keys(results).length) lines.push('No settings grids found: run agent-game-watch.js and agent-station-watch.js first.', '');
writeProjectFile(`${root}/agents/tune-report.md`, lines.join('\n'));
console.log(JSON.stringify(Object.fromEntries(Object.entries(results).map(([a, r]) => [a, { walk: r.walk.pnl, fixed: r.fixedResult.pnl, off: Object.values(r.next).filter(n => n.pick === 'off').length }]))));
