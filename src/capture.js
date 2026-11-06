import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { discoverNba, recordBooks, recordSports } from './polymarket.js';
import { nbaMoneylines } from './catalog.js';
import { projectPath, writeProjectFile } from './files.js';

export async function capture(path, durationSeconds = 60) {
  if (!Number.isFinite(durationSeconds) || durationSeconds < 1 || durationSeconds > 86400) {
    throw new Error('Capture duration must be between 1 and 86400 seconds');
  }
  const directory = projectPath(path);
  const startedAt = Date.now();
  const markets = nbaMoneylines(await discoverNba()).filter(market =>
    market.acceptingOrders && market.includesOvertime &&
    market.startsAt > startedAt - 4 * 3600000 && market.startsAt < startedAt + 6 * 3600000
  ).slice(0, 6);
  if (!markets.length) throw new Error('No eligible NBA moneylines near the current time');
  mkdirSync(dirname(directory), { recursive: true });
  mkdirSync(directory);
  writeProjectFile(join(directory, 'catalog.json'), JSON.stringify({ recordedAt: Date.now(), markets }, null, 2));
  const assetIds = markets.flatMap(market => [market.homeAssetId, market.awayAssetId]);
  const streams = await Promise.allSettled([
    recordSports(projectPath(join(directory, 'sports.jsonl')), durationSeconds),
    recordBooks(projectPath(join(directory, 'books.jsonl')), assetIds, durationSeconds)
  ]);
  const result = {
    startedAt, finishedAt: Date.now(), directory,
    markets: markets.map(({ gameId, title, marketId }) => ({ gameId, title, marketId })),
    streams: streams.map((stream, index) => ({
      source: index === 0 ? 'sports' : 'books',
      status: stream.status,
      ...stream.status === 'fulfilled' ? stream.value : { error: stream.reason.message }
    }))
  };
  writeProjectFile(join(directory, 'summary.json'), JSON.stringify(result, null, 2));
  return result;
}
