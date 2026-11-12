import test from 'node:test';
import assert from 'node:assert/strict';
import { bestSetting, profitToRisk, walkForward } from '../src/tuner.js';

// Ten days of one group, one event a day. Setting 0.01 wins 2¢ on 98¢ most days but loses big once (day 3); 0.03 wins 1¢ on 96¢
// every day; group B only ever loses.
const days = Array.from({ length: 10 }, (_, i) => `2026-10-${String(i + 1).padStart(2, '0')}`);
const trades = days.flatMap((day, i) => [
  { day, group: 'A', setting: 0.01, ticker: `KXA-${i}-X`, pnl: i === 2 ? -0.98 : 0.02, stake: 0.98 },
  { day, group: 'A', setting: 0.03, ticker: `KXA-${i}-X`, pnl: 0.01, stake: 0.96 },
  { day, group: 'B', setting: 0.01, ticker: `KXB-${i}-X`, pnl: -0.05, stake: 0.5 },
]);

test('profit-to-risk divides the low end of the profit range by the money staked', () => {
  const steady = profitToRisk(trades.filter(t => t.group === 'A' && t.setting === 0.03));
  assert.equal(steady.events, 10);
  assert.ok(Math.abs(steady.score - 0.1 / 9.6) < 1e-9); // no spread at all, so the low end is the total
  const risky = profitToRisk(trades.filter(t => t.group === 'A' && t.setting === 0.01));
  assert.ok(risky.pnl < 0 && risky.score < 0);
  assert.equal(risky.worstEvent, -0.98);
  // Events default to the ticker's event part; an event field groups markets of one game together.
  assert.equal(profitToRisk([{ ticker: 'X-G1-A', pnl: 1, stake: 1 }, { ticker: 'X-G1-B', pnl: 1, stake: 1 }]).events, 1);
  assert.equal(profitToRisk([{ ticker: 'X-A-1', event: 'g', pnl: 1, stake: 1 }, { ticker: 'X-B-1', event: 'g', pnl: 1, stake: 1 }]).events, 1);
});

test('the best setting needs enough events and a score above zero', () => {
  assert.equal(bestSetting(trades.filter(t => t.group === 'A'), { minEvents: 10 }).setting, 0.03);
  assert.equal(bestSetting(trades.filter(t => t.group === 'A'), { minEvents: 11 }), null); // too few events
  assert.equal(bestSetting(trades.filter(t => t.group === 'B'), { minEvents: 1 }), null); // never profitable
});

test('each day is traded with the setting chosen from the days before it only', () => {
  const walk = walkForward(trades, { minEvents: 3 });
  // Days 1 to 3 have fewer than 3 earlier events, so nothing is traded; from day 4 group A runs 0.03 (0.01 lost on day 3) and B never runs.
  assert.deepEqual(walk.choices.filter(c => c.group === 'A').map(c => c.setting), [null, null, null, 0.03, 0.03, 0.03, 0.03, 0.03, 0.03, 0.03]);
  assert.ok(walk.choices.filter(c => c.group === 'B').every(c => c.setting === null));
  assert.equal(walk.taken.length, 7);
  assert.ok(walk.taken.every(t => t.group === 'A' && t.setting === 0.03 && t.day >= days[3]));
  assert.equal(walk.next.A.setting, 0.03);
  assert.equal(walk.next.B, null);
  // A later day's trades never change an earlier day's choice.
  const changed = trades.map(t => (t.day === days[9] ? { ...t, pnl: t.setting === 0.03 ? -5 : 5 } : t));
  assert.deepEqual(walkForward(changed, { minEvents: 3 }).choices.slice(0, -2), walk.choices.slice(0, -2));
});

test('live agents run the picked margin, the fallback without enough history, and nothing where the history says it loses', async () => {
  const { pickedMargin } = await import('../src/tuner.js');
  const report = { agents: { 'game-watch': { next: { 'KXNBAREB yes': { pick: 0.03 }, 'KXNBAPTS yes': { pick: 'off' }, 'KXNBAAST yes': { pick: 'default' } } } } };
  assert.equal(pickedMargin(report, 'game-watch', 'KXNBAREB yes', 0.01), 0.03);
  assert.equal(pickedMargin(report, 'game-watch', 'KXNBAPTS yes', 0.01), null);
  assert.equal(pickedMargin(report, 'game-watch', 'KXNBAAST yes', 0.01), 0.01);
  assert.equal(pickedMargin(report, 'game-watch', 'KXNHLGOAL yes', 0.01), 0.01); // not in the report
  assert.equal(pickedMargin(null, 'station-watch', 'KXHIGHNY', 0.01), 0.01); // no report yet
});

test('ranking by the low end in dollars prefers many thin trades over a few fat ones', () => {
  const rows = Array.from({ length: 20 }, (_, i) => [
    { day: 'd', group: 'G', setting: 0.01, ticker: `K-${i}-X`, pnl: 0.02, stake: 0.98 },
    ...(i < 5 ? [{ day: 'd', group: 'G', setting: 0.05, ticker: `K-${i}-X`, pnl: 0.05, stake: 0.94 }] : [])]).flat();
  assert.equal(bestSetting(rows, { quick: false, minEvents: 5 }).setting, 0.05); // 5.3% on stake against 2.0%
  assert.equal(bestSetting(rows, { quick: false, minEvents: 5, objective: 'low' }).setting, 0.01); // 20 x 2¢ = 40¢ against 5 x 5¢ = 25¢
});
