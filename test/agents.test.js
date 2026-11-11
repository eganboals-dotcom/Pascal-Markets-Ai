import test from 'node:test';
import assert from 'node:assert/strict';
import { americanProb, bookAt, brierComparison, noVig, settle, summarize, take } from '../src/takers.js';
import { bucketOf, longshotRules } from '../src/agents/longshot.js';
import { closingRow, gameIndex, matchMarket, parseGameTicker, tickerDate } from '../src/agents/fair-odds.js';
import { dailyExtremes, errorModel, paysYes, stationOf, strikeProbability } from '../src/agents/fair-weather.js';

const book = (yesBid, yesAsk) => ({ yesBid, yesAsk, fee_multiplier: 1 });

test('take buys the side fair value favors only when the edge beats fee and margin, and settle pays it', () => {
  const yes = take(0.60, book(0.50, 0.52));
  assert.equal(yes.side, 'yes');
  assert.equal(yes.price, 0.52);
  assert.ok(Math.abs(yes.fee - 0.0175) < 1e-9 && Math.abs(yes.edge - (0.60 - 0.52 - 0.0175)) < 1e-9);
  assert.equal(take(0.20, book(0.30, 0.32)).side, 'no'); // No costs 70¢ and wins 80% of the time
  assert.equal(take(0.53, book(0.50, 0.52)), null); // 1¢ edge minus a 1.75¢ fee
  assert.ok(Math.abs(settle(yes, 1) - (1 - 0.52 - yes.fee)) < 1e-12 && Math.abs(settle(yes, 0) + 0.52 + yes.fee) < 1e-12);
  assert.equal(take(NaN, book(0.5, 0.52)), null);
});

test('bookAt ignores later and stale rows; odds helpers remove the margin', () => {
  const rows = [{ time: 0, v: 'a' }, { time: 50, v: 'b' }, { time: 200, v: 'c' }];
  assert.equal(bookAt(rows, 100, 60).v, 'b');
  assert.equal(bookAt(rows, 100, 10), null);
  assert.ok(Math.abs(americanProb(-150) - 0.6) < 1e-12 && Math.abs(americanProb(150) - 0.4) < 1e-12);
  const [a, b] = noVig([americanProb(-110), americanProb(-110)]);
  assert.ok(Math.abs(a - 0.5) < 1e-12 && Math.abs(a + b - 1) < 1e-12);
});

test('summarize groups by event and reports the worst one; brierComparison is model minus market', () => {
  const s = summarize([{ ticker: 'S-E1-A', pnl: 0.1, group: 'x' }, { ticker: 'S-E1-B', pnl: -0.5, group: 'x' }, { ticker: 'S-E2-A', pnl: 0.2, group: 'y' }]);
  assert.equal(s.settled.events, 2);
  assert.ok(Math.abs(s.worstEvent + 0.4) < 1e-12);
  assert.deepEqual(s.groups.x.trades, 2);
  const b = brierComparison([{ ticker: 'S-E1-A', model: 0.9, market: 0.5, outcome: 1 }, { ticker: 'S-E2-A', model: 0.2, market: 0.5, outcome: 0 }]);
  assert.ok(b.model < b.market && b.modelMinusMarket.total < 0);
});

test('longshotRules learns to fade cheap Yes contracts only with enough events behind the bucket', () => {
  // 40 events of a 5¢ contract that never wins: buying No at 96¢ earns about 4¢ less a small fee.
  const samples = Array.from({ length: 40 }, (_, i) => ({ ticker: `KXA-E${i}-X`, bucket: bucketOf(0.05), book: book(0.04, 0.06), settle: 0 }));
  const rules = longshotRules(samples);
  assert.equal(rules.get(bucketOf(0.05)).side, 'no');
  assert.equal(rules.get(bucketOf(0.05)).events, 40);
  assert.equal(longshotRules(samples.slice(0, 10)).size, 0); // too few events
  assert.equal(bucketOf(0.999), 11);
  assert.equal(bucketOf(0), 0);
});

