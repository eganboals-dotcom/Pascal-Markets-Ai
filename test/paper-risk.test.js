import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { confirmOpposite, exitQuote, openLedger } from '../src/paper.js';
import { kalshiFee } from '../src/kalshi.js';
import { projectPath } from '../src/files.js';

test('two fresh opposite decisions are required; uncertainty or a recovered thesis resets the count', () => {
  const state = new Map(), t = { ticker: 'A', side: 'yes' };
  assert.equal(confirmOpposite(state, t, { side: 'no' }, 1), false);
  assert.equal(confirmOpposite(state, t, { side: 'no' }, 1), false);
  assert.equal(confirmOpposite(state, t, null, 2), false);
  assert.equal(confirmOpposite(state, t, { side: 'no' }, 3), false);
  assert.equal(confirmOpposite(state, t, { side: 'yes' }, 4), false);
  assert.equal(confirmOpposite(state, t, { side: 'no' }, 5), false);
  assert.equal(confirmOpposite(state, t, { side: 'no' }, 6), true);
});

test('exit quotes use the correct bid, actual size and order-level fee for both sides', () => {
  const m = { yes_bid_dollars: '0.2', yes_ask_dollars: '0.7', yes_bid_size_fp: '25', yes_ask_size_fp: '30', fee_multiplier: 2 };
  for (const side of ['yes', 'no']) {
    const t = { side, contracts: 25 }, q = exitQuote(t, m);
    assert.ok(Math.abs(q.value - (side === 'yes' ? 0.2 : 0.3)) < 1e-9);
    assert.equal(q.fee * 25, kalshiFee(25, q.value, 0.14));
    assert.equal(exitQuote({ ...t, contracts: 31 }, m), null);
  }
  assert.equal(exitQuote({ side: 'no' }, {}), null);
  assert.equal(exitQuote({ side: 'yes' }, { ...m, yes_bid_dollars: 'NaN' }), null);
  assert.equal(exitQuote({ side: 'yes' }, { ...m, yes_bid_size_fp: 0 }), null);
});

test('loss breaker triggers at $25 gross despite winners and lasts 24 hours across reloads', () => {
  const dir = 'work/paper-risk-' + randomUUID(), hour = 3600000, group = t => t.league;
  try {
    const ledger = openLedger('game-watch', { dir });
    const close = (ticker, price, value, contracts, time) => {
      const t = { ticker, league: ticker, side: 'yes', price, fee: 0, contracts };
      ledger.record(t); assert.equal(ledger.exit(t, value, 0, time * hour), true); return t;
    };
    close('loss1', 0.9, 0.4, 20, 1); // -10
    close('winner', 0.1, 0.9, 100, 2); // +80 cannot erase a loss limit
    const last = close('loss2', 0.9, 0.3, 25, 23); // -15, exactly $25 gross
    assert.equal(ledger.breaker(group, { now: 23 * hour }).stopped, true);
    assert.equal(ledger.breaker(group, { now: 25 * hour }).stopped, true); // first loss rolled out
    assert.equal(ledger.breaker(group, { now: 46 * hour }).stopped, true);
    assert.equal(openLedger('game-watch', { dir }).breaker(group, { now: 46 * hour }).stopped, true);
    assert.equal(ledger.breaker(group, { now: 47 * hour }).stopped, false);
    assert.equal(ledger.breaker(group, { now: 3 * hour }).paused.has('loss2'), false); // no future leakage
    assert.equal(ledger.breaker(group, { now: 3 * hour }).paused.has('winner'), true); // any exit pauses
    const pnl = ledger.pnl();
    assert.equal(ledger.exit(last, 0.1, 0, 24 * hour), false); // idempotent; cannot overwrite exit
    assert.equal(ledger.pnl(), pnl);
  } finally { rmSync(projectPath(dir), { recursive: true, force: true }); }
});
