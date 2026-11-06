import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchNbaOdds, normalizeSportsbook } from '../src/sportsbook.js';
import { compareQuotes } from '../src/compare.js';
import { takerFeePerShare } from '../src/fees.js';

const time = Date.parse('2026-11-06T02:00:00Z');
const mapping = { gameId: '1', marketId: '2', providerGameId: 'provider-1', homeTeam: 'Phoenix Suns',
  awayTeam: 'Orlando Magic', bookmaker: 'test', startsAt: time, rulesHash: 'rules', reviewed: true, includesOvertime: true };
function snapshot() {
  return { receivedAt: time, events: [{ id: 'provider-1', sport_key: 'basketball_nba',
    commence_time: '2026-11-06T02:00:00Z', home_team: 'Phoenix Suns', away_team: 'Orlando Magic',
    bookmakers: [{ key: 'test', last_update: '2026-11-06T01:59:59Z', markets: [
      { key: 'h2h', outcomes: [{ name: 'Phoenix Suns', price: 1.5 }, { name: 'Orlando Magic', price: 3 }] }
    ] }] }] };
}
const catalog = { recordedAt: time, markets: [{ gameId: '1', marketId: '2', startsAt: time,
  homeTeam: 'Suns', awayTeam: 'Magic', rulesHash: 'rules', includesOvertime: true,
  homeAssetId: '123', acceptingOrders: true, feesEnabled: true, feeSchedule: { rate: 0.05, exponent: 1 } }] };
const quotes = [{ assetId: '123', receivedAt: time, sourceAt: time, ask: 0.5, askSize: 100 }];
const policy = { maxAgeMs: 2000, maxMetadataAgeMs: 60000, minEdge: 0.04 };

test('normalization keeps source time and unknown suspension status', () => {
  const normalized = normalizeSportsbook(snapshot(), mapping);
  assert.equal(normalized.homeProbability, 2 / 3);
  assert.equal(normalized.sourceAt, time - 1000);
  assert.equal(normalized.timestampBasis, 'bookmaker');
  assert.equal(normalized.suspended, null);
  assert.throws(() => normalizeSportsbook(snapshot(), { ...mapping, homeTeam: 'Orlando Magic' }), /does not match/);
});

test('comparison reports a price difference but blocks unknown suspension status', () => {
  const result = compareQuotes(catalog, quotes, snapshot(), [mapping], policy, time).results[0];
  assert.ok(result.netGap > 0.1);
  assert.equal(result.feePerShare, 0.0125);
  assert.equal(result.eligibleForPaper, false);
  assert.deepEqual(result.blockers, ['sportsbook-suspension-status-unavailable-or-suspended']);
});

test('comparison rejects stale feeds, swapped teams and changed contract rules', () => {
  const stale = compareQuotes(catalog, quotes, snapshot(), [mapping], policy, time + 100000).results[0];
  assert.ok(stale.blockers.includes('stale-market-metadata'));
  assert.ok(stale.blockers.includes('stale-or-invalid-sportsbook-timestamp'));
  const changed = compareQuotes(catalog, quotes, snapshot(), [{ ...mapping, rulesHash: 'changed' }], policy, time);
  assert.deepEqual(changed.results[0].blockers, ['unverified-contract-mapping']);
  const swapped = compareQuotes(catalog, quotes, snapshot(), [{ ...mapping, homeTeam: 'Orlando Magic' }], policy, time);
  assert.equal(swapped.results[0].eligibleForPaper, false);
});

test('snapshot request uses documented parameters and does not expose credentials', async () => {
  let requested;
  const result = await fetchNbaOdds({ apiKey: 'test-secret', fetchImpl: async url => {
    requested = url;
    return new Response(JSON.stringify(snapshot().events), { headers: { 'x-requests-remaining': '499', 'x-requests-last': '1' } });
  } });
  assert.equal(requested.searchParams.get('markets'), 'h2h');
  assert.equal(result.remainingCredits, '499');
  assert.equal(JSON.stringify(result).includes('test-secret'), false);
  await assert.rejects(fetchNbaOdds({ apiKey: '' }), /ODDS_API_KEY/);
  await assert.rejects(fetchNbaOdds({ apiKey: 'test-secret', fetchImpl: async () => { throw new Error('URL with test-secret'); } }),
    error => !error.message.includes('test-secret'));
});

test('fee formula is symmetric and rejects unsupported schedules', () => {
  assert.equal(takerFeePerShare(0.5, { rate: 0.05, exponent: 1 }), 0.0125);
  assert.ok(Math.abs(takerFeePerShare(0.3, { rate: 0.05, exponent: 1 }) -
    takerFeePerShare(0.7, { rate: 0.05, exponent: 1 })) < 1e-12);
  assert.throws(() => takerFeePerShare(0.5, { rate: 0.05, exponent: 2 }));
});
