import test from 'node:test';
import assert from 'node:assert/strict';
import { decisionMoments, lagStats } from '../src/score-lag.js';

const row = (time, type, score, events, id = 'm1') => ({ time, id, type, events, score });

test('decided moments are the first row showing each result, never a match already decided when first logged', () => {
  const ev = ['KXATPMATCH-26NOV12AB', 'KXATPSETWINNER-26NOV12AB-1', 'KXATPSETWINNER-26NOV12AB-2'];
  const rows = [row(1, 'tennis_tournament_singles', { winner: null, sets: [[3, 2, 'ongoing']] }, ev),
    row(5, 'tennis_tournament_singles', { winner: null, sets: [[6, 2, 'winner'], [0, 0, 'ongoing']] }, ev),
    row(9, 'tennis_tournament_singles', { winner: 'a', sets: [[6, 2, 'winner'], [6, 1, 'winner']] }, ev),
    row(2, 'table_tennis_match', { status: 'ended', winner: 'p', sets: [3, 0] }, ['KXLIGAPROMATCH-26NOV12PQ'], 'm2'),
    row(3, 'soccer_tournament_multi_leg', { home: 0, away: 0, homeReg: null }, ['KXEPLTOTAL-26NOV12HA', 'KXEPLGAME-26NOV12HA'], 'm3'),
    row(7, 'soccer_tournament_multi_leg', { home: 1, away: 0, homeReg: null }, ['KXEPLTOTAL-26NOV12HA', 'KXEPLGAME-26NOV12HA'], 'm3')];
  const got = decisionMoments(rows).map(m => `${m.event} ${m.label} ${m.time}`).sort();
  assert.deepEqual(got, ['KXATPMATCH-26NOV12AB final 9', 'KXATPSETWINNER-26NOV12AB-1 set 1 5', 'KXATPSETWINNER-26NOV12AB-2 set 2 9', 'KXEPLTOTAL-26NOV12HA goal 1 7']);
});

test('lag stats read the winning side: the last price before, seconds to 99¢, and cheap taker buys after', () => {
  const at = Date.parse('2026-11-12T23:00:00Z'), t = (s, yes, count, taker) => ({ created_time: new Date(at + s * 1000).toISOString(),
    yes_price_dollars: String(yes), no_price_dollars: String(1 - yes), count_fp: String(count), taker_side: taker });
  const trades = [t(-20, 0.7, 5, 'yes'), t(10, 0.9, 10, 'yes'), t(20, 0.95, 4, 'no'), t(60, 0.97, 3, 'yes'), t(200, 0.99, 50, 'yes')];
  const s = lagStats(trades, at, 'yes');
  assert.equal(s.before, 0.7);
  assert.equal(s.secondsTo99, 200);
  assert.equal(s.lastUnder97, 20); // the 95¢ print 20 seconds after the log saw the result
  assert.equal(s.cheap.first30s.contracts, 10); // the 4 bought by a No taker were a resting Yes buyer's fill, not a taker's
  assert.ok(Math.abs(s.cheap.first30s.edge - 10 * (0.1 - 0.07 * 0.9 * 0.1)) < 1e-9);
  assert.equal(s.cheap.to2m.contracts, 3);
  assert.equal(s.cheap.to15m.contracts, 0);
  assert.ok(Math.abs(lagStats(trades, at, 'no').before - 0.3) < 1e-9);
});
