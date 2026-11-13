// The paper split's nightly rebalance: node scripts/rebalance.js [--every-minutes=5] [--once]. Every few minutes it records each
// agent's cash held (data/paper/held.jsonl); on its first pass of each Pacific calendar day (midnight PST or PDT, within one pass)
// it writes a new budgets row (rebalance in src/portfolio.js), which agents started with --budget=split read on their next pass.
// Paper only; no orders.
import { appendFileSync, mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { projectPath } from '../src/files.js';
import { PAPER_DIR } from '../src/paper.js';
import { BASE, BUDGETS, HELD, SPLIT, budgetRows, heldRows, rebalance, tally } from '../src/portfolio.js';

const option = (name, fallback) => Number(process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback);
const everyMs = option('every-minutes', 5) * 60000, once = process.argv.includes('--once');
const say = fields => console.log(JSON.stringify({ time: new Date().toISOString(), ...fields }));
const append = (path, row) => appendFileSync(projectPath(path), JSON.stringify(row) + '\n');
const pacificDay = ms => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(ms); // YYYY-MM-DD
mkdirSync(projectPath(PAPER_DIR), { recursive: true });

function pass(now = Date.now()) {
  const t = tally(now), held = Object.fromEntries(t.rows.map(r => [r.agent, Math.round(r.open * 100) / 100]));
  append(HELD, { time: now, held });
  const last = budgetRows().at(-1), day = pacificDay(now);
  if (last?.day === day) return say({ held });
  const bankroll = Math.round((BASE + t.total) * 100) / 100, r = rebalance({ bankroll, previous: last?.budgets ?? SPLIT, samples: heldRows(), now });
  append(BUDGETS, { time: now, day, bankroll, budgets: r.budgets, notes: r.notes });
  say({ rebalanced: day, bankroll, budgets: r.budgets, notes: r.notes });
}

say({ started: true, everyMinutes: everyMs / 60000 });
for (;;) {
  try { pass(); } catch (error) { console.error(JSON.stringify({ time: new Date().toISOString(), error: error.message })); } // the next pass retries
  if (once) break;
  await sleep(everyMs);
}
