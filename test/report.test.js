import test from 'node:test';
import assert from 'node:assert/strict';
import { resultsReport, reportMarkdown } from '../src/report.js';
import { nearMissSummary, price } from '../src/scan.js';

test('small report fixture covers episodes, durations, outcomes, buckets and started games', () => {
  const now = Date.parse('2026-11-07T12:00:00Z');
  const hit = { id: 'a', kind: 'cross-venue', series: 'KXTEST', firstSeen: now - 10000, lastSeen: now, minDurationMs: 10000, legs: [{ gameStartAt: now - 20000 }] };
  const buckets = nearMissSummary([-0.03, -0.01, 0, 0.015, 0.03].map(profit => ({ profit, contracts: 1 })));
  const report = resultsReport([hit, { ...hit, minDurationMs: 20000 }], [{ outcome: 'filled' }, { outcome: 'skipped', reason: 'maker' }], { nearMissSummary: buckets }, now);
  assert.equal(report.bySeries.KXTEST, 2);
  assert.equal(report.hitsToday, 2);
  assert.deepEqual(report.lifetime[0], { id: 'a', medianMinDurationMs: 15000, maxMinDurationMs: 20000 });
  assert.equal(report.outcomes.filled, 1);
  assert.equal(report.skipReasons.maker, 1);
  assert.deepEqual(Object.values(buckets), [1, 1, 1, 1, 1]);
  assert.match(reportMarkdown(report), /Cross-venue games already started/);
  const basket = price('cross-venue', 'test', [{ venue: 'polymarket', ticker: 'p', price: 0.5, size: 1, closesAt: now + 86400000, gameStartAt: now - 1, fee: () => 0 }], 1, { now });
  assert.ok(basket.checks.includes('gameStarted'));
});
