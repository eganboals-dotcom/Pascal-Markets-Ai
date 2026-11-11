import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { asosReadings, climateDate, climateDayStart, decided, soFar, standardOffsetMs } from '../src/agents/station-watch.js';
import { eventOf, openLedger } from '../src/paper.js';
import { projectPath } from '../src/files.js';

test('climate days run on local standard time all year, and readings so far bound only their own day', () => {
  const ny = standardOffsetMs('America/New_York');
  assert.equal(ny, -5 * 3600000); // standard time even when summer time applies
  assert.equal(standardOffsetMs('America/Phoenix'), -7 * 3600000);
  assert.equal(climateDate(Date.parse('2026-07-04T04:30Z'), ny), '2026-07-03'); // 11:30 PM EST is still July 3
  assert.equal(climateDayStart('2026-11-04', ny), Date.parse('2026-11-04T05:00Z'));
  const readings = asosReadings('station,valid,tmpf\nNYC,2026-11-04 04:51,80.00\nNYC,2026-11-04 13:51,62.00\nNYC,2026-11-04 17:51,71.00\nNYC,2026-11-04 18:51,\n');
  assert.equal(readings.length, 3); // the empty reading is dropped
  assert.deepEqual(soFar(readings, '2026-11-04', ny), { high: 71, low: 62, count: 2 }); // 04:51 UTC belongs to Nov 3
  assert.deepEqual(soFar(readings, '2026-11-04', ny, Date.parse('2026-11-04T14:00Z')), { high: 62, low: 62, count: 1 });
  assert.equal(soFar(readings, '2026-11-05', ny), null);
  // 5-minute reports leave tmpf empty; the METAR's T group is read instead, and is preferred to tmpf when both are there.
  const five = asosReadings('station,valid,tmpf,metar\nMDW,2026-10-20 18:00,,KMDW 201800Z AUTO 16004KT 10SM CLR 19/05 A3037 RMK T01900050 MADISHF\n' +
    'MDW,2026-10-20 18:05,,KMDW 201805Z AUTO 10SM CLR M02/M05 A3037 RMK T10170050 MADISHF\nMDW,2026-10-20 18:10,66.00,KMDW 201810Z AUTO 10SM CLR 19/05 A3037\n' +
    'MDW,2026-10-20 18:15,,KMDW 201815Z AUTO 10SM CLR 19/05 A3037\nMDW,2026-10-20 17:53,66.02,KMDW 201753Z 16004KT 10SM CLR 19/05 RMK T01890050');
  assert.deepEqual(five.map(r => r.temp), [66.02, 66.2, 66]); // sorted by time; the -1.7°C spike and the row without a reading are gone
  // A lone error-code reading (-61°C) is dropped; a reading next to one within 10°F stays.
  const spike = asosReadings('station,valid,tmpf\nDCA,2026-10-14 17:15,84.2\nDCA,2026-10-14 17:20,-77.8\nDCA,2026-10-14 17:25,84.2\nDCA,2026-10-14 17:30,-77.8\n');
  assert.deepEqual(spike.map(r => r.temp), [84.2, 84.2]);
});

test('a range is decided only when no rest of the day can change it, with the cushion on each side', () => {
  const between = (floor, cap) => ({ strike_type: 'between', floor_strike: floor, cap_strike: cap });
  const greater = floor => ({ strike_type: 'greater', floor_strike: floor }), less = cap => ({ strike_type: 'less', cap_strike: cap });
  const bound = { high: 71, low: 52 };
  // High 71 so far, cushion 1: the official high is at least 70.
  assert.equal(decided(between(67, 68), 'high', bound), 'no');
  assert.equal(decided(between(69, 70), 'high', bound), null); // 70 is still possible
  assert.equal(decided(between(71, 72), 'high', bound), null);
  assert.equal(decided(greater(69), 'high', bound), 'yes');
  assert.equal(decided(greater(70), 'high', bound), null);
  assert.equal(decided(less(70), 'high', bound), 'no');
  assert.equal(decided(less(71), 'high', bound), null);
  // Low 52 so far, cushion 2: the official low is at most 54.
  assert.equal(decided(between(55, 56), 'low', bound), 'no');
  assert.equal(decided(between(53, 54), 'low', bound), null);
  assert.equal(decided(less(55), 'low', bound), 'yes');
  assert.equal(decided(less(54), 'low', bound), null);
  assert.equal(decided(greater(54), 'low', bound), 'no');
  assert.equal(decided(greater(53), 'low', bound), null);
  assert.equal(decided(between(67, 68), 'high', null), null); // no readings yet
  assert.equal(decided(between(67, 68), 'high', { high: 69.4, low: 50 }), 'no'); // 69.4 - 1 rounds up to at least 69
});

test('a paper ledger records trades, settles only those Kalshi has settled, and reloads from its files', async () => {
  const dir = `work/paper-${randomUUID()}`;
  try {
    const asked = [];
    const load = async tickers => { asked.push(...tickers); return [{ ticker: 'KXHIGHNY-26NOV04-B67.5', result: 'no' }, { ticker: 'KXHIGHNY-26NOV04-T66', result: '' }]; };
    const ledger = openLedger('station-watch', { dir, load });
    ledger.record({ time: 0, ticker: 'KXHIGHNY-26NOV04-B67.5', side: 'no', price: 0.9, fee: 0.01 });
    ledger.record({ time: 0, ticker: 'KXHIGHNY-26NOV04-T66', side: 'yes', price: 0.95, fee: 0.01 });
    ledger.record({ time: 1000, ticker: 'KXHIGHNY-26NOV05-T66', side: 'yes', price: 0.95, fee: 0.01 });
    assert.equal(await ledger.settleDue((t, now) => now - t.time > 500, 1000), 1);
    assert.deepEqual(asked, ['KXHIGHNY-26NOV04-B67.5', 'KXHIGHNY-26NOV04-T66']); // the newest trade is not due yet
    assert.ok(Math.abs(ledger.pnl() - 0.09) < 1e-9);
    const again = openLedger('station-watch', { dir, load: async () => [] });
    assert.equal(again.trades.length, 3);
    assert.deepEqual([...again.settled.keys()], ['KXHIGHNY-26NOV04-B67.5']);
    assert.equal(readFileSync(projectPath(`${dir}/station-settled.jsonl`), 'utf8').trim().split('\n').length, 1);
    assert.throws(() => openLedger('nobody', { dir }), /No paper ledger/);
    assert.equal(eventOf('KXNBAGAME-26NOV11CHINYK-NYK'), 'KXNBAGAME-26NOV11CHINYK');
  } finally { rmSync(projectPath(dir), { recursive: true, force: true }); }
});
