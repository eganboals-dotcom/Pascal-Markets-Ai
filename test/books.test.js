import test from 'node:test';
import assert from 'node:assert/strict';
import { OrderBooks } from '../src/books.js';
import { nbaMoneylines, refreshedTerms } from '../src/catalog.js';

const frame = payload => ({ recordingId: 'r', session: 1, kind: 'data', receivedAt: 1001, payload });
const snapshot = () => ({ event_type: 'book', asset_id: '1', timestamp: '1000',
  bids: [{ price: '0.4', size: '10' }, { price: '0.3', size: '20' }],
  asks: [{ price: '0.7', size: '20' }, { price: '0.6', size: '30' }] });
const delta = changes => frame({ event_type: 'price_change', timestamp: '1001', price_changes: changes });

test('snapshot selects best prices independently of API level ordering', () => {
  const books = new OrderBooks(['1']);
  assert.deepEqual(books.apply(frame(snapshot()))[0], {
    assetId: '1', sourceAt: 1000, receivedAt: 1001, bid: 0.4, ask: 0.6, bidSize: 10, askSize: 30
  });
});

test('updates remove zero-size levels and require a snapshot after gaps', () => {
  const books = new OrderBooks(['1']);
  books.apply(frame(snapshot()));
  const change = delta([{ asset_id: '1', side: 'SELL', price: '0.6', size: '0', best_bid: '0.4', best_ask: '0.7' }]);
  assert.equal(books.apply(change)[0].ask, 0.7);
  books.apply({ ...frame({}), kind: 'gap' });
  assert.deepEqual(books.apply(change), []);
});

test('malformed batches clear all books and prevent stale reuse', () => {
  const books = new OrderBooks(['1']);
  books.apply(frame(snapshot()));
  assert.throws(() => books.apply(delta([{ asset_id: '1', side: 'BUY', price: '0.8', size: '5' }])), /Crossed/);
  assert.equal(books.books.size, 0);
  books.apply(frame(snapshot()));
  assert.throws(() => books.apply(delta([{ asset_id: '1', side: 'BUY', price: '0.4', size: '5', best_bid: '0.5' }])), /disagrees/);
  assert.equal(books.books.size, 0);
});

test('old snapshots cannot roll a book backwards and a new session clears state', () => {
  const books = new OrderBooks(['1']);
  books.apply(frame(snapshot()));
  assert.deepEqual(books.apply(frame({ ...snapshot(), timestamp: '900' })), []);
  assert.deepEqual(books.apply({ ...delta([]), session: 2 }), []);
  assert.equal(books.books.size, 0);
});

test('catalog maps full-game home outcomes using explicit team ordering', () => {
  const event = { id: 'event', gameId: 7, title: 'Away vs Home', startTime: '2026-11-06T02:00:00Z',
    teams: [{ id: 1, name: 'Home', league: 'nba', ordering: 'home' }, { id: 2, name: 'Away', league: 'nba', ordering: 'away' }],
    markets: [{ id: 'market', sportsMarketType: 'moneyline', active: true, closed: false,
      outcomes: '["Away","Home"]', clobTokenIds: '["1","2"]', version: 'v1',
      description: 'The final score including any overtime periods.', acceptingOrders: true }]
  };
  const markets = nbaMoneylines([event]);
  assert.equal(markets[0].homeAssetId, '2');
  assert.equal(markets[0].awayAssetId, '1');
  assert.equal(markets[0].includesOvertime, true);
  const raw = event.markets[0];
  assert.equal(refreshedTerms(markets[0], { ...raw, closed: true }).acceptingOrders, false);
  assert.throws(() => refreshedTerms(markets[0], { ...raw, description: 'Revised rules' }), /rules changed/);
  assert.throws(() => refreshedTerms(markets[0], { ...raw, clobTokenIds: '["2","1"]' }), /identity changed/);
  assert.equal(nbaMoneylines([{ ...event, teams: [] }]).length, 0);
  assert.equal(nbaMoneylines([{ ...event, markets: [{ ...event.markets[0], sportsMarketType: 'spreads' }] }]).length, 0);
});
