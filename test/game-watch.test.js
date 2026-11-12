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
  assert.deepEqual(parseMarket('KXNBATOTAL-26NOV05MIAGSW-217'), { series: 'KXNBATOTAL', league: 'nba', kind: 'total', event: '26NOV05MIAGSW', dateCode: '26NOV05', teams: 'MIAGSW', threshold: 217 });
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

test('hockey plays name scorer and assisters, football plays come from drives, shootouts are skipped', () => {
  const header = (away, home) => ({ competitions: [{ competitors: [{ homeAway: 'away', score: String(away), team: { abbreviation: 'SJ' } }, { homeAway: 'home', score: String(home), team: { abbreviation: 'LA' } }] }] });
  const goal = (s, away, home, period, scorer, ...assisters) => ({ wallclock: at(s), awayScore: away, homeScore: home, period: { number: period }, scoringPlay: true, scoreValue: 1,
    participants: [{ athlete: { id: scorer }, type: 'scorer' }, ...assisters.map(id => ({ athlete: { id }, type: 'assister' }))] });
  const hockey = {
    header: header(0, 2),
    boxscore: { players: [{ statistics: [{ name: 'forwards', labels: ['G', 'A'], athletes: [{ athlete: { id: '8', displayName: 'Drew Doughty', jersey: '8' }, stats: ['2', '0'] }] },
      { name: 'goalies', labels: ['GA', 'SA'], athletes: [{ athlete: { id: '31', displayName: 'Some Goalie', jersey: '31' }, stats: ['0', '20'] }] }] }] },
    plays: [goal(10, 0, 1, 1, '8', '9', '10'), goal(20, 0, 2, 3, '8')],
  };
  const nhl = compactGame(hockey, '1', 'nhl');
  assert.deepEqual(nhl.plays[0].assisters, ['9', '10']);
  assert.deepEqual(nhl.box['8'], { goals: 2, ast: 0 }); // assists still check the play log against the box score
  assert.equal(nhl.box['31'], undefined); // goalies have no goal or assist columns
  assert.equal(decidedAt(parseMarket('KXNHLGOAL-26NOV04SJLA-LADDOUGHTY8-2'), nhl), t0 + 20000);
  assert.equal(decidedAt(parseMarket('KXNHL1PTOTAL-26NOV04SJLA-1'), nhl), t0 + 10000);
  assert.equal(parseMarket('KXNHLAST-26NOV04SJLA-LADDOUGHTY8-1'), null); // assists are not watched
  const shootout = compactGame({ ...hockey, header: header(1, 3), plays: [...hockey.plays, goal(30, 1, 2, 4, '9'), goal(40, 1, 3, 5, '8')] }, '1', 'nhl');
  assert.equal(shootout.shootout, true);
  assert.equal(decidedAt(parseMarket('KXNHLTOTAL-26NOV04SJLA-3'), shootout), null);
  const football = compactGame({ header: header(3, 7), drives: {
    previous: [{ plays: [{ id: 'a', sequenceNumber: '1', wallclock: at(5), awayScore: 3, homeScore: 0, period: { number: 1 }, scoringPlay: true }] }],
    current: { plays: [{ id: 'b', sequenceNumber: '2', wallclock: at(15), awayScore: 3, homeScore: 7, period: { number: 2 }, scoringPlay: true }] } } }, '2', 'nfl');
  assert.equal(football.plays.length, 2);
  assert.equal(decidedAt(parseMarket('KXNFLTOTAL-26NOV04SJLA-10'), football), t0 + 15000);
  assert.equal(decidedAt(parseMarket('KXNFL1QTOTAL-26NOV04SJLA-4'), football), null);
});
