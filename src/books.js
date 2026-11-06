function number(value, name, minimum, maximum) {
  if ((typeof value !== 'string' && typeof value !== 'number') || value === '') throw new Error(`Invalid ${name}`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) throw new Error(`Invalid ${name}`);
  return parsed;
}

function levels(values) {
  if (!Array.isArray(values)) throw new Error('Missing book levels');
  const result = new Map();
  for (const level of values) {
    const price = number(level.price, 'price', 0.000001, 0.999999);
    const size = number(level.size, 'size', 0, Number.MAX_SAFE_INTEGER);
    if (result.has(price)) throw new Error('Duplicate price level');
    if (size > 0) result.set(price, size);
  }
  return result;
}

function best(book) {
  const bid = book.bids.size ? Math.max(...book.bids.keys()) : null;
  const ask = book.asks.size ? Math.min(...book.asks.keys()) : null;
  if (bid !== null && ask !== null && bid >= ask) throw new Error('Crossed order book');
  return { bid, ask, bidSize: book.bids.get(bid) ?? 0, askSize: book.asks.get(ask) ?? 0 };
}

export class OrderBooks {
  constructor(assetIds) {
    this.assets = new Set(assetIds);
    this.books = new Map();
    this.session = null;
  }

  apply(record) {
    const session = `${record.recordingId}:${record.session}`;
    if (session !== this.session || ['gap', 'connecting', 'connected', 'end'].includes(record.kind)) {
      this.books.clear();
      this.session = session;
    }
    if (record.kind !== 'data') return [];
    if (!Number.isFinite(record.receivedAt)) throw new Error('Invalid receipt timestamp');
    const event = record.payload;
    if (!['book', 'price_change', 'tick_size_change'].includes(event?.event_type)) return [];
    const changed = new Set();
    try {
      const sourceAt = number(event.timestamp, 'source timestamp', 1, Number.MAX_SAFE_INTEGER);
      if (event.event_type === 'book' && this.assets.has(event.asset_id)) {
        const previous = this.books.get(event.asset_id);
        if (previous && sourceAt < previous.sourceAt) return [];
        const book = { bids: levels(event.bids), asks: levels(event.asks), sourceAt, receivedAt: record.receivedAt };
        best(book);
        this.books.set(event.asset_id, book);
        changed.add(event.asset_id);
      }
      if (event.event_type === 'price_change') {
        if (!Array.isArray(event.price_changes)) throw new Error('Missing price changes');
        const expected = new Map();
        for (const change of event.price_changes) {
          const book = this.books.get(change.asset_id);
          if (!book || sourceAt < book.sourceAt) continue;
          const price = number(change.price, 'price', 0.000001, 0.999999);
          const size = number(change.size, 'size', 0, Number.MAX_SAFE_INTEGER);
          if (!['BUY', 'SELL'].includes(change.side)) throw new Error('Invalid book side');
          const side = change.side === 'BUY' ? book.bids : book.asks;
          if (size === 0) side.delete(price);
          else side.set(price, size);
          book.sourceAt = sourceAt;
          book.receivedAt = record.receivedAt;
          changed.add(change.asset_id);
          expected.set(change.asset_id, change);
        }
        for (const [assetId, change] of expected) {
          const top = best(this.books.get(assetId));
          if (change.best_bid !== undefined && Number(change.best_bid) !== (top.bid ?? 0)) throw new Error('Best bid disagrees with reconstructed book');
          if (change.best_ask !== undefined && Number(change.best_ask) !== (top.ask ?? 1)) throw new Error('Best ask disagrees with reconstructed book');
        }
      }
      if (event.event_type === 'tick_size_change') {
        // A new tick regime requires a fresh snapshot before using this asset again.
        this.books.delete(event.asset_id);
      }
      return [...changed].map(assetId => {
        const book = this.books.get(assetId);
        return { assetId, sourceAt: book.sourceAt, receivedAt: book.receivedAt, ...best(book) };
      });
    } catch (error) {
      // A partially applied or inconsistent batch must never leave a tradable book.
      this.books.clear();
      throw error;
    }
  }
}
