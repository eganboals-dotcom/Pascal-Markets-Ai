import test from 'node:test';
import assert from 'node:assert/strict';
import { centralEuropean, elapsedAt, fitModel, goalLag, minuteAt, overChance, parseMatches, scorePrints } from '../src/agents/soccer-inplay.js';

const csv = `league,league_name,country,season,match_date,time,home_team,away_team,ht_result,ft_result,home_goals,away_goals,total_goals,result,first_goal_time,all_goal_times
a,A,X,2024-2025,2024-09-01,15:00:00,H,W,1:0,2:1,2,1,3,H,10,"10,60,90"
a,A,X,2024-2025,2024-09-08,,H,W,0:0,0:0,0,0,0,D,,
b,B,Y,2024-2025,2024-09-08,18:30:00,P,Q,0:0,1:0,1,0,1,H,,
b,B,Y,2024-2025,2024-09-09,18:30:00,P,Q,0:0,1:0,1,0,1,H,80,80`;
const stoppage = `league,league_name,country,season,match_date,time,home_team,away_team,ht_result,ft_result,home_goals,away_goals,total_goals,result,first_goal_time,all_goal_times
c,C,Z,2025-2026,2025-12-02,20:30:00,H,W,1:0,2:1,2,1,3,H,47,"47,48,95"`;

test('matches parse with their goal minutes, and a match with an untimed goal is left out', () => {
  const ms = parseMatches(csv);
  assert.equal(ms.length, 3);
  assert.deepEqual(ms[0].goals, [10, 60, 90]);
  // 47 is first-half stoppage (half time was 1-0), 48 the second half, 95 second-half stoppage.
  const [s] = parseMatches(stoppage);
  assert.deepEqual(s.goals, [45, 48, 90]);
  assert.deepEqual(s.elapsed, [47, 66, 113]);
  assert.equal(ms[0].kickoff, Date.parse('2024-09-01T13:00:00Z')); // 15:00 in Berlin summer time
  assert.equal(centralEuropean('2025-11-24', '21:00:00'), Date.parse('2025-11-24T20:00:00Z')); // Man Utd v Everton, winter
  assert.equal(ms[1].kickoff, null);
});

test('the model spreads a league rate over the minutes left, and a passed line is certain', () => {
  const model = fitModel(parseMatches(csv), { prior: 0 });
  assert.equal(model.share[0], 1);
  assert.equal(model.share[60], 0.5); // goals at 80 and 90 of four
  assert.equal(model.share[90], 0);
  assert.equal(model.rate.get('a'), 1.5);
  const mu = 1.5 * 0.5, p = overChance(model, 'a', 60, 1, 1.5); // one more goal needed
  assert.ok(Math.abs(p - (1 - Math.exp(-mu))) < 1e-12);
  assert.equal(overChance(model, 'a', 20, 3, 2.5), 1);
  assert.equal(overChance(model, 'a', 90, 2, 2.5), 0);
  assert.equal(overChance(model, 'zz', 0, 0, 0.5), 1 - Math.exp(-model.overall)); // an unknown league uses the overall rate
});

test('in-play prints skip the minutes near a goal and the break, and a cheap taker print becomes a pick', () => {
  const model = { share: Array.from({ length: 91 }, (_, t) => 1 - t / 90), rate: new Map([['a', 2.7]]), overall: 2.7 };
  const kickoff = Date.parse('2026-01-04T15:00:00Z'), at = min => new Date(kickoff + min * 60000).toISOString();
  const print = (min, yes, taker) => ({ created_time: at(min), yes_price_dollars: String(yes), taker_side: taker });
  const match = { league: 'a', kickoff, goals: [20] }; // a goal in minute 20, about 20 minutes after kickoff
  const trades = [print(10, 0.75, 'yes'), print(21, 0.5, 'yes'), print(30, 0.2, 'yes'), print(46, 0.5, 'yes'), print(31, 0.2, 'yes')];
  const { rows, picks } = scorePrints(match, { line: 1.5, result: 'yes' }, trades, model, () => 0.01);
  assert.deepEqual(rows.map(r => r.minute), [10, 30]); // minute 21 is near the goal, 46 is at the break
  const p30 = overChance(model, 'a', 30, 1, 1.5);
  assert.equal(picks.length, 1); // the print at 31 falls in the same 5-minute bucket as 30
  assert.equal(picks[0].side, 'yes');
  assert.ok(Math.abs(picks[0].edge - (p30 - 0.2 - 0.01)) < 1e-12);
  assert.ok(Math.abs(picks[0].pnl - 0.79) < 1e-12);
  assert.equal(scorePrints(match, { line: 0.5, result: 'yes' }, [print(30, 0.99, 'no')], model, () => 0).rows.length, 0); // line passed
});

test('the guard before a goal is optional, since only hindsight knows a goal is coming', () => {
  const model = { share: Array.from({ length: 91 }, (_, t) => 1 - t / 90), rate: new Map([['a', 2.7]]), overall: 2.7 };
  const kickoff = Date.parse('2026-01-04T15:00:00Z'), at = min => new Date(kickoff + min * 60000).toISOString();
  const match = { league: 'a', kickoff, goals: [20] }, trades = [{ created_time: at(17), yes_price_dollars: '0.5', taker_side: 'yes' }, { created_time: at(22), yes_price_dollars: '0.5', taker_side: 'yes' }];
  const minutes = opts => scorePrints(match, { line: 2.5, result: 'yes' }, trades, model, () => 0, opts).rows.map(r => r.minute);
  assert.deepEqual(minutes({ guardMin: 4 }), []); // 3 minutes before and 2 after the goal
  assert.deepEqual(minutes({ guardMin: 4, guardBefore: 0 }), [17]);
});

test('the clock check measures the settle jump against the deciding goal', () => {
  const kickoff = Date.parse('2026-01-04T15:00:00Z'), at = min => new Date(kickoff + min * 60000).toISOString();
  const match = { kickoff, goals: [10, 60], elapsed: [10, 78], total: 2 };
  const trades = [{ created_time: at(70), yes_price_dollars: '0.98' }, { created_time: at(72), yes_price_dollars: '0.40' }, // a stray print
    { created_time: at(79), yes_price_dollars: '0.97' }, { created_time: at(85), yes_price_dollars: '0.99' }];
  assert.equal(goalLag(match, { line: 1.5, result: 'yes' }, trades), 1); // the second goal, about 78 minutes in
  assert.equal(goalLag(match, { line: 2.5, result: 'no' }, trades), null);
});

test('the clock maps real minutes after kickoff to match minutes around the break', () => {
  assert.equal(minuteAt(30), 30);
  assert.equal(minuteAt(55), 45);
  assert.equal(minuteAt(80), 62);
  assert.equal(minuteAt(-1), null);
  assert.equal(minuteAt(120), null);
  assert.equal(elapsedAt(62), 80);
});
