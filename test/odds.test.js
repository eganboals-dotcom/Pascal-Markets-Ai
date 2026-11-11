import test from 'node:test';
import assert from 'node:assert/strict';
import { dueLeagues, espnRows, oddsApiRows } from '../src/odds.js';

test('dueLeagues spends credits only on leagues with a game starting soon, once per spacing', () => {
  const h = 3600000, now = 100 * h;
  const starts = new Map([['nba', [now + 0.5 * h]], ['nhl', [now + 3 * h]], ['nfl', [now - h, now + 0.9 * h]], ['ncaab', [now + 0.2 * h]], ['mlb', []]]);
  const swept = new Map([['ncaab', now - h], ['nfl', now - 2 * h]]);
  assert.deepEqual(dueLeagues(starts, swept, now, h, 2 * h), ['nba', 'nfl']); // nhl too far off, ncaab swept an hour ago, mlb idle
  assert.deepEqual(dueLeagues(new Map([['nba', [now]]]), new Map(), now, h, 2 * h), []); // already started
});

const team = (homeAway, abbreviation, displayName) => ({ homeAway, team: { abbreviation, displayName } });
const quote = (odds, line) => ({ close: { odds, line }, open: { odds: '-110', line } });
const espnEvent = (id, state, odds) => ({ id, date: '2026-11-11T00:30Z', status: { type: { state } },
  competitions: [{ competitors: [team('home', 'NY', 'New York Knicks'), team('away', 'MIL', 'Milwaukee Bucks')], odds }] });

test('espnRows reads current DraftKings lines, keeps EVEN odds, and skips finished games and games without odds', () => {
  const odds = [{ provider: { name: 'Draft Kings' },
    moneyline: { home: quote('-1180'), away: quote('EVEN') },
    pointSpread: { home: quote('-104', '-16.5'), away: quote('-117', '+16.5') },
    total: { over: quote('-110', 'o221.5'), under: { close: { odds: null, line: 'u221.5' } } } }];
  const rows = espnRows({ events: [espnEvent('1', 'pre', odds), espnEvent('2', 'post', odds), espnEvent('3', 'pre', undefined)] }, 'nba', 5);
  assert.deepEqual(rows.map(r => r.market), ['h2h', 'spreads']); // the total lacks an under price, so it is left out
  assert.deepEqual(rows[0], { time: 5, source: 'espn', book: 'Draft Kings', league: 'nba', eventId: '1', start: '2026-11-11T00:30Z', state: 'pre',
    home: 'New York Knicks', away: 'Milwaukee Bucks', homeCode: 'NY', awayCode: 'MIL', market: 'h2h',
    outcomes: [{ name: 'New York Knicks', price: -1180, point: null }, { name: 'Milwaukee Bucks', price: 100, point: null }] });
  assert.deepEqual(rows[1].outcomes.map(o => [o.price, o.point]), [[-104, -16.5], [-117, 16.5]]);
  assert.deepEqual(espnRows({}, 'nba', 5), []);
});

test('oddsApiRows gives one row per book and market, with live games marked in play', () => {
  const events = [{ id: 'e1', commence_time: '2026-11-11T00:30:00Z', home_team: 'New York Knicks', away_team: 'Milwaukee Bucks',
    bookmakers: [{ key: 'pinnacle', markets: [
      { key: 'h2h', last_update: 'u1', outcomes: [{ name: 'New York Knicks', price: -1000 }, { name: 'Milwaukee Bucks', price: 650 }] },
      { key: 'totals', last_update: 'u2', outcomes: [{ name: 'Over', price: -105, point: 221.5 }, { name: 'Under', price: -115, point: 221.5 }] }] }] }];
  const before = Date.parse('2026-11-10T20:00:00Z'), during = Date.parse('2026-11-11T01:00:00Z');
  const rows = oddsApiRows(events, 'nba', before);
  assert.deepEqual(rows.map(r => [r.book, r.market, r.state]), [['pinnacle', 'h2h', 'pre'], ['pinnacle', 'totals', 'pre']]);
  assert.deepEqual(rows[1].outcomes[0], { name: 'Over', price: -105, point: 221.5 });
  assert.equal(rows[0].outcomes[0].point, null);
  assert.equal(oddsApiRows(events, 'nba', during)[0].state, 'in');
  assert.deepEqual(oddsApiRows(undefined, 'nba', before), []);
});
