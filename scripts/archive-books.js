// Rebuilds a game's home-outcome quotes from rows written by scripts/archive_extract.py.
import { existsSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { OrderBooks } from '../src/books.js';
import { projectPath } from '../src/files.js';

// Conservative: closed markets now report mixed fee rates, so every fill pays the 5% taker rate seen live.
export const FEE_SCHEDULE = { exponent: 1, rate: 0.05, takerOnly: true };

export async function quotesFor(extractDir, market) {
  const path = projectPath(join(extractDir, `${market.gameId}.jsonl`));
  if (!existsSync(path)) return null;
  const books = new OrderBooks([market.homeAssetId]);
  const quotes = [];
  let batch = null;
  let errors = 0;
  let last = '';
  const terms = { gameId: market.gameId, marketId: market.marketId, outcome: 'home', marketType: 'moneyline',
    includesOvertime: market.includesOvertime, acceptingOrders: true, secondsDelay: market.secondsDelay ?? 0,
    minOrderSize: market.minOrderSize, tickSize: market.tickSize, feesEnabled: true, feeSchedule: FEE_SCHEDULE,
    rulesHash: market.rulesHash };
  const emit = record => {
    let changed;
    try { changed = books.apply(record); }
    catch {
      errors++;
      quotes.push({ ...terms, assetId: market.homeAssetId, sourceAt: record.receivedAt, receivedAt: record.receivedAt,
        ask: null, bid: null, askSize: 0, bidSize: 0, invalidated: true });
      last = '';
      return;
    }
    for (const quote of changed) {
      const key = `${quote.bid}|${quote.ask}|${quote.askSize}`;
      if (key === last) continue; // only top-of-book changes matter to replay
      last = key;
      quotes.push({ ...terms, ...quote });
    }
  };
  const flush = () => { if (batch) emit(batch); batch = null; };
  const level = ([price, size]) => ({ price, size });
  for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) {
    const [type, sourceAt, receivedAt, ...rest] = JSON.parse(line);
    const base = { kind: 'data', recordingId: 'archive', session: 1, receivedAt };
    if (type === 'p') {
      const [price, size, side, bestBid, bestAsk] = rest;
      const change = { asset_id: market.homeAssetId, price, size, side,
        ...(bestBid !== null && { best_bid: bestBid }), ...(bestAsk !== null && { best_ask: bestAsk }) };
      // Archive rows are one level each; rows sharing both timestamps came from one feed message.
      if (batch && batch.payload.timestamp === sourceAt && batch.receivedAt === receivedAt) batch.payload.price_changes.push(change);
      else { flush(); batch = { ...base, payload: { event_type: 'price_change', timestamp: sourceAt, price_changes: [change] } }; }
      continue;
    }
    flush();
    if (type === 'b') emit({ ...base, payload: { event_type: 'book', timestamp: sourceAt, asset_id: market.homeAssetId,
      bids: rest[0].map(level), asks: rest[1].map(level) } });
    else emit({ ...base, payload: { event_type: 'tick_size_change', timestamp: sourceAt, asset_id: market.homeAssetId } });
  }
  flush();
  return { quotes, errors };
}
