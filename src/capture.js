import { appendFileSync, mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { dirname, join } from 'node:path';
import { discoverNba, fetchMarket, recordBooks, recordSports } from './polymarket.js';
import { nbaMoneylines, refreshedTerms } from './catalog.js';
import { projectPath, writeProjectFile } from './files.js';

async function recordMetadata(path, markets, signal) {
  let updates = 0;
  let failures = 0;
  while (!signal.aborted) {
    try { await sleep(20000, undefined, { signal }); }
    catch (error) { if (signal.aborted) break; throw error; }
    const snapshots = await Promise.all(markets.map(async market => {
      let terms;
      try {
        const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(10000)]);
        terms = refreshedTerms(market, await fetchMarket(market.marketId, requestSignal));
      } catch { terms = null; }
      return { marketId: market.marketId, receivedAt: Date.now(), terms };
    }));
    if (signal.aborted) break;
    for (const snapshot of snapshots) {
      appendFileSync(path, JSON.stringify(snapshot) + '\n');
      if (snapshot.terms) updates++;
      else failures++;
    }
  }
  return { updates, failures };
}

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
  const stopMetadata = new AbortController();
  const metadata = recordMetadata(projectPath(join(directory, 'metadata.jsonl')), markets, stopMetadata.signal)
    .catch(error => ({ error: error.message }));
  const streams = await Promise.allSettled([
    Promise.resolve().then(() => recordSports(join(directory, 'sports.jsonl'), durationSeconds)),
    Promise.resolve().then(() => recordBooks(join(directory, 'books.jsonl'), assetIds, durationSeconds))
  ]);
  stopMetadata.abort();
  const result = {
    startedAt, finishedAt: Date.now(), directory,
    markets: markets.map(({ gameId, title, marketId }) => ({ gameId, title, marketId })),
    metadata: await metadata,
    streams: streams.map((stream, index) => ({
      source: index === 0 ? 'sports' : 'books',
      status: stream.status,
      ...stream.status === 'fulfilled' ? stream.value : { error: stream.reason.message }
    }))
  };
  writeProjectFile(join(directory, 'summary.json'), JSON.stringify(result, null, 2));
  return result;
}
