import test from 'node:test';
import assert from 'node:assert/strict';
import { lastPoint, polyFair, pregame } from '../src/agents/poly-signal.js';
import { take } from '../src/takers.js';

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test('the fair value is the average of the ask for X and one minus the ask for the other team, from either side', () => {
  const point = { time: 1000, longPrice: 0.6, shortPrice: 0.41 };
  near(polyFair(point, true, 1000), 0.595);
  near(polyFair(point, false, 1000), 0.405);
});

test('a stale point or a wide Polymarket book gives no fair value', () => {
  assert.equal(polyFair({ time: 0, longPrice: 0.6, shortPrice: 0.41 }, true, 90001), null);
  assert.equal(polyFair({ time: 0, longPrice: 0.6, shortPrice: 0.45 }, true, 0), null); // asks sum to 1.05
  assert.equal(polyFair({ time: 0, longPrice: 0, shortPrice: 0.9 }, true, 0), null);
  assert.equal(polyFair(null, true, 0), null);
});

test('only pregame, within 24 hours of the start; the newest point is read in milliseconds', () => {
  const start = 100 * 3600000;
  assert.equal(pregame(start, start - 3600000), true);
  assert.equal(pregame(start, start), false);
  assert.equal(pregame(start, start - 25 * 3600000), false);
  assert.deepEqual(lastPoint({ history: [{ timestamp: 20, longPrice: 0.5, shortPrice: 0.52 }, { timestamp: 10, longPrice: 0.4, shortPrice: 0.6 }] }),
    { time: 20000, longPrice: 0.5, shortPrice: 0.52 });
  assert.equal(lastPoint({ history: [] }), null);
});

test('a Kalshi ask 5¢ under the Polymarket mid is bought; 1¢ under is not', () => {
  const fair = polyFair({ time: 0, longPrice: 0.6, shortPrice: 0.41 }, true, 0); // 59.5¢
  assert.equal(take(fair, { yesBid: 0.53, yesAsk: 0.54 }, { margin: 0.01 }).side, 'yes');
  assert.equal(take(fair, { yesBid: 0.57, yesAsk: 0.585 }, { margin: 0.01 }), null);
});
