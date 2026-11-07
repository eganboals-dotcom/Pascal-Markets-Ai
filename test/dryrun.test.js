import test from 'node:test';
import assert from 'node:assert/strict';
import { checkFill, judge, planOrders } from '../src/dryrun.js';

const hit = {
  id: 'ladder:kalshi:LOW:yes+kalshi:HIGH:no', contracts: 20, profit: 1.5,
  legs: [
    { venue: 'kalshi', ticker: 'LOW', side: 'yes', price: 0.4, size: 20 },
    { venue: 'kalshi', ticker: 'HIGH', side: 'no', price: 0.5, size: 30 }
  ]
};
const market = (ticker, fields) => ({ ticker, status: 'active', yes_ask_dollars: '0', yes_ask_size_fp: '0',
  no_ask_dollars: '0', yes_bid_size_fp: '0', ...fields });

test('planOrders turns each Kalshi leg into a fill-or-kill limit buy at the seen price', () => {
  assert.deepEqual(planOrders(hit), [
    { ticker: 'LOW', side: 'yes', action: 'buy', type: 'limit', timeInForce: 'fill_or_kill', count: 20, priceDollars: '0.4000' },
    { ticker: 'HIGH', side: 'no', action: 'buy', type: 'limit', timeInForce: 'fill_or_kill', count: 20, priceDollars: '0.5000' }
  ]);
});

test('planOrders returns null when any leg is not on Kalshi', () => {
  const cross = { ...hit, legs: [hit.legs[0], { venue: 'polymarket', ticker: '9#1', side: 'outcome 1', price: 0.5, size: 9 }] };
  assert.equal(planOrders(cross), null);
});

test('checkFill needs an active market, an ask at or below the limit, and enough size', () => {
  const [yesOrder, noOrder] = planOrders(hit);
  assert.equal(checkFill(yesOrder, market('LOW', { yes_ask_dollars: '0.39', yes_ask_size_fp: '25' })), true);
  assert.equal(checkFill(yesOrder, market('LOW', { yes_ask_dollars: '0.40', yes_ask_size_fp: '20' })), true);
  assert.equal(checkFill(yesOrder, market('LOW', { yes_ask_dollars: '0.41', yes_ask_size_fp: '25' })), false);
  assert.equal(checkFill(yesOrder, market('LOW', { yes_ask_dollars: '0.39', yes_ask_size_fp: '19' })), false);
  assert.equal(checkFill(yesOrder, market('LOW', { status: 'closed', yes_ask_dollars: '0.39', yes_ask_size_fp: '25' })), false);
  // A No order reads the No ask, whose size is the Yes bid size.
  assert.equal(checkFill(noOrder, market('HIGH', { no_ask_dollars: '0.50', yes_bid_size_fp: '20' })), true);
  assert.equal(checkFill(noOrder, market('HIGH', { yes_ask_dollars: '0.10', yes_ask_size_fp: '99' })), false);
  assert.equal(checkFill(noOrder, undefined), false);
});

test('judge reports filled, legged, or missed', () => {
  assert.equal(judge([true, true]), 'filled');
  assert.equal(judge([true, false]), 'legged');
  assert.equal(judge([false, false]), 'missed');
});
