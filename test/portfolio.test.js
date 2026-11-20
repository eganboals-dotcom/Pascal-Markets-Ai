import test from 'node:test';
import assert from 'node:assert/strict';
import { BASE, SPLIT, budgetAt, quoteSizeAt, rebalance } from '../src/portfolio.js';
import { budgetedFills } from '../src/mm.js';

const DAY = 86400000, now = 10 * DAY;
const samples = held => Array.from({ length: 5 }, (_, i) => ({ time: now - (4 - i) * DAY, held }));
const sum = b => Object.values(b).reduce((a, x) => a + x, 0), cents = x => Math.round(x * 100) / 100;

test('the shares add up to the bankroll, and the rebalance splits by them until three days of cash samples exist', () => {
  assert.equal(sum(SPLIT), BASE);
  const r = rebalance({ bankroll: 11000, samples: samples({}).slice(-2), now });
  assert.equal(r.budgets['game-watch'], cents(SPLIT['game-watch'] * 1.1));
  assert.equal(r.budgets.reserve, cents(SPLIT.reserve * 1.1));
  assert.ok(Math.abs(sum(r.budgets) - 11000) < 0.05);
});

test('cash an agent never came near goes to the agents that filled their budgets, and to the reserve when none did', () => {
  // Station-watch peaked at $50 of $100: it keeps $62.50 and frees $37.50. Game-watch, quoting and score-watch filled theirs.
  const S = SPLIT, full = { 'game-watch': S['game-watch'] - 10, quoting: S.quoting - 10, 'score-watch': S['score-watch'] - 10, 'station-watch': 50 };
  const r = rebalance({ bankroll: 10000, samples: samples(full), now }), weight = S['game-watch'] + S.quoting + S['score-watch'];
  assert.equal(r.budgets['station-watch'], 62.5);
  for (const a of ['game-watch', 'quoting', 'score-watch']) assert.equal(r.budgets[a], cents(S[a] + 37.5 * S[a] / weight), a);
  assert.ok(Math.abs(sum(r.budgets) - 10000) < 0.05);
  // Nobody filled: everything freed stays in the reserve. An idle agent keeps at least a quarter of its share.
  const idle = rebalance({ bankroll: 10000, samples: samples({ 'game-watch': 100, quoting: 0, 'station-watch': 0 }), now });
  for (const a of ['game-watch', 'quoting', 'score-watch', 'station-watch']) assert.equal(idle.budgets[a], S[a] / 4, a);
  assert.equal(idle.budgets.reserve, S.reserve + 0.75 * (S['game-watch'] + S.quoting + S['score-watch'] + S['station-watch']));
  // An agent cut last night that fills its smaller budget gets its whole share back.
  const back = rebalance({ bankroll: 10000, previous: { ...SPLIT, 'station-watch': 62.5 }, samples: samples({ ...full, 'station-watch': 60 }), now });
  assert.equal(back.budgets['station-watch'], 100);
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
  // A series with its own size (mention markets) runs it from the row that set it; other markets keep the row's quote size.
  const sized = [...rows, { time: 300, budgets: { quoting: 100 }, quoteSize: 2, seriesSizes: [{ pattern: '^KX[A-Z0-9]*MENTION(?!DURATION)', size: 7 }] }];
  const mention = 'KXTRUMPMENTION-26OCT09-CRYP', game = 'KXNBAGAME-26OCT09AB-A';
  assert.equal(quoteSizeAt(sized, 350, mention), 7);
  assert.equal(quoteSizeAt(sized, 350, 'KXTRUMPMENTIONDURATION-26OCT09-30'), 2);
  assert.equal(quoteSizeAt(sized, 350, game), 2);
  assert.equal(quoteSizeAt(sized, 350), 2);
  assert.equal(quoteSizeAt(sized, 250, mention), 2);
  assert.equal(quoteSizeAt([...sized, { time: 400, budgets: {}, quoteSize: 3 }], 450, mention), 7); // a later row without series sizes keeps them
  assert.equal(quoteSizeAt([...sized, { time: 400, budgets: {}, quoteSize: 3, seriesSizes: [] }], 450, mention), 3); // an empty list clears them
  assert.equal(budgetedFills([f(350, mention), f(360, game)], (time, ticker) => quoteSizeAt(sized, time, ticker), 100).contracts, 7 + 2);
});
