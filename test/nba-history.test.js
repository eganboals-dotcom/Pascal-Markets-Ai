import test from 'node:test';
import assert from 'node:assert/strict';
import { historicalRows } from '../src/nba-history.js';

test('pregame ratings use completed games and ignore future outcomes', () => {
  const game = (id, startsAt, resolvedAt, homeWon) => ({ id, home: 'h', away: 'a', startsAt, resolvedAt,
    homeWon, neutral: false, observations: [{ observedAt: startsAt + 1, homeScore: 10, awayScore: 9, secondsRemaining: 2600 }] });
  const first = game('1', 0, 10, 1);
  const overlapping = game('2', 5, 20, 1);
  const later = game('3', 15, 30, 1);
  const rows = historicalRows([later, first, overlapping]);
  assert.equal(rows[0].pregameHomeProbability, rows[1].pregameHomeProbability);
  assert.ok(rows[2].pregameHomeProbability > rows[1].pregameHomeProbability);
  const changed = historicalRows([first, { ...overlapping, homeWon: 0 }, later]);
  assert.equal(changed[2].pregameHomeProbability, rows[2].pregameHomeProbability);
});

test('ratings regress toward the mean after an offseason gap', () => {
  const day = 86400000;
  const game = (id, startsAt) => ({ id, home: 'h', away: 'a', startsAt, resolvedAt: startsAt + 1, homeWon: 1,
    neutral: true, observations: [{ observedAt: startsAt + 0.5, homeScore: 0, awayScore: 0, secondsRemaining: 2800 }] });
  const sameSeason = historicalRows([game('1', 0), game('2', 10 * day)]);
  const nextSeason = historicalRows([game('1', 0), game('2', 100 * day)]);
  assert.ok(sameSeason[1].pregameHomeProbability > nextSeason[1].pregameHomeProbability);
  assert.ok(nextSeason[1].pregameHomeProbability > 0.5);
});
