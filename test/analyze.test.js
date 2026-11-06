import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyzeCapture } from '../src/analyze.js';
import { writeProjectFile, projectPath } from '../src/files.js';
import { buildReplayDataset } from '../src/dataset.js';

test('capture analysis carries gap invalidation into the replay dataset', async () => {
  const directory = 'data/test-analysis';
  writeProjectFile(`${directory}/summary.json`, JSON.stringify({ finishedAt: 5000, streams: [{ status: 'fulfilled' }] }));
  writeProjectFile(`${directory}/catalog.json`, JSON.stringify({ recordedAt: 500, markets: [{
    gameId: 'g', marketId: 'm', homeAssetId: '1', awayAssetId: '2', includesOvertime: true,
    acceptingOrders: true, secondsDelay: 3
  }] }));
  const rows = [
    { kind: 'data', receivedAt: 1100, payload: { event_type: 'book', asset_id: '1', timestamp: '1000',
      bids: [{ price: '0.4', size: '10' }], asks: [{ price: '0.5', size: '10' }] } },
    { kind: 'gap', receivedAt: 1500, payload: {} },
    { kind: 'data', receivedAt: 1700, payload: { event_type: 'price_change', timestamp: '1600',
      price_changes: [{ asset_id: '1', side: 'SELL', price: '0.5', size: '20' }] } }
  ].map(row => ({ recordingId: 'fixture', session: 1, ...row }));
  writeProjectFile(`${directory}/books.jsonl`, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  writeProjectFile(`${directory}/sports.jsonl`, '');
  const result = await analyzeCapture(directory);
  assert.equal(result.reconstructedQuotes, 1);
  assert.equal(result.gaps, 1);
  assert.equal(result.invalidationMarkers, 2);
  const quotes = readFileSync(projectPath(`${directory}/quotes.jsonl`), 'utf8').trim().split('\n').map(JSON.parse);
  const dataset = buildReplayDataset(quotes, [{ gameId: 'g', receivedAt: 1600, homeOdds: 1.5, awayOdds: 3 }],
    [{ gameId: 'g', resolvedAt: 10000, homeWon: 1, source: 'fixture', verified: true }]);
  assert.equal(dataset.observations[0].quote.invalidated, true);
  assert.equal(dataset.observations[0].quote.acceptingOrders, false);
});

test('atomic file replacement leaves valid content after repeat writes', () => {
  const path = 'data/test-atomic.json';
  writeProjectFile(path, JSON.stringify({ version: 1 }));
  writeProjectFile(path, JSON.stringify({ version: 2 }));
  assert.deepEqual(JSON.parse(readFileSync(projectPath(path), 'utf8')), { version: 2 });
});
