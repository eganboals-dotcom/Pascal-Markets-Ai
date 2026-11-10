import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchCandles, fetchSettledMarkets } from '../src/kalshi.js';
import { fetchTrades } from '../src/kalshi.js';
import { HEARTBEAT_MS, candleRows, downloadState, quotable, quoteEnd, seriesOf, settlementValue } from '../src/history.js';

test('quoteEnd applies the earlier pull rule and quotable needs a 3-tick spread inside the band before it', async () => {
  const mm = { pullMinutes: 60, pullBeforeExpiryMinutes: 240, minMid: .05, maxMid: .95 };
  assert.equal(quoteEnd(market, mm), Date.parse('2026-11-09T00:20:00Z'));
  assert.equal(quoteEnd({ ...market, expected_expiration_time: null }, mm), Date.parse('2026-11-09T03:40:05Z'));
  const row = (time, yesBid, yesAsk) => ({ time, yesBid, yesAsk }), end = 100;
  assert.equal(quotable([row(10, .40, .42), row(100, .40, .45)], end, mm), false); // 2 ticks before, wide only at the pull time
  assert.equal(quotable([row(10, .01, .04)], end, mm), false); // wide, but outside the mid band
  assert.equal(quotable([row(10, .40, .43)], end, mm), true);
  let url;
  await fetchTrades('KX-A', 1000, async u => { url = u; return { trades: [] }; }, 1, 5500);
  assert.equal(new URL(url).searchParams.get('max_ts'), '6');
});

const candle = (minute, bid, ask) => ({ end_period_ts: minute * 60, yes_bid: { close_dollars: bid }, yes_ask: { close_dollars: ask } });
const market = { ticker: 'KXNFLGAME-26NOV08TBCHI-TB', event_ticker: 'KXNFLGAME-26NOV08TBCHI', close_time: '2026-11-09T04:40:05Z', expected_expiration_time: '2026-11-09T04:20:00Z' };

test('candleRows keeps changes and a heartbeat, drops empty books, and carries series fees', () => {
  const rows = candleRows([candle(0, '0.40', '0.42'), candle(1, '0.40', '0.42'), candle(2, '0.41', '0.42'), candle(3, null, '0.42'),
    candle(4, '0.41', '1.00'), candle(2 + HEARTBEAT_MS / 60000, '0.41', '0.42')], market, { fee_type: 'quadratic_with_maker_fees', fee_multiplier: 2 });
  assert.deepEqual(rows.map(r => [r.time / 60000, r.yesBid, r.yesAsk]), [[0, .4, .42], [2, .41, .42], [17, .41, .42]]);
  assert.deepEqual({ ...rows[0], time: 0 }, { ticker: market.ticker, time: 0, yesBid: .4, yesAsk: .42, yesBidSize: 1, yesAskSize: 1, volume_24h: null,
    close_time: market.close_time, expected_expiration_time: market.expected_expiration_time, fee_type: 'quadratic_with_maker_fees', fee_multiplier: 2 });
  assert.equal(seriesOf(market), 'KXNFLGAME');
  assert.deepEqual(['yes', 'no', '', 'void'].map(result => settlementValue({ result })), [1, 0, null, null]);
});

test('fetchCandles splits ranges under the 5000-candle cap and dedupes boundaries', async () => {
  const urls = [];
  const candles = await fetchCandles('KXNFLGAME', market.ticker, 0, 7 * 86400000, async url => {
    urls.push(url);
    const start = Number(new URL(url).searchParams.get('start_ts')), end = Number(new URL(url).searchParams.get('end_ts'));
    assert.ok((end - start) / 60 <= 5000);
    return { candlesticks: [{ end_period_ts: start }, { end_period_ts: end }] };
  });
  assert.equal(urls.length, 3);
  assert.equal(new Set(candles.map(c => c.end_period_ts)).size, candles.length);
  assert.ok(candles.every((c, i) => !i || c.end_period_ts > candles[i - 1].end_period_ts));
  await assert.rejects(fetchCandles('BAD SERIES', 'T', 0, 1, async () => ({})), /Invalid Kalshi candles request/);
});

test('fetchSettledMarkets excludes combos, filters each page and stops on a repeated cursor', async () => {
  const urls = [];
  const pages = [{ markets: [{ ticker: 'A', v: 5 }, { ticker: 'B', v: 0 }], cursor: 'c1' }, { markets: [{ ticker: 'C', v: 9 }], cursor: '' }];
  const kept = await fetchSettledMarkets(0, 86400000, m => m.v > 0, async url => { urls.push(url); return pages.shift(); });
  assert.deepEqual(kept.map(m => m.ticker), ['A', 'C']);
  assert.equal(new URL(urls[0]).searchParams.get('mve_filter'), 'exclude');
  assert.equal(new URL(urls[0]).searchParams.get('max_close_ts'), '86399');
  assert.equal(new URL(urls[1]).searchParams.get('cursor'), 'c1');
  await assert.rejects(fetchSettledMarkets(0, 1, undefined, async () => ({ markets: [], cursor: 'x' }), 3), /Repeated/);
  await assert.rejects(fetchSettledMarkets(5, 5), /Invalid Kalshi history request/);
});

test('the model waits for the backfill finished marker and gives up on a stalled download', () => {
  const now = Date.parse('2026-11-11T12:00:00Z'), hour = 3600000;
  assert.equal(downloadState('{"day":"d","total":100}\n{"finished":true,"total":9}\n', now - 10 * hour, now), 'finished');
  assert.equal(downloadState('{"day":"d","total":100}\n', now - hour, now), 'running');
  assert.equal(downloadState('{"day":"d","total":100}\n{"fini', now - hour, now), 'running');
  assert.equal(downloadState('{"day":"d","total":100}\n', now - 4 * hour, now), 'stalled');
  assert.equal(downloadState('', now, now), 'running');
});
