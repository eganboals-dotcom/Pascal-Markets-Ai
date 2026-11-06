import { createReadStream, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { projectPath, writeProjectFile } from './files.js';
import { OrderBooks } from './books.js';

export async function* readJsonLines(path) {
  const lines = createInterface({ input: createReadStream(projectPath(path)), crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber++;
    if (!line.trim()) continue;
    try { yield JSON.parse(line); }
    catch { throw new Error(`Invalid JSON on line ${lineNumber} in ${path}`); }
  }
}

export async function analyzeCapture(path) {
  const directory = projectPath(path);
  const summary = JSON.parse(readFileSync(projectPath(join(directory, 'summary.json')), 'utf8'));
  if (!Number.isFinite(summary.finishedAt)) throw new Error('Analyze a completed capture with a final summary');
  const catalog = JSON.parse(readFileSync(projectPath(join(directory, 'catalog.json')), 'utf8'));
  const assets = new Map();
  for (const market of catalog.markets) {
    assets.set(market.homeAssetId, { market, outcome: 'home' });
    assets.set(market.awayAssetId, { market, outcome: 'away' });
  }
  const books = new OrderBooks([...assets.keys()]);
  const output = projectPath(join(directory, 'quotes.jsonl'));
  const normalizedQuotes = [];
  const report = { markets: catalog.markets.length, frames: 0, bookMessages: 0, gaps: 0,
    invalidBooks: 0, reconstructedQuotes: 0, sportsUpdates: 0, futureSourceTimestamps: 0,
    completedWithoutStreamErrors: summary.streams.every(stream => stream.status === 'fulfilled'),
    invalidationMarkers: 0, latestBooks: {}, errors: [] };
  const ages = [];
  function invalidate(record, reason) {
    for (const [assetId, { market, outcome }] of assets) {
      normalizedQuotes.push(JSON.stringify({ gameId: market.gameId, marketId: market.marketId,
        assetId, outcome, sourceAt: record.receivedAt, receivedAt: record.receivedAt,
        ask: null, bid: null, askSize: 0, bidSize: 0, acceptingOrders: false, invalidated: true, reason }));
      report.invalidationMarkers++;
    }
  }
  for await (const record of readJsonLines(join(directory, 'books.jsonl'))) {
    report.frames++;
    if (record.kind === 'gap') { report.gaps++; invalidate(record, 'stream-gap'); }
    if (['connecting', 'end'].includes(record.kind)) invalidate(record, record.kind);
    if (record.kind === 'data') report.bookMessages++;
    let quotes;
    try { quotes = books.apply(record); }
    catch (error) {
      report.invalidBooks++;
      invalidate(record, 'invalid-book');
      if (report.errors.length < 10) report.errors.push({ at: record.receivedAt, error: error.message });
      continue;
    }
    for (const quote of quotes) {
      const { market, outcome } = assets.get(quote.assetId);
      const age = quote.receivedAt - quote.sourceAt;
      if (age < 0) { report.futureSourceTimestamps++; continue; }
      ages.push(age);
      const normalized = {
        ...quote, gameId: market.gameId, marketId: market.marketId, outcome,
        marketType: 'moneyline', includesOvertime: market.includesOvertime,
        acceptingOrders: market.acceptingOrders, secondsDelay: market.secondsDelay,
        minOrderSize: market.minOrderSize, tickSize: market.tickSize,
        feesEnabled: market.feesEnabled, feeSchedule: market.feeSchedule,
        rulesHash: market.rulesHash, metadataAt: catalog.recordedAt
      };
      normalizedQuotes.push(JSON.stringify(normalized));
      report.reconstructedQuotes++;
      report.latestBooks[quote.assetId] = normalized;
    }
  }
  for await (const record of readJsonLines(join(directory, 'sports.jsonl'))) {
    if (record.kind === 'data') report.sportsUpdates++;
  }
  ages.sort((a, b) => a - b);
  report.messageAgeMs = ages.length ? {
    minimum: ages[0], median: ages[Math.floor((ages.length - 1) * 0.5)],
    p95: ages[Math.floor((ages.length - 1) * 0.95)], maximum: ages.at(-1)
  } : null;
  report.quotesPath = output;
  writeProjectFile(output, normalizedQuotes.join('\n') + '\n');
  writeProjectFile(join(directory, 'analysis.json'), JSON.stringify(report, null, 2));
  return report;
}
