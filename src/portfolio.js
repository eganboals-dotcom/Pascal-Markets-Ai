// The paper test's split: the shares, the nightly rebalance (scripts/rebalance.js) and the tally (scripts/paper-portfolio.js).
// Budgets live in data/paper/budgets.jsonl, one row per rebalance; an agent started with --budget=split reads the latest row on
// every pass (budgetOf), so a rebalance needs no restart. Paper only; no orders.
import { existsSync, readFileSync } from 'node:fs';
import { openLedger, PAPER_DIR } from './paper.js';
import { budgetedFills, quoteSizeFor } from './mm.js';
import { readResearch } from './report.js';
import { projectPath } from './files.js';

export const START = Date.parse('2026-11-12T22:27:00Z'), SWITCH = Date.parse('2026-11-13T03:10:00Z'); // quoting counts from SWITCH
// The bankroll was $2,000 until Nov 14, 02:45 UTC and is $10,000 since; P&L still counts from START. The shares follow the review
// in README: quoting at 10 contracts needs about $2,800 (since Nov 14, taken from game-watch, which never used more than $3,066), score-watch joins with $300, station-watch rarely finds a trade live, 7.5%
// stays in reserve, and the rest goes to game-watch, whose books hold far more than its old 25-contract cap. Reward-maker runs
// outside the split until its rewards are shown to beat its fills.
export const BASE = 10000, SPLIT = { 'game-watch': 6050, quoting: 2800, 'score-watch': 300, 'station-watch': 100, reserve: 750 };
// An agent that joined later counts its P&L and cash from then, not from START.
export const JOINED = { 'score-watch': Date.parse('2026-11-14T02:45:00Z') };
// Quoting's contracts a quote at time t (for a ticker, when given): each budgets row records mm.quoteSize and mm.seriesSizes; 5
// before rows carried a size.
export function quoteSizeAt(rows, t, ticker) {
  const row = rows.filter(r => r.time <= t).at(-1);
  return quoteSizeFor({ quoteSize: row?.quoteSize ?? 5, seriesSizes: row?.seriesSizes }, ticker);
}
const MOVABLE = ['game-watch', 'quoting', 'station-watch', 'score-watch'], DAY_MS = 86400000;
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

// What each agent made since START and the cash it holds now, under the budgets in force at each moment.
export function tally(now = Date.now()) {
  const rows = budgetRows(), current = agent => budgetAt(rows, agent, now);
  const out = ['game-watch', 'station-watch', 'score-watch'].map(agent => {
    const ledger = openLedger(agent), trades = ledger.trades.filter(t => t.time >= (JOINED[agent] ?? START));
    const settled = trades.filter(t => ledger.settled.has(t.ticker)), pnl = settled.reduce((a, t) => a + ledger.settled.get(t.ticker), 0);
    const open = trades.filter(t => !ledger.settled.has(t.ticker)).reduce((a, t) => a + (t.price + t.fee) * (t.contracts ?? 1), 0);
    return { agent, budget: current(agent), trades: trades.length, contracts: trades.reduce((a, t) => a + (t.contracts ?? 1), 0), settled: settled.length, pnl, open };
  });
  const fills = readRows('data/maker/quoting-fills.jsonl').filter(f => f.time >= SWITCH), size = quoteSizeAt(rows, now);
  const q = budgetedFills(fills, (t, ticker) => quoteSizeAt(rows, t, ticker), t => budgetAt(rows, 'quoting', t), readResearch('data/maker/settlements.json', {}), { now });
  const larger = (rows.filter(r => r.time <= now).at(-1)?.seriesSizes ?? []).map(s => ` (${s.size} on ${s.label ?? s.pattern})`).join('');
  out.push({ agent: 'quoting', budget: current('quoting'), trades: q.taken, contracts: q.contracts, settled: q.settledFills, pnl: q.settledPnl, open: q.held,
    note: `learned policy at ${size} a quote${larger}, since ${new Date(SWITCH).toISOString().slice(0, 16)}; ${q.skipped} fills skipped for cash; first in line (an upper bound)` });
  return { rows: out, total: out.reduce((a, r) => a + r.pnl, 0), reserve: current('reserve') };
}
