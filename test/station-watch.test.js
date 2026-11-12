import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { asosReadings, clean, climateDate, climateDayStart, decided, indexReadings, metarReadings, metarUrl, soFar, standardOffsetMs } from '../src/agents/station-watch.js';
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

test('Kalshi\'s index gives each station\'s 1-minute readings with their arrival times, and only arrived readings bound the day', () => {
  const t0 = Date.parse('2026-10-20T18:00Z'), minute = 60000;
  const json = { timeseries: [
    { t: t0, stations: [{ station_id: 'KMDW1M', source: 'hf_asos', code: 'ok', temp_f: 66.2, received_at_ms: t0 + 144000 },
      { station_id: 'KDPA1M', source: 'metar', code: 'ok', obs_time_ms: t0 - 30 * minute, temp_f: 53.96, received_at_ms: t0 - 25 * minute },
      { station_id: 'KORD1M', code: 'missing' }] },
    { t: t0 + minute, stations: [{ station_id: 'KMDW1M', code: 'pending', temp_f: 68, received_at_ms: t0 + minute + 150000 },
      { station_id: 'KDPA1M', source: 'metar', code: 'ok', obs_time_ms: t0 - 30 * minute, temp_f: 53.96, received_at_ms: t0 - 25 * minute }] }] };
  const got = indexReadings(json);
  assert.deepEqual([...got.keys()], ['MDW', 'DPA']); // the missing reading is skipped
  assert.equal(got.get('DPA').length, 1); // a carried-forward reading counts once, at its own time
  assert.deepEqual(got.get('MDW')[0], { time: t0, temp: 66.2, arrived: t0 + 144000 });
  const chicago = standardOffsetMs('America/Chicago'), mdw = clean(got.get('MDW'));
  assert.equal(soFar(mdw, '2026-10-20', chicago, t0 + 3 * minute).high, 66.2); // 68 was read at 18:01 but had not arrived by 18:03
  assert.equal(soFar(mdw, '2026-10-20', chicago, t0 + 4 * minute).high, 68);
  assert.equal(indexReadings(null).size, 0);
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
    ledger.record({ time: 0, ticker: 'KXHIGHNY-26NOV04-B67.5', side: 'no', price: 0.9, fee: 0.01, contracts: 3 });
    ledger.record({ time: 0, ticker: 'KXHIGHNY-26NOV04-T66', side: 'yes', price: 0.95, fee: 0.01 });
    ledger.record({ time: 1000, ticker: 'KXHIGHNY-26NOV05-T66', side: 'yes', price: 0.95, fee: 0.01 });
    assert.equal(await ledger.settleDue((t, now) => now - t.time > 500, 1000), 1);
    assert.deepEqual(asked, ['KXHIGHNY-26NOV04-B67.5', 'KXHIGHNY-26NOV04-T66']); // the newest trade is not due yet
    assert.ok(Math.abs(ledger.pnl() - 0.27) < 1e-9); // 9¢ on each of 3 contracts
    const again = openLedger('station-watch', { dir, load: async () => [] });
    assert.equal(again.trades.length, 3);
    assert.deepEqual([...again.settled.keys()], ['KXHIGHNY-26NOV04-B67.5']);
    assert.equal(readFileSync(projectPath(`${dir}/station-settled.jsonl`), 'utf8').trim().split('\n').length, 1);
    assert.throws(() => openLedger('nobody', { dir }), /No paper ledger/);
    assert.equal(eventOf('KXNBAGAME-26NOV11CHINYK-NYK'), 'KXNBAGAME-26NOV11CHINYK');
  } finally { rmSync(projectPath(dir), { recursive: true, force: true }); }
});

test('an early exit counts as settled, and the breaker pauses losing groups and stops a bad day', async () => {
  const dir = `work/paper-${randomUUID()}`, hour = 3600000;
  try {
    const ledger = openLedger('game-watch', { dir, load: async () => [{ ticker: 'KXNBAREB-26NOV04A-P1-5', result: 'yes' }] });
    const win = { time: 0, ticker: 'KXNBAREB-26NOV04A-P1-5', league: 'KXNBAREB', side: 'yes', price: 0.97, fee: 0.01, contracts: 10 };
    const bad = { time: 0, ticker: 'KXNBATOTAL-26NOV04A-220', league: 'KXNBATOTAL', side: 'yes', price: 0.97, fee: 0.01, contracts: 25 };
    ledger.record(win); ledger.record(bad);
    assert.equal(ledger.open().length, 2);
    ledger.exit(bad, 0.6, 0.02, 5 * hour, 'the plays now decide the other side');
    assert.equal(ledger.open().length, 1); // an exited position is not settled again
    assert.ok(Math.abs(ledger.settled.get(bad.ticker) - (0.6 - 0.02 - 0.98) * 25) < 1e-9); // −$10.00, not the −$24.50 of holding
    await ledger.settleDue(() => true, 6 * hour);
    assert.ok(Math.abs(ledger.settled.get(win.ticker) - 0.2) < 1e-9);
    const groupOf = t => `${t.league} ${t.side}`;
    const now = ledger.breaker(groupOf, { dailyLimit: 25, now: 7 * hour });
    assert.deepEqual([...now.paused], ['KXNBATOTAL yes']);
    assert.equal(now.stopped, false); // −$9.80 on the day
    assert.equal(ledger.breaker(groupOf, { dailyLimit: 5, now: 7 * hour }).stopped, true);
    assert.equal(ledger.breaker(groupOf, { now: 30 * hour }).paused.size, 0); // the pause ends after a day
    assert.equal(openLedger('game-watch', { dir }).open().length, 0); // reloads with the exit counted
  } finally { rmSync(projectPath(dir), { recursive: true, force: true }); }
});

test('aviationweather METARs become readings in °F from the T group, counted from when the feed received them', () => {
  const obs = Date.parse('2026-11-12T20:51:00Z') / 1000;
  const got = metarReadings([
    { icaoId: 'KAUS', obsTime: obs, receiptTime: '2026-11-12T20:54:30.000Z', temp: 25.6, rawOb: 'KAUS 122051Z 18010KT 10SM CLR 26/18 A2990 RMK AO2 T02560178' },
    { icaoId: 'KNYC', obsTime: obs, receiptTime: 'bad', temp: -1, rawOb: 'KNYC 122051Z AUTO 31008KT M01/M05 A3010' },
    { icaoId: 'KDEN', obsTime: obs, temp: null, rawOb: 'KDEN 122053Z 00000KT 10SM' },
  ]);
  assert.deepEqual(got.get('AUS'), [{ time: obs * 1000, temp: 78.08, arrived: Date.parse('2026-11-12T20:54:30Z') }]);
  assert.deepEqual(got.get('NYC'), [{ time: obs * 1000, temp: 30.2, arrived: obs * 1000 }]); // no T group: whole °C; no receipt: its own time
  assert.equal(got.has('DEN'), false);
  assert.equal(metarReadings({ error: 'x' }).size, 0);
  assert.equal(metarUrl(['AUS', 'NYC'], 2), 'https://aviationweather.gov/api/data/metar?ids=KAUS,KNYC&hours=2&format=json');
});