test('game tickers match ESPN games exactly, by Eastern date and away+home codes', () => {
  assert.deepEqual(parseGameTicker('KXNCAAFGAME-26NOV07MIAND-MIA'), { series: 'KXNCAAFGAME', date: '2026-11-07', teams: 'MIAND', outcome: 'MIA' });
  assert.equal(tickerDate('26OCT31'), '2026-10-31');
  const event = { id: '9', date: '2026-11-08T00:30Z', competitions: [{ competitors: [
    { homeAway: 'home', team: { abbreviation: 'ND', displayName: 'Notre Dame' } }, { homeAway: 'away', team: { abbreviation: 'MIA', displayName: 'Miami' } }] }] };
  const odds = [{ provider: { id: '100', name: 'Draft Kings' },
    homeTeamOdds: { moneyLine: -150, close: { moneyLine: { american: '-150' } }, open: { moneyLine: { american: '-140' } } },
    awayTeamOdds: { moneyLine: 130, close: { moneyLine: { american: '+130' } }, open: { moneyLine: { american: '+120' } } } }];
  const row = closingRow('ncaaf', event, odds);
  assert.equal(row.date, '2026-11-07'); // 00:30 UTC is the evening before in New York
  assert.deepEqual([row.close, row.open], [{ away: 130, home: -150 }, { away: 120, home: -140 }]);
  const index = gameIndex([row]);
  const miami = matchMarket('KXNCAAFGAME-26NOV07MIAND-MIA', index), nd = matchMarket('KXNCAAFGAME-26NOV07MIAND-ND', index);
  assert.ok(Math.abs(miami.fair + nd.fair - 1) < 1e-12 && miami.fair < 0.45);
  assert.equal(matchMarket('KXNCAAFGAME-26NOV09MIAND-MIA', index), null); // two days off
  assert.equal(matchMarket('KXNCAAFGAME-26NOV07MIAND-TIE', index), null);
  assert.equal(closingRow('ncaaf', event, []).close, null);
  // Kalshi spells NYK and SAS where ESPN has NY and SA; two similar games on one date match nothing.
  const game = (awayCode, homeCode, eventId) => ({ league: 'nba', eventId, date: '2026-11-04', awayCode, homeCode, close: { away: 120, home: -140 } });
  const nba = gameIndex([game('CHI', 'NY', '1'), game('DAL', 'SA', '2')]);
  assert.equal(matchMarket('KXNBAGAME-26NOV04CHINYK-NYK', nba).game.eventId, '1');
  assert.equal(matchMarket('KXNBAGAME-26NOV04DALSAS-DAL', nba).game.eventId, '2');
  assert.equal(matchMarket('KXNBAGAME-26NOV04CHINYK-NYK', gameIndex([game('CHI', 'NY', '1'), game('CHI', 'NYK', '3')])).game.eventId, '3'); // exact beats prefix
  assert.equal(matchMarket('KXNBAGAME-26NOV04CHINYK-NYK', gameIndex([game('CHI', 'NY', '1'), game('CHI', 'NY', '4')])), null); // a tie is skipped
  assert.equal(matchMarket('KXNBAGAME-26NOV04ATLWAS-ATL', gameIndex([game('ATL', 'WSH', '5')])).game.eventId, '5');
  // Neutral site listed the other way round: Kalshi's away team is ESPN's home team, so it gets ESPN's home price.
  const swapped = matchMarket('KXNBAGAME-26NOV04NYCHI-NY', gameIndex([game('CHI', 'NY', '6')]));
  assert.ok(swapped.game.eventId === '6' && swapped.fair > 0.5 && !swapped.exact);
  const nextDay = matchMarket('KXNBAGAME-26NOV03CHINY-NY', gameIndex([game('CHI', 'NY', '7')]));
  assert.ok(nextDay.game.eventId === '7' && !nextDay.exact);
  assert.equal(matchMarket('KXNBAGAME-26NOV04CHINY-NY', nba).exact, true);
  // Bellarmine at Indiana must not become Indiana State at Ball State the next day (only loose letter matches, swapped and shifted).
  const ball = { league: 'ncaab', eventId: '8', date: '2026-11-06', awayCode: 'INST', homeCode: 'BALL', close: { away: 120, home: -140 } };
  assert.equal(matchMarket('KXNCAAMBGAME-26NOV05BELLIND-IND', gameIndex([ball])), null);
});

test('weather strikes follow Kalshi rules and the forecast spread has a floor', () => {
  assert.equal(stationOf('...recorded at New York City (CLINYC) for Nov 4...'), 'NYC');
  assert.equal(stationOf('no station'), null);
  const between = { strike_type: 'between', floor_strike: 72, cap_strike: 73 }, greater = { strike_type: 'greater', floor_strike: 77 }, less = { strike_type: 'less', cap_strike: 70 };
  assert.deepEqual([paysYes(between, 73), paysYes(between, 74), paysYes(greater, 77), paysYes(greater, 78), paysYes(less, 69), paysYes(less, 70)],
    [true, false, false, true, true, false]);
  const p = strikeProbability(between, 72.5, 2);
  assert.ok(p > 0.35 && p < 0.4);
  const ladder = [less, { strike_type: 'between', floor_strike: 70, cap_strike: 71 }, between, { strike_type: 'between', floor_strike: 74, cap_strike: 77 }, greater];
  assert.ok(Math.abs(ladder.reduce((a, m) => a + strikeProbability(m, 73, 3), 0) - 1) < 1e-6); // a full ladder sums to one
  assert.equal(errorModel([1, 2, 3]), null);
  const model = errorModel(Array.from({ length: 12 }, () => 1));
  assert.deepEqual([model.bias, model.sd], [1, 1.5]);
  const hours = Array.from({ length: 24 }, (_, h) => `2026-11-04T${String(h).padStart(2, '0')}:00`);
  assert.deepEqual(dailyExtremes([...hours, '2026-11-05T00:00'], [...hours.map((_, h) => 60 + h), 50]), { '2026-11-04': { high: 83, low: 60, hours: 24 } });
});
