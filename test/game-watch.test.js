import test from 'node:test';
import assert from 'node:assert/strict';
import { compactGame, decidedAt, findPlayer, parseMarket, sideOf } from '../src/agents/game-watch.js';

const t0 = Date.parse('2026-11-06T03:00:00Z'), at = s => new Date(t0 + s * 1000).toISOString();
// A tiny ESPN summary: Miami at Golden State, final 3-2 (the 2-0 basket is recorded, taken back, then given again).
const summary = {
  header: { competitions: [{ date: '2026-11-06T03:00Z', status: { type: { completed: true } }, competitors: [
    { homeAway: 'home', score: '2', team: { abbreviation: 'GS' } }, { homeAway: 'away', score: '3', team: { abbreviation: 'MIA' } }] }] },
  boxscore: { players: [{ statistics: [{ names: ['MIN', 'PTS', 'FG', '3PT', 'FT', 'REB', 'AST'], athletes: [
    { athlete: { id: '1', displayName: 'Wendell Carter Jr.', jersey: '34' }, stats: ['30', '3', '1-1', '1-1', '0-0', '0', '0'] },
    { athlete: { id: '2', displayName: 'Draymond Green', jersey: '23' }, stats: ['30', '2', '1-2', '0-0', '0-0', '1', '0'] },
    { athlete: { id: '3', displayName: 'José Alvarado', jersey: '15' }, stats: ['30', '0', '0-0', '0-0', '0-0', '0', '1'] }] }] }] },
  plays: [
    { wallclock: at(10), awayScore: 0, homeScore: 2, period: { number: 1 }, scoringPlay: true, scoreValue: 2, participants: [{ athlete: { id: '2' } }] },
    { wallclock: at(20), awayScore: 0, homeScore: 0, period: { number: 1 }, type: { text: "Coach's Challenge (Overturned)" } },
    { wallclock: at(30), awayScore: 0, homeScore: 2, period: { number: 1 }, type: { text: 'Defensive Rebound' }, participants: [{ athlete: { id: '2' } }] },
    { wallclock: at(40), awayScore: 3, homeScore: 2, period: { number: 2 }, scoringPlay: true, scoreValue: 3, participants: [{ athlete: { id: '1' } }, { athlete: { id: '3' } }] },
  ],
};

test('Kalshi NBA tickers parse into what they count', () => {
  assert.deepEqual(parseMarket('KXNBATOTAL-26NOV05MIAGSW-217'), { series: 'KXNBATOTAL', kind: 'total', event: '26NOV05MIAGSW', dateCode: '26NOV05', teams: 'MIAGSW', threshold: 217 });
  assert.equal(parseMarket('KXNBA1QTOTAL-26NOV05MIAGSW-51').periods[0], 1);
  assert.equal(parseMarket('KXNBATEAMTOTAL-26NOV05MIAGSW-GSW115').team, 'GSW');
  const prop = parseMarket('KXNBAPTS-26NOV05MIAGSW-MIAWCARTER34-15');
  assert.equal(prop.player, 'MIAWCARTER34');
  assert.equal(prop.stat, 'pts');
  assert.equal(prop.threshold, 15);
  assert.equal(parseMarket('KXNBAGAME-26NOV05MIAGSW-MIA'), null);
  assert.equal(parseMarket('KXNBAPTS-26NOV05MIAGSW-15'), null);
});

test('players, teams and plays are read from ESPN', () => {
  const game = compactGame(summary, '9');
  assert.equal(findPlayer('MIAWCARTER34', game.roster), '1'); // the "Jr." suffix is dropped
  assert.equal(findPlayer('NOPJALVARADO15', game.roster), '3'); // accents are dropped
  assert.equal(findPlayer('GSWDGREEN24', game.roster), null); // wrong jersey
  assert.equal(sideOf('GSW', game), 'home');
  assert.equal(sideOf('MIA', game), 'away');
  assert.deepEqual(game.box['1'], { pts: 3, reb: 0, ast: 0, threes: 1 });
  assert.equal(game.plays.length, 4);
});

test('a market is decided by the play that reaches its line, after corrections', () => {
  const game = compactGame(summary, '9');
  assert.equal(decidedAt(parseMarket('KXNBATOTAL-26NOV05MIAGSW-5'), game), t0 + 40000);
  assert.equal(decidedAt(parseMarket('KXNBATOTAL-26NOV05MIAGSW-6'), game), null); // the overturned basket is not counted twice
  assert.equal(decidedAt(parseMarket('KXNBATEAMTOTAL-26NOV05MIAGSW-GSW2'), game), t0 + 10000); // reached, though later taken back
  assert.equal(decidedAt(parseMarket('KXNBA1QTOTAL-26NOV05MIAGSW-3'), game), null); // the three came in the second quarter
  assert.equal(decidedAt(parseMarket('KXNBA3PT-26NOV05MIAGSW-MIAWCARTER34-1'), game), t0 + 40000);
  assert.equal(decidedAt(parseMarket('KXNBAAST-26NOV05MIAGSW-NOPJALVARADO15-1'), game), t0 + 40000);
  assert.equal(decidedAt(parseMarket('KXNBAREB-26NOV05MIAGSW-GSWDGREEN23-1'), game), t0 + 30000);
  // A player whose play tallies disagree with the box score is not trusted.
  const off = { ...game, box: { ...game.box, 2: { pts: 4, reb: 1, ast: 0, threes: 0 } } };
  assert.equal(decidedAt(parseMarket('KXNBAREB-26NOV05MIAGSW-GSWDGREEN23-1'), off), null);
  // A play log that does not end on the final score is not trusted.
  assert.equal(decidedAt(parseMarket('KXNBATOTAL-26NOV05MIAGSW-5'), { ...game, away: { ...game.away, score: 4 } }), null);
});
