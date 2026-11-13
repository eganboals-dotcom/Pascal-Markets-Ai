import test from 'node:test';
import assert from 'node:assert/strict';
import { compactGame, corePlay, decidedAt, decision, findPlayer, matchEvent, parseMarket, sideOf } from '../src/agents/game-watch.js';
import { gameIndex } from '../src/agents/fair-odds.js';

const t0 = Date.parse('2026-11-06T03:00:00Z'), at = s => new Date(t0 + s * 1000).toISOString();
// A tiny ESPN summary: Miami at Golden State, final 3-2 (the 2-0 basket is recorded, taken back, then given again).
const summary = {
  header: { competitions: [{ date: '2026-11-06T03:00Z', status: { period: 4, type: { completed: true } }, competitors: [
    { homeAway: 'home', score: '2', team: { abbreviation: 'GS' }, linescores: [{ value: 2 }, { value: 0 }, { value: 0 }, { value: 0 }] },
    { homeAway: 'away', score: '3', team: { abbreviation: 'MIA' }, linescores: [{ value: 0 }, { value: 3 }, { value: 0 }, { value: 0 }] }] }] },
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
  assert.equal(parseMarket('KXNBAGAME-26NOV05MIAGSW-MIA').team, 'MIA');
  assert.equal(parseMarket('KXNBAGAME-26NOV05MIAGSW-MIA3'), null);
  assert.equal(parseMarket('KXNBASPREAD-26NOV05MIAGSW-GSW10').threshold, 10);
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
  const header = (away, home) => ({ competitions: [{ status: { period: 3, type: { completed: true } }, competitors: [{ homeAway: 'away', score: String(away), team: { abbreviation: 'SJ' }, linescores: [{ value: 0 }] },
    { homeAway: 'home', score: String(home), team: { abbreviation: 'LA' }, linescores: [{ value: 1 }, { value: 0 }, { value: 1 }] }] }] });
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
  assert.equal(decidedAt(parseMarket('KXNHL1PTOTAL-26NOV04SJLA-1'), nhl), t0 + 20000); // once the first period is over
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

test('college football plays come from drives and basketball halves count only their own points', () => {
  const header = (away, home) => ({ competitions: [{ status: { period: 4, type: { completed: true } }, competitors: [{ homeAway: 'away', score: '3', team: { abbreviation: 'MIA' }, linescores: away.map(value => ({ value })) },
    { homeAway: 'home', score: '7', team: { abbreviation: 'ND' }, linescores: home.map(value => ({ value })) }] }] });
  const football = compactGame({ header: header([3, 0, 0, 0], [0, 0, 7, 0]), drives: {
    previous: [{ plays: [{ id: 'a', sequenceNumber: '1', wallclock: at(5), awayScore: 3, homeScore: 0, period: { number: 1 }, scoringPlay: true }] }],
    current: { plays: [{ id: 'b', sequenceNumber: '2', wallclock: at(15), awayScore: 3, homeScore: 7, period: { number: 3 }, scoringPlay: true },
      { id: 'c', sequenceNumber: '3', wallclock: at(25), awayScore: 3, homeScore: 7, period: { number: 4 }, type: { text: 'End Game' } }] } } }, '3', 'ncaaf');
  assert.equal(decidedAt(parseMarket('KXNCAAFTOTAL-26NOV07MIAND-10'), football), t0 + 15000);
  assert.equal(decidedAt(parseMarket('KXNCAAF2HTOTAL-26NOV07MIAND-7'), football), t0 + 25000); // the last half waits for the end of the game
  assert.equal(decidedAt(parseMarket('KXNCAAF1HTOTAL-26NOV07MIAND-4'), football), null);
  assert.equal(decidedAt(parseMarket('KXNCAAFTEAMTOTAL-26NOV07MIAND-ND7'), football), t0 + 15000);
  const basketball = compactGame({ header: header([3, 0], [0, 7]), plays: [
    { wallclock: at(5), awayScore: 3, homeScore: 0, period: { number: 1 } }, { wallclock: at(15), awayScore: 3, homeScore: 7, period: { number: 2 } },
    { wallclock: at(25), awayScore: 3, homeScore: 7, period: { number: 2 }, type: { text: 'End of Game' } }] }, '4', 'ncaab');
  assert.deepEqual(parseMarket('KXNCAAMB1HTOTAL-26NOV07MIAND-3').periods, [1]);
  assert.equal(decidedAt(parseMarket('KXNCAAMB1HTOTAL-26NOV07MIAND-4'), basketball), null);
  assert.equal(decidedAt(parseMarket('KXNCAAMB2HTOTAL-26NOV07MIAND-7'), basketball), t0 + 25000);
});

test('fresher core-API plays extend the summary, and the box score is checked against the summary part only', () => {
  const numbered = { ...summary, plays: summary.plays.map((p, i) => ({ ...p, sequenceNumber: String(i + 1) })) };
  const ref = id => ({ $ref: `http://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/seasons/2027/athletes/${id}?lang=en` });
  const newer = [
    { ...numbered.plays[3], participants: [] }, // already in the summary: ignored
    { sequenceNumber: '5', wallclock: at(50), awayScore: 3, homeScore: 4, period: { number: 2 }, scoringPlay: true, scoreValue: 2,
      participants: [{ athlete: ref('3'), type: 'assister', order: 2 }, { athlete: ref('2'), type: 'shooter', order: 1 }] },
  ].map(p => corePlay(p, 'nba'));
  const game = compactGame(numbered, '9', 'nba', newer);
  assert.equal(game.plays.length, 5);
  assert.equal(game.checkedPlays, 4);
  assert.deepEqual([game.plays[4].scorer, game.plays[4].assisters], ['2', ['3']]);
  assert.equal(decidedAt(parseMarket('KXNBATOTAL-26NOV05MIAGSW-7'), game), t0 + 50000);
  assert.equal(decidedAt(parseMarket('KXNBAPTS-26NOV05MIAGSW-GSWDGREEN23-4'), game), t0 + 50000); // box says 2 before the new basket
  assert.equal(decidedAt(parseMarket('KXNBAAST-26NOV05MIAGSW-NOPJALVARADO15-2'), game), t0 + 50000);
});

test('the final whistle decides winners, spreads and totals still short of their line', () => {
  const ended = compactGame({ ...summary, plays: [...summary.plays,
    { wallclock: at(50), awayScore: 3, homeScore: 2, period: { number: 3 } },
    { wallclock: at(60), awayScore: 3, homeScore: 2, period: { number: 4 }, type: { text: 'End Game' } }] }, '9');
  const d = (ticker, game = ended) => decision(parseMarket(ticker), game), final = t0 + 60000;
  assert.deepEqual(d('KXNBAGAME-26NOV05MIAGSW-MIA'), { side: 'yes', at: final });
  assert.deepEqual(d('KXNBAGAME-26NOV05MIAGSW-GSW'), { side: 'no', at: final });
  assert.deepEqual(d('KXNBASPREAD-26NOV05MIAGSW-MIA1'), { side: 'yes', at: final }); // won by 1: "wins by 1 or more"
  assert.deepEqual(d('KXNBASPREAD-26NOV05MIAGSW-MIA2'), { side: 'no', at: final });
  assert.deepEqual(d('KXNBATOTAL-26NOV05MIAGSW-5'), { side: 'yes', at: t0 + 40000 });
  assert.deepEqual(d('KXNBATOTAL-26NOV05MIAGSW-6'), { side: 'no', at: final });
  assert.deepEqual(d('KXNBATEAMTOTAL-26NOV05MIAGSW-MIA4'), { side: 'no', at: final });
  assert.deepEqual(d('KXNBA1HTOTAL-26NOV05MIAGSW-6'), { side: 'no', at: t0 + 50000 }); // short when the third quarter starts
  assert.equal(d('KXNBAPTS-26NOV05MIAGSW-MIAWCARTER34-4'), null); // player props are Yes only
  // Before the end-of-game play, winners and game totals wait; a team code placed on the wrong side of the event is skipped.
  const live = compactGame(summary, '9');
  assert.equal(d('KXNBAGAME-26NOV05MIAGSW-MIA', live), null);
  assert.equal(d('KXNBATOTAL-26NOV05MIAGSW-6', live), null);
  assert.equal(d('KXNBAGAME-26NOV05GSWMIA-GSW'), null);
  // An end-of-game play off the score line is not trusted.
  assert.equal(d('KXNBAGAME-26NOV05MIAGSW-MIA', { ...ended, plays: ended.plays.map(p => (p.end ? { ...p, away: 4 } : p)) }), null);
  assert.equal(decidedAt(parseMarket('KXNBATOTAL-26NOV05MIAGSW-6'), ended), null); // decidedAt stays Yes only
});

test('an event code is matched only when the game codes spell it well', () => {
  const index = gameIndex([{ league: 'ncaab', date: '2026-11-05', awayCode: 'CBBL', homeCode: 'LIN', eventId: '1' },
    { league: 'ncaab', date: '2026-11-03', awayCode: 'CLE', homeCode: 'MIZ', eventId: '2' }]);
  assert.equal(matchEvent(parseMarket('KXNCAAMBTOTAL-26NOV05BELLIND-150'), index), null); // BEL+LIND fits CBBL at LIN only loosely
  assert.equal(matchEvent(parseMarket('KXNCAAMBTOTAL-26NOV03CLEVMIZZ-150'), index)?.eventId, '2');
});

test('a core-API play with an empty participant keeps the others', () => {
  const p = corePlay({ participants: [null, { order: 1, athlete: { $ref: 'http://x/athletes/7?lang=en' } }] }, 'ncaab');
  assert.deepEqual(p.participants, [{ athlete: { id: '7' } }]);
});

test('current decisions wait through a recovered score and reject historical crossings after a correction', () => {
  const game = compactGame(summary, '9');
  const total = parseMarket('KXNBATOTAL-26NOV05MIAGSW-5');
  const corrected = { ...game, home: { ...game.home, score: 0 }, plays: [...game.plays, { ...game.plays.at(-1), t: t0 + 50000, home: 0 }] };
  corrected.checkedPlays = corrected.plays.length;
  assert.equal(decision(total, corrected).side, 'yes'); // historical first crossing kept for the replay
  assert.equal(decision(total, corrected, { current: true }), null); // time left to recover
  const end = { ...corrected.plays.at(-1), end: true, t: t0 + 60000 };
  const final = { ...corrected, plays: [...corrected.plays, end], checkedPlays: corrected.plays.length + 1 };
  assert.equal(decision(total, final, { current: true }).side, 'no');
  assert.equal(decision(total, { ...final, home: { ...final.home, score: 2 } }, { current: true }), null);
  const prop = parseMarket('KXNBAPTS-26NOV05MIAGSW-MIAWCARTER34-4');
  assert.equal(decision(prop, game, { current: true }), null);
  const ended = { ...game, plays: [...game.plays, { ...game.plays.at(-1), end: true, scorer: null, assisters: [], rebounder: null, value: 0, t: t0 + 60000 }], checkedPlays: game.plays.length + 1 };
  assert.equal(decision(prop, ended, { current: true }).side, 'no');
});

test('half and quarter totals wait for their periods to end and must agree with the line score', () => {
  // DET at WSH, Nov 12: the play log ended the first quarter at 67 points, the line score (and Kalshi) at 65.
  const play = (s, away, home, period) => ({ wallclock: at(s), awayScore: away, homeScore: home, period: { number: period } });
  const game = (lines, status, plays) => compactGame({ header: { competitions: [{ status, competitors: [
    { homeAway: 'away', score: String(plays.at(-1).awayScore), team: { abbreviation: 'DET' }, linescores: lines[0].map(value => ({ value })) },
    { homeAway: 'home', score: String(plays.at(-1).homeScore), team: { abbreviation: 'WSH' }, linescores: lines[1].map(value => ({ value })) }] }] }, plays }, '1');
  const plays = [play(10, 33, 34, 1), play(20, 35, 34, 2)], q1 = t => parseMarket(`KXNBA1QTOTAL-26NOV12DETWAS-${t}`);
  const off = game([[33, 2], [32, 0]], { period: 2 }, plays);
  assert.equal(decision(q1(66), off), null); // the log says Over 65.5, the line score says not: no call either way
  assert.equal(decision(q1(66), off, { current: true }), null);
  const agreed = game([[33, 2], [34, 0]], { period: 2 }, plays);
  assert.deepEqual(decision(q1(66), agreed), { side: 'yes', at: t0 + 20000 }); // decided when the second quarter starts, not mid-quarter
  assert.deepEqual(decision(q1(68), agreed), { side: 'no', at: t0 + 20000 });
  assert.equal(decision(q1(66), game([[33], [34]], { period: 1 }, plays)), null); // the summary still shows the first quarter: its line score may move
  assert.equal(decision(q1(66), game([[33, 2], [34, 0]], { period: 2 }, [play(10, 33, 34, 1)])), null); // the quarter is not over in the plays
});
