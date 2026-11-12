import test from 'node:test';
import assert from 'node:assert/strict';
import { compactScore, held, soccerDecision, soccerKind, soccerState, tennisDecision, tennisKind, tennisState, TENNIS_TYPE } from '../src/agents/score-watch.js';

const A = 'a-id', B = 'b-id';
const round = (outcome, score) => ({ outcome, score });
const live = (one, two, extra = {}) => ({ competitor1_id: A, competitor2_id: B, competitor1_round_scores: one, competitor2_round_scores: two, winner: '', status: 'started', ...extra });
const m = (ticker, extra = {}) => ({ ticker, event_ticker: ticker.slice(0, ticker.lastIndexOf('-')), ...extra });

test('tennis kinds come from the series name, EXACTMATCH before MATCH', () => {
  assert.equal(tennisKind('KXATPCHALLENGERMATCH'), 'MATCH');
  assert.equal(tennisKind('KXATPEXACTMATCH'), 'EXACTMATCH');
  assert.equal(tennisKind('KXWTASETWINNER'), 'SETWINNER');
  assert.equal(tennisKind('KXATPGTOTAL'), 'GTOTAL');
  assert.equal(soccerKind('KXAFCON1HTOTAL'), '1HTOTAL');
  assert.equal(soccerKind('KXAFCONTEAMTOTAL'), 'TEAMTOTAL');
  assert.equal(soccerKind('KXBRASILEIROB1H'), '1H');
  assert.equal(soccerKind('KXEFLL1GAME'), 'GAME');
});

test('a tennis set, a games total passed and an impossible exact score are decided mid-match; the rest wait for a normal finish', () => {
  // A took set 1 7-6, B leads set 2 4-1: 18 games so far.
  const s = tennisState(live([round('winner', 7), round('ongoing', 1)], [round('loser', 6), round('ongoing', 4)]));
  const set = n => m(`KXATPSETWINNER-26NOV13ABAB-${n}-A`, { custom_strike: { tennis_competitor: A } });
  assert.equal(tennisDecision(set(1), s), 'yes');
  assert.equal(tennisDecision(m('KXATPSETWINNER-26NOV13ABAB-1-B', { custom_strike: { tennis_competitor: B } }), s), 'no');
  assert.equal(tennisDecision(set(2), s), null);
  assert.equal(tennisDecision(m('KXATPGTOTAL-26NOV13ABAB-18', { floor_strike: 17.5 }), s), 'yes');
  assert.equal(tennisDecision(m('KXATPGTOTAL-26NOV13ABAB-20', { floor_strike: 19.5 }), s), null); // under only at the finish
  assert.equal(tennisDecision(m('KXATPEXACTMATCH-26NOV13ABAB-B20', { custom_strike: { 'Set Score': '2-0', tennis_competitor: B } }), s), 'no');
  assert.equal(tennisDecision(m('KXATPEXACTMATCH-26NOV13ABAB-A20', { custom_strike: { 'Set Score': '2-0', tennis_competitor: A } }), s), null);
  assert.equal(tennisDecision(m('KXATPMATCH-26NOV13ABAB-A', { custom_strike: { tennis_competitor: A } }), s), null);
  assert.equal(tennisDecision(m('KXATPGSPREAD-26NOV13ABAB-A2', { floor_strike: 1.5, custom_strike: { tennis_competitor: A } }), s), null);
});

test('at a normal finish the match, exact score, spread and games under are decided; a retirement decides none of them', () => {
  const done = live([round('winner', 7), round('winner', 7)], [round('loser', 5), round('loser', 5)], { winner: A, status: 'closed' });
  const s = tennisState(done);
  assert.equal(tennisDecision(m('KXITFMATCH-26NOV12ABAB-A', { custom_strike: { tennis_competitor: A } }), s), 'yes');
  assert.equal(tennisDecision(m('KXITFMATCH-26NOV12ABAB-B', { custom_strike: { tennis_competitor: B } }), s), 'no');
  assert.equal(tennisDecision(m('KXATPEXACTMATCH-26NOV13ABAB-A20', { custom_strike: { 'Set Score': '2-0', tennis_competitor: A } }), s), 'yes');
  assert.equal(tennisDecision(m('KXATPGTOTAL-26NOV13ABAB-25', { floor_strike: 24.5 }), s), 'no'); // 24 games
  assert.equal(tennisDecision(m('KXATPGSPREAD-26NOV13ABAB-A4', { floor_strike: 3.5, custom_strike: { tennis_competitor: A } }), s), 'yes'); // +4
  const retired = tennisState(live([round('winner', 6), round('ongoing', 2)], [round('loser', 3), round('ongoing', 1)], { winner: A, status: 'closed' }));
  assert.equal(retired.finished, false);
  assert.equal(tennisDecision(m('KXITFMATCH-26NOV12ABAB-A', { custom_strike: { tennis_competitor: A } }), retired), null);
  assert.equal(tennisDecision(m('KXATPGTOTAL-26NOV13ABAB-20', { floor_strike: 19.5 }), retired), null);
  // A match tiebreak (10-8) counts as one game.
  const mtb = tennisState(live([round('winner', 6), round('loser', 4), round('winner', 10)], [round('loser', 4), round('winner', 6), round('loser', 8)], { winner: A }));
  assert.equal(mtb.total, 21);
  assert.equal(tennisState({}), null);
});

