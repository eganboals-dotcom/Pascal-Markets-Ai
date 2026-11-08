import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { recentRecords, dashboardData } from '../src/dashboard-data.js';
import { projectPath, writeProjectFile } from '../src/files.js';

test('recent telemetry reads only a bounded tail and tolerates an incomplete final write', t => {
  const file = `work/dashboard-tail-${randomUUID()}.jsonl`;
  t.after(() => rmSync(projectPath(file), { force: true }));
  const lines = Array.from({ length: 100 }, (_, i) => JSON.stringify({ index: i }));
  writeProjectFile(file, lines.join('\n') + '\n{"unfinished":');
  const tail = recentRecords(file, 3, 100);
  assert.deepEqual(tail, [{ index: 97 }, { index: 98 }, { index: 99 }]);
  assert.deepEqual(recentRecords(`work/missing-${randomUUID()}.jsonl`), []);
});

test('price checks stay distinct from model positions and realized profit', () => {
  const data = dashboardData({ checks: [
    { outcome: 'filled', expectedProfit: 900, title: '<script>unsafe</script>', orders: [{ side: 'yes', ticker: 'X', count: 2 }], secret: 'omit' },
    { outcome: 'legged' }, { outcome: 'skipped', reason: 'budget' }],
    rounds: [{ at: '2026-11-07T09:00:00Z', tier: 'latency', p95: 2 }, { at: 'invalid' }],
    mm: { generatedAt: 123, markets: [{ ticker: 'A', inventory: 2, netPnl: -.5 }, { ticker: 'B', inventory: 0 }] }
  });
  assert.equal(data.account.connected, false);
  assert.equal(data.positions.length, 1);
  assert.equal(data.positions[0].source, 'simulator');
  assert.equal(data.positions[0].netPnl, -.5);
  assert.equal(data.outcomes.filled, 1); assert.equal(data.outcomes.legged, 1);
  assert.equal(data.activity.length, 1); assert.equal(data.activity[0].edge, null);
  assert.equal(JSON.stringify(data).includes('secret'), false);
  assert.equal(data.trades.at(-1).expectedProfit, 900);
});
