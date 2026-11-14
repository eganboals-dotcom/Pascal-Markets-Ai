import test from 'node:test';
import assert from 'node:assert/strict';
import { SPLIT, budgetAt, quoteSizeAt, rebalance } from '../src/portfolio.js';
import { budgetedFills } from '../src/mm.js';

const DAY = 86400000, now = 10 * DAY;
const samples = held => Array.from({ length: 5 }, (_, i) => ({ time: now - (4 - i) * DAY, held }));
const sum = b => Object.values(b).reduce((a, x) => a + x, 0), cents = x => Math.round(x * 100) / 100;

test('the rebalance splits the bankroll by the shares until three days of cash samples exist', () => {
  const r = rebalance({ bankroll: 2200, samples: samples({}).slice(-2), now });
  assert.equal(r.budgets['game-watch'], 704);
  assert.equal(r.budgets.reserve, 165);
  assert.ok(Math.abs(sum(r.budgets) - 2200) < 0.05);
});

test('cash an agent never came near goes to the agents that filled their budgets, and to the reserve when none did', () => {
  // Station-watch peaked at $60 of $120: it keeps $75 and frees $45. Game-watch and quoting both filled theirs.
  const full = { 'game-watch': 630, quoting: 580, 'station-watch': 60, 'reward-maker': 500 };
  const r = rebalance({ bankroll: 2000, samples: samples(full), now });
  assert.equal(r.budgets['station-watch'], 75);
  assert.equal(r.budgets['game-watch'], cents(640 + 45 * 640 / 1230));
  assert.equal(r.budgets.quoting, cents(590 + 45 * 590 / 1230));
  assert.equal(r.budgets['reward-maker'], 500);
  assert.ok(Math.abs(sum(r.budgets) - 2000) < 0.05);
  // Nobody filled: everything freed stays in the reserve. An idle agent keeps at least a quarter of its share.
  const idle = rebalance({ bankroll: 2000, samples: samples({ 'game-watch': 100, quoting: 0, 'station-watch': 0 }), now });
  assert.equal(idle.budgets['game-watch'], 160);
  assert.equal(idle.budgets.quoting, 147.5);
  assert.equal(idle.budgets.reserve, 150 + 480 + 442.5 + 90);
  // An agent cut last night that fills its smaller budget gets its whole share back.
  const back = rebalance({ bankroll: 2000, previous: { ...SPLIT, 'station-watch': 75 }, samples: samples({ ...full, 'station-watch': 70 }), now });
  assert.equal(back.budgets['station-watch'], 120);
});

test('budgets and quote size in force at a moment come from the last rebalance before it, and quoting fills follow them', () => {
  const rows = [{ time: 100, budgets: { quoting: 1 } }, { time: 200, budgets: { quoting: 3 }, quoteSize: 2 }];
  assert.equal(budgetAt(rows, 'quoting', 50), SPLIT.quoting);
  assert.equal(budgetAt(rows, 'quoting', 150), 1);
  assert.equal(quoteSizeAt(rows, 150), 5); // rows before quoteSize was recorded ran at 5
  assert.equal(quoteSizeAt(rows, 250), 2);
  const f = (time, ticker) => ({ ticker, time, side: 'buy', price: 0.5, fee: 0, feeRate: 0, available: 100, clv: 0, expiresAt: null });
  const t = budgetedFills([f(150, 'A'), f(250, 'B')], time => quoteSizeAt(rows, time), time => budgetAt(rows, 'quoting', time));
  assert.equal(t.contracts, 2 + 2); // $1 fits 2 at 50¢; at $3 the $2 left would fit 4, but B quotes 2
});
