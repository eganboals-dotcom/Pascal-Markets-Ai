// Read-only Polymarket market data, used for reviewed cross-venue pairs.
async function getJson(url, signal = AbortSignal.timeout(15000)) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Polymarket HTTP ${response.status}`);
  return response.json();
}

export function fetchMarket(marketId, signal) {
  if (typeof marketId !== 'string' || !/^\d+$/.test(marketId)) throw new Error('Invalid market ID');
  return getJson(`https://gamma-api.polymarket.com/markets/${marketId}`, signal);
}

export async function fetchBook(assetId) {
  if (typeof assetId !== 'string' || !/^\d+$/.test(assetId)) throw new Error('Invalid outcome asset ID');
  return getJson(`https://clob.polymarket.com/book?token_id=${assetId}`);
}
