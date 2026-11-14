// The paper test's $2,000 split: the shares, the nightly rebalance (scripts/rebalance.js) and the tally (scripts/paper-portfolio.js).
// Budgets live in data/paper/budgets.jsonl, one row per rebalance; an agent started with --budget=split reads the latest row on
// every pass (budgetOf), so a rebalance needs no restart. Paper only; no orders.
import { existsSync, readFileSync } from 'node:fs';
import { openLedger, PAPER_DIR } from './paper.js';
import { budgetedFills } from './mm.js';
import { readResearch } from './report.js';
import { projectPath } from './files.js';

export const START = Date.parse('2026-11-12T22:27:00Z'), SWITCH = Date.parse('2026-11-13T03:10:00Z'); // quoting counts from SWITCH
// The shares since Nov 14 (the map in README): each agent filled until its next $100 earns less than another's, on the history
// tests. Game-watch past ~$600 and quoting past 2 contracts ($593 of cash) earn the least per dollar; station-watch never used $120.
export const BASE = 2000, SPLIT = { 'game-watch': 640, quoting: 590, 'reward-maker': 500, 'station-watch': 120, reserve: 150 };
// Quoting's contracts a quote at time t: each budgets row records mm.quoteSize; 5 before rows carried it.
export const quoteSizeAt = (rows, t) => rows.filter(r => r.time <= t).at(-1)?.quoteSize ?? 5;
// Reward-maker is not moved: its cash is set by its --size and --markets, not by a budget.
const MOVABLE = ['game-watch', 'quoting', 'station-watch'], DAY_MS = 86400000;
export const BUDGETS = `${PAPER_DIR}/budgets.jsonl`, HELD = `${PAPER_DIR}/held.jsonl`;

const readRows = path => existsSync(projectPath(path)) ? readFileSync(projectPath(path), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
export const budgetRows = () => readRows(BUDGETS), heldRows = () => readRows(HELD);
// An agent's budget at time t: the last rebalance at or before t, or its SPLIT share before the first.
export const budgetAt = (rows, agent, t = Date.now()) => rows.filter(r => r.time <= t).at(-1)?.budgets?.[agent] ?? SPLIT[agent];
export const budgetOf = agent => budgetAt(budgetRows(), agent);

// The nightly rebalance. The bankroll (BASE plus every agent's P&L since START) is split by SPLIT's shares. With at least minDays
// of cash-held samples, an agent whose cash held never came within 90% of its budget in the last lookbackDays keeps 125% of its
// peak (at least a quarter of its share), and the cash it frees goes to the agents that did reach 90%, in proportion to their
// shares; with none, it stays in the reserve. An agent cut one night gets its full share back once it fills the smaller budget.
export function rebalance({ bankroll, previous = SPLIT, samples = [], now = Date.now(), minDays = 3, lookbackDays = 7 }) {
  const scale = bankroll / BASE, target = Object.fromEntries(Object.entries(SPLIT).map(([a, s]) => [a, s * scale]));
  const recent = samples.filter(s => s.time > now - lookbackDays * DAY_MS), span = recent.length ? (now - recent[0].time) / DAY_MS : 0;
  const budgets = { ...target }, round = () => Object.fromEntries(Object.entries(budgets).map(([a, b]) => [a, Math.round(b * 100) / 100]));
  if (span < minDays) return { budgets: round(), notes: [`${span.toFixed(1)} days of cash samples, ${minDays} needed: shares only`] };
  const starved = [], notes = [];
  let freed = 0;
  for (const a of MOVABLE) {
    const peak = recent.reduce((m, s) => Math.max(m, s.held?.[a] ?? 0), 0), cap = previous[a] ?? target[a];
    if (peak >= 0.9 * cap) { starved.push(a); continue; }
    budgets[a] = Math.min(target[a], Math.max(1.25 * peak, 0.25 * target[a]));
    freed += target[a] - budgets[a];
    notes.push(`${a} peaked at $${peak.toFixed(0)} of $${cap.toFixed(0)}`);
  }
  const weight = starved.reduce((w, a) => w + target[a], 0);
  if (weight > 0) for (const a of starved) budgets[a] += freed * target[a] / weight;
  else budgets.reserve += freed;
  if (freed > 0) notes.push(`$${freed.toFixed(0)} moved to ${starved.length ? starved.join(', ') : 'the reserve'}`);
  return { budgets: round(), notes };
}

const lastLogLine = path => { try { return JSON.parse(readFileSync(projectPath(path), 'utf8').trim().split('\n').filter(l => l.startsWith('{')).at(-1)); } catch { return null; } };

// What each agent made since START and the cash it holds now, under the budgets in force at each moment.
export function tally(now = Date.now()) {
  const rows = budgetRows(), current = agent => budgetAt(rows, agent, now);
  const out = ['game-watch', 'station-watch'].map(agent => {
    const ledger = openLedger(agent), trades = ledger.trades.filter(t => t.time >= START);
    const settled = trades.filter(t => ledger.settled.has(t.ticker)), pnl = settled.reduce((a, t) => a + ledger.settled.get(t.ticker), 0);
    const open = trades.filter(t => !ledger.settled.has(t.ticker)).reduce((a, t) => a + (t.price + t.fee) * (t.contracts ?? 1), 0);
    return { agent, budget: current(agent), trades: trades.length, contracts: trades.reduce((a, t) => a + (t.contracts ?? 1), 0), settled: settled.length, pnl, open };
  });
  const fills = readRows('data/maker/quoting-fills.jsonl').filter(f => f.time >= SWITCH), size = quoteSizeAt(rows, now);
  const q = budgetedFills(fills, t => quoteSizeAt(rows, t), t => budgetAt(rows, 'quoting', t), readResearch('data/maker/settlements.json', {}), { now });
  out.push({ agent: 'quoting', budget: current('quoting'), trades: q.taken, contracts: q.contracts, settled: q.settledFills, pnl: q.settledPnl, open: q.held,
    note: `learned policy at ${size} a quote, since ${new Date(SWITCH).toISOString().slice(0, 16)}; ${q.skipped} fills skipped for cash; first in line (an upper bound)` });
  const reward = lastLogLine(`${PAPER_DIR}/reward-maker.log`), money = x => (x < 0 ? '−$' : '$') + Math.abs(x).toFixed(2);
  out.push({ agent: 'reward-maker', budget: current('reward-maker'), trades: reward?.fills ?? 0, contracts: null, settled: null,
    pnl: reward ? reward.accrued + reward.settledPnl : 0, open: reward?.cash ?? 0,
    note: reward ? `rewards ${money(reward.accrued)} (paper estimate), fills settled ${money(reward.settledPnl)}, open marked ${money(reward.openMarked)}` : 'no log' });
  return { rows: out, total: out.reduce((a, r) => a + r.pnl, 0), reserve: current('reserve') };
}
