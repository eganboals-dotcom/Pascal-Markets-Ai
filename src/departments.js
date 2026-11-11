// The seven departments (plan, "Target product"). Each Kalshi series belongs to exactly one: the first department in
// config/departments.json with a matching pattern, else "else". Arbitrage owns no series; its results come from the cross-venue
// agent, whatever the series. The on/off switches live in a gitignored local file so they survive a restart.
import { readResearch } from './report.js';
import { writeProjectFile } from './files.js';
import { summarize } from './takers.js';

export const DEPARTMENTS_PATH = 'config/departments.json', SWITCHES_PATH = 'config/departments.local.json';
export const FALLBACK = 'else', ARBITRAGE = 'arbitrage';

export function loadDepartments(path = DEPARTMENTS_PATH) {
  const list = readResearch(path, null)?.departments;
  if (!Array.isArray(list) || ![FALLBACK, ARBITRAGE].every(id => list.some(d => d.id === id))) {
    throw new Error(`${path} must list departments, including "${FALLBACK}" and "${ARBITRAGE}"`);
  }
  return list.map(d => ({ id: d.id, name: d.name, patterns: (d.patterns ?? []).map(p => new RegExp(p)) }));
}

// Kalshi market tickers start with their series ticker (KXHIGHNY-26NOV07-B72.5).
export const seriesOf = ticker => String(ticker ?? '').split('-')[0];
export const departmentOf = (series, departments) => departments.find(d => d.patterns.some(p => p.test(series)))?.id ?? FALLBACK;

// Every department is on unless saved as off.
export function readSwitches(departments, path = SWITCHES_PATH) {
  const saved = readResearch(path, {});
  return Object.fromEntries(departments.map(d => [d.id, saved?.[d.id] !== false]));
}

export function writeSwitch(departments, id, on, path = SWITCHES_PATH) {
  if (!departments.some(d => d.id === id)) throw new Error(`Unknown department: ${id}`);
  if (typeof on !== 'boolean') throw new Error('A switch must be true or false');
  const next = { ...readSwitches(departments, path), [id]: on };
  writeProjectFile(path, JSON.stringify(next, null, 2) + '\n');
  return next;
}

// results: [{ agent, department?, trades: [{ day, ticker, series?, pnl, clv?, fills? }] }]. A result with a department puts all
// its trades there; the others go by series. "Last day" and the 7-day week are calendar days back from the newest day in any result.
export function scoreboard(results, departments, { weekDays = 7 } = {}) {
  const byDepartment = new Map(departments.map(d => [d.id, []]));
  for (const { agent, department, trades } of results) {
    for (const t of trades) byDepartment.get(department ?? departmentOf(t.series ?? seriesOf(t.ticker), departments)).push({ ...t, group: agent });
  }
  const last = results.flatMap(r => r.trades.map(t => t.day)).sort().at(-1);
  const weekStart = last ? new Date(Date.parse(last) - (weekDays - 1) * 86400000).toISOString().slice(0, 10) : '';
  const sum = (list, value) => list.reduce((n, t) => n + value(t), 0);
  return departments.map(d => {
    const trades = byDepartment.get(d.id), s = summarize(trades), withClv = trades.filter(t => Number.isFinite(t.clv)), agents = {};
    for (const t of trades) agents[t.group] = { trades: (agents[t.group]?.trades ?? 0) + (t.fills ?? 1), pnl: (agents[t.group]?.pnl ?? 0) + t.pnl };
    return { id: d.id, name: d.name, trades: sum(trades, t => t.fills ?? 1), records: trades.length, wins: trades.filter(t => t.pnl > 0).length,
      lastDay: sum(trades.filter(t => t.day === last), t => t.pnl), week: sum(trades.filter(t => t.day >= weekStart), t => t.pnl),
      settled: s.settled, passes: s.passes, clv: withClv.length ? sum(withClv, t => t.clv) : null, agents };
  }).sort((a, b) => b.settled.total - a.settled.total);
}