const H = 'home', W = 'away', T = 'tie';
const soccer = (extra = {}) => ({ status: 'live', match_status: 'live', half: '2nd Half', home_same_game_score: 2, away_same_game_score: 0,
  period_scores: [{ number: 1, home_score: 1, away_score: 0, type: 'regular_period' }, { number: 2, home_score: 1, away_score: 0, type: 'regular_period' }], ...extra });

test('soccer totals, team totals and first-half markets are decided by goals; results wait for full time', () => {
  const s = soccerState(soccer(), H, W, T), d = (t, extra) => soccerDecision(m(t, extra), s);
  assert.equal(d('KXAFCONTOTAL-26NOV13HW-2', { floor_strike: 1.5 }), 'yes');
  assert.equal(d('KXAFCONTOTAL-26NOV13HW-3', { floor_strike: 2.5 }), null);
  assert.equal(d('KXAFCONTEAMTOTAL-26NOV13HW-H1', { floor_strike: 1.5, custom_strike: { soccer_team: H } }), 'yes');
  assert.equal(d('KXAFCONTEAMTOTAL-26NOV13HW-W1', { floor_strike: 0.5, custom_strike: { soccer_team: W } }), null);
  assert.equal(d('KXAFCON1HTOTAL-26NOV13HW-2', { floor_strike: 1.5 }), 'no'); // the first half ended 1-0
  assert.equal(d('KXAFCON1HBTTS-26NOV13HW-BTTS'), 'no');
  assert.equal(d('KXAFCON1H-26NOV13HW-H', { custom_strike: { soccer_team: H } }), 'yes');
  assert.equal(d('KXAFCON1H-26NOV13HW-TIE', { custom_strike: { soccer_team: T } }), 'no');
  assert.equal(d('KXAFCONBTTS-26NOV13HW-BTTS'), null);
  assert.equal(d('KXAFCONGAME-26NOV13HW-H', { custom_strike: { soccer_team: H } }), null);
  assert.equal(d('KXAFCONSCORE-26NOV13HW-H1W0', { custom_strike: { home_score: '1', away_score: '0', home_team_id: H } }), 'no');
  assert.equal(d('KXAFCONSCORE-26NOV13HW-H2W1', { custom_strike: { home_score: '2', away_score: '1', home_team_id: H } }), null);
  assert.equal(d('KXAFCONFTTS-26NOV13HW-H', { custom_strike: { soccer_team: H } }), 'yes');
  assert.equal(d('KXAFCONFTTS-26NOV13HW-W', { custom_strike: { soccer_team: W } }), 'no');
  assert.equal(d('KXAFCONFTTS-26NOV13HW-TIE', { custom_strike: { soccer_team: T } }), 'no');
});

test('at full time soccer results use the regulation score, and extra time without one decides nothing', () => {
  const ft = soccerState(soccer({ status: 'closed', match_status: 'ended', half: 'FT', home_regulation_score: 2, away_regulation_score: 1, home_same_game_score: 3, away_same_game_score: 1 }), H, W, T);
  const d = (t, extra) => soccerDecision(m(t, extra), ft);
  assert.equal(d('KXAFCONGAME-26NOV13HW-H', { custom_strike: { soccer_team: H } }), 'yes');
  assert.equal(d('KXAFCONGAME-26NOV13HW-TIE', { custom_strike: { soccer_team: T } }), 'no');
  assert.equal(d('KXAFCONSPREAD-26NOV13HW-H2', { floor_strike: 1.5, custom_strike: { soccer_team: H } }), 'no'); // won by 1, not 3
  assert.equal(d('KXAFCONBTTS-26NOV13HW-BTTS'), 'yes');
  assert.equal(d('KXAFCONTOTAL-26NOV13HW-4', { floor_strike: 3.5 }), 'no');
  assert.equal(d('KXAFCONSCORE-26NOV13HW-H2W1', { custom_strike: { home_score: '2', away_score: '1', home_team_id: H } }), 'yes');
  assert.equal(soccerState(soccer({ half: 'Extra Time 1st Half' }), H, W, T), null);
  assert.equal(soccerState(soccer({ status: 'closed', match_status: 'ended' }), H, W, T), null); // over, but no regulation score yet
});

test('a decision counts only after it has held, and a score log keeps only the score', () => {
  const seen = new Map();
  assert.equal(held(seen, 'X', 'yes', 0, 60000), false);
  assert.equal(held(seen, 'X', 'yes', 30000, 60000), false);
  assert.equal(held(seen, 'X', 'yes', 60000, 60000), true);
  assert.equal(held(seen, 'X', null, 61000, 60000), false); // the goal was taken back
  assert.equal(held(seen, 'X', 'yes', 62000, 60000), false); // and the wait starts again
  assert.equal(held(new Map(), 'Y', 'no', 0, 0), true);
  assert.deepEqual(compactScore(TENNIS_TYPE, live([round('winner', 6)], [round('loser', 2)])), { status: 'started', winner: null, sets: [[6, 2, 'winner']] });
});
