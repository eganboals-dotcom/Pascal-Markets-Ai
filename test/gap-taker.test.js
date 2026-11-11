import test from 'node:test';
import assert from 'node:assert/strict';
import { bookIndexes, fairsFor, gapDecision, lineGames } from '../src/agents/gap-taker.js';

const min = 60000, now = Date.parse('2026-11-14T18:00Z'), start = '2026-11-14T20:00Z';
const espn = (fields = {}) => ({ time: now - 2 * min, source: 'espn', book: 'DraftKings', league: 'nba', eventId: 'e1', start, state: 'pre',
  home: 'New York Knicks', away: 'Chicago Bulls', homeCode: 'NY', awayCode: 'CHI', market: 'h2h',
  outcomes: [{ name: 'New York Knicks', price: -150 }, { name: 'Chicago Bulls', price: 130 }], ...fields });
const pinnacle = (fields = {}) => ({ time: now - min, source: 'the-odds-api', book: 'pinnacle', league: 'nba', eventId: 'x9', start: '2026-11-14T20:00:00Z',
  state: 'pre', home: 'New York Knicks', away: 'Chicago Bulls', market: 'h2h',
  outcomes: [{ name: 'Chicago Bulls', price: 140 }, { name: 'New York Knicks', price: -155 }], ...fields });

test('lineGames keeps each game\'s freshest pregame line per book and joins Odds API books by start time and team name', () => {
  const [game] = lineGames([espn({ time: now - 9 * min, outcomes: [{ name: 'New York Knicks', price: -120 }, { name: 'Chicago Bulls', price: 100 }] }), espn(), pinnacle()], now);
  assert.deepEqual(game.books.draftkings, { home: -150, away: 130, time: now - 2 * min }); // the newer of the two ESPN rows
  assert.deepEqual(game.books.pinnacle, { home: -155, away: 140, time: now - min }); // outcomes matched by name, not position
  assert.equal(game.date, '2026-11-14');
  assert.equal(lineGames([espn({ time: now - 16 * min })], now).length, 0); // a line older than 15 minutes is not used
  assert.equal(lineGames([espn({ start: '2026-11-14T17:59Z' })], now).length, 0); // started: books stop at kickoff
  const other = lineGames([espn(), pinnacle({ home: 'Boston Celtics', away: 'Miami Heat' })], now)[0];
  assert.equal(other.books.pinnacle, undefined); // same start, different teams: never joined
  const soccer = lineGames([espn({ league: 'epl', home: 'Arsenal', away: 'Leeds United', homeCode: 'ARS', awayCode: 'LEE',
    outcomes: [{ name: 'Arsenal', price: -215 }, { name: 'Leeds United', price: 650 }, { name: 'Draw', price: 340 }] })], now)[0];
  assert.deepEqual(soccer.books.draftkings, { home: -215, away: 650, draw: 340, time: now - 2 * min });
});

test('fairsFor prices a Kalshi market from each book, soccer TIE included', () => {
  const indexes = bookIndexes(lineGames([espn(), pinnacle()], now));
  const knicks = fairsFor('KXNBAGAME-26NOV14CHINYK-NYK', indexes);
  assert.ok(knicks.pinnacle > 0.58 && knicks.pinnacle < 0.6 && Math.abs(knicks.pinnacle - knicks.draftkings) < 0.02);
  assert.equal(knicks.game.eventId, 'e1');
  const epl = bookIndexes(lineGames([espn({ league: 'epl', home: 'Arsenal', away: 'Leeds United', homeCode: 'ARS', awayCode: 'LEE',
    outcomes: [{ name: 'Arsenal', price: -215 }, { name: 'Leeds United', price: 650 }, { name: 'Draw', price: 340 }] })], now));
  const tie = fairsFor('KXEPLGAME-26NOV14ARSLEE-TIE', epl, ['ARS', 'LEE', 'TIE']);
  assert.ok(tie.draftkings > 0.2 && tie.draftkings < 0.23 && tie.pinnacle === undefined);
  assert.equal(fairsFor('KXNBAGAME-26NOV14BOSMIA-BOS', indexes), null);
});

test('gapDecision takes every gap that clears fees and margin, flags implausible ones and skips what it cannot trust', () => {
  const book = { yesBid: 0.4, yesAsk: 0.42, yesBidSize: 10, yesAskSize: 10 };
  const base = { book, fairs: { pinnacle: 0.5, draftkings: 0.51 }, start: Date.parse(start), now };
  const yes = gapDecision(base);
  assert.equal(yes.action, 'take');
  assert.equal(yes.trade.side, 'yes'); // 50% fair, 42¢ ask: about 6¢ after the fee
  assert.equal(yes.fair, 0.5); // Pinnacle is the reference when it has a line
  assert.equal(gapDecision({ ...base, fairs: { draftkings: 0.43 } }).action, 'skip'); // inside the fee band
  assert.equal(gapDecision({ ...base, fairs: { pinnacle: 0.5, draftkings: 0.58 } }).reason, 'books disagree');
  assert.equal(gapDecision({ ...base, now: Date.parse(start) }).reason, 'game started');
  assert.equal(gapDecision({ ...base, book: { ...book, yesAskSize: 0 } }).reason, 'nothing offered at that price');
  const tenVsOne = gapDecision({ ...base, book: { yesBid: 0.005, yesAsk: 0.01, yesBidSize: 5, yesAskSize: 5 }, fairs: { draftkings: 0.1 } });
  assert.equal(tenVsOne.action, 'take'); // 10% on the books, 1¢ on Kalshi: about 9¢ of edge
  const huge = gapDecision({ ...base, book: { yesBid: 0.1, yesAsk: 0.12, yesBidSize: 5, yesAskSize: 5 }, fairs: { draftkings: 0.6 } });
  assert.deepEqual([huge.action, huge.reason], ['flag', 'gap above 15¢: check the rules and the match']);
  assert.equal(gapDecision({ ...base, fairs: {} }).reason, 'no fresh line');
});
