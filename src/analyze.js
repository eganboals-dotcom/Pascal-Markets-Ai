import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { projectPath, writeProjectFile } from './files.js';
import { OrderBooks } from './books.js';

function termsKey(terms) {
  return JSON.stringify(terms && [terms.acceptingOrders, terms.secondsDelay, terms.minOrderSize,
    terms.tickSize, terms.feesEnabled, terms.feeSchedule?.rate, terms.feeSchedule?.exponent]);
}

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
  const marketMetadata = new Map();
  for (const market of catalog.markets) {
    assets.set(market.homeAssetId, { market, outcome: 'home' });
    assets.set(market.awayAssetId, { market, outcome: 'away' });
    marketMetadata.set(market.marketId, { terms: market, receivedAt: catalog.recordedAt, termsEpoch: catalog.recordedAt });
  }
  const metadata = [];
  const metadataPath = projectPath(join(directory, 'metadata.jsonl'));
  if (existsSync(metadataPath)) {
    for await (const snapshot of readJsonLines(metadataPath)) {
      if (!marketMetadata.has(snapshot.marketId) || !Number.isFinite(snapshot.receivedAt) ||
          snapshot.receivedAt < catalog.recordedAt || snapshot.receivedAt > summary.finishedAt ||
          (snapshot.terms !== null && typeof snapshot.terms?.acceptingOrders !== 'boolean')) {
        throw new Error('Invalid market metadata snapshot');
      }
      metadata.push(snapshot);
    }
    metadata.sort((a, b) => a.receivedAt - b.receivedAt);
  }
  const books = new OrderBooks([...assets.keys()]);
  const output = projectPath(join(directory, 'quotes.jsonl'));
  const normalizedQuotes = [];
  const report = { markets: catalog.markets.length, frames: 0, bookMessages: 0, gaps: 0,
    invalidBooks: 0, reconstructedQuotes: 0, sportsUpdates: 0, futureSourceTimestamps: 0,
    completedWithoutStreamErrors: summary.streams.every(stream => stream.status === 'fulfilled'),
    invalidationMarkers: 0, metadataUpdates: 0, metadataFailures: 0, latestBooks: {}, errors: [] };
  const ages = [];
  function invalidate(receivedAt, reason, marketId) {
    for (const [assetId, { market, outcome }] of assets) {
      if (marketId !== undefined && market.marketId !== marketId) continue;
      normalizedQuotes.push(JSON.stringify({ gameId: market.gameId, marketId: market.marketId,
        assetId, outcome, sourceAt: receivedAt, receivedAt,
        ask: null, bid: null, askSize: 0, bidSize: 0, acceptingOrders: false, invalidated: true, reason }));
      report.invalidationMarkers++;
    }
  }
  let nextMetadata = 0;
  function applyMetadata(through) {
    while (nextMetadata < metadata.length && metadata[nextMetadata].receivedAt <= through) {
      const snapshot = metadata[nextMetadata++];
      const previous = marketMetadata.get(snapshot.marketId);
      const changed = termsKey(previous.terms) !== termsKey(snapshot.terms);
      if (snapshot.terms === null) report.metadataFailures++;
      else report.metadataUpdates++;
      if (changed) invalidate(snapshot.receivedAt, 'market-metadata-changed', snapshot.marketId);
      marketMetadata.set(snapshot.marketId, { ...snapshot,
        termsEpoch: changed ? snapshot.receivedAt : previous.termsEpoch });
    }
  }
  for await (const record of readJsonLines(join(directory, 'books.jsonl'))) {
    applyMetadata(record.receivedAt);
    report.frames++;
    if (record.kind === 'gap') { report.gaps++; invalidate(record.receivedAt, 'stream-gap'); }
    if (['connecting', 'end'].includes(record.kind)) invalidate(record.receivedAt, record.kind);
    if (record.kind === 'data') report.bookMessages++;
    let quotes;
    try { quotes = books.apply(record); }
    catch (error) {
      report.invalidBooks++;
      invalidate(record.receivedAt, 'invalid-book');
      if (report.errors.length < 10) report.errors.push({ at: record.receivedAt, error: error.message });
      continue;
    }
    for (const quote of quotes) {
      const { market, outcome } = assets.get(quote.assetId);
      const { terms, receivedAt: metadataAt, termsEpoch } = marketMetadata.get(market.marketId);
      const age = quote.receivedAt - quote.sourceAt;
      if (age < 0) { report.futureSourceTimestamps++; continue; }
      ages.push(age);
      const normalized = {
        ...quote, gameId: market.gameId, marketId: market.marketId, outcome,
        marketType: 'moneyline', includesOvertime: market.includesOvertime,
        acceptingOrders: terms?.acceptingOrders === true, secondsDelay: terms?.secondsDelay,
        minOrderSize: terms?.minOrderSize, tickSize: terms?.tickSize,
        feesEnabled: terms?.feesEnabled, feeSchedule: terms?.feeSchedule,
        rulesHash: market.rulesHash, metadataAt, termsEpoch
      };
      normalizedQuotes.push(JSON.stringify(normalized));
      report.reconstructedQuotes++;
      report.latestBooks[quote.assetId] = normalized;
    }
  }
  applyMetadata(summary.finishedAt);
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
