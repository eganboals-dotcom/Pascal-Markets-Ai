import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReplayDataset, buildTrainingDataset } from '../src/dataset.js';

const settlements = [{ gameId: 'game', resolvedAt: 100000, homeWon: 1, source: 'verified-fixture', verified: true }];
const quote = at => ({ gameId: 'game', outcome: 'home', receivedAt: at, ask: 0.5 });
const odds = at => ({ gameId: 'game', receivedAt: at, homeOdds: 1.5, awayOdds: 3 });

test('replay dataset performs receipt-time joins without using future odds', () => {
  const result = buildReplayDataset([quote(1000), quote(3000)], [odds(2000), odds(4000)], settlements);
  assert.deepEqual(result.observations.map(row => row.observedAt), [2000, 3000, 4000]);
  assert.equal(result.observations[0].quote.receivedAt, 1000);
  assert.equal(result.observations[1].sportsbook.receivedAt, 2000);
  assert.equal(result.observations[2].sportsbook.receivedAt, 4000);
});

test('dataset requires verified outcomes and excludes post-resolution observations', () => {
  assert.throws(() => buildReplayDataset([], [], [{ ...settlements[0], verified: false }]), /verified/);
  const result = buildReplayDataset([quote(100000)], [odds(100000)], settlements);
  assert.equal(result.observations.length, 0);
  assert.equal(result.skipped.afterResolution, 2);
});

test('training builder enforces pregame timing and regulation clock semantics', () => {
  const pregame = [{ gameId: 'game', probability: 0.5, recordedAt: 500, startsAt: 1000 }];
  const state = { gameId: 'game', sourceAt: 2000, receivedAt: 2100, period: 4, clockSeconds: 60,
    homeScore: 90, awayScore: 89, status: 'InProgress' };
  const result = buildTrainingDataset([state, { ...state, period: 5 }, { ...state, receivedAt: 10000 }], pregame, settlements);
  assert.equal(result.observations.length, 1);
  assert.equal(result.observations[0].secondsRemaining, 60);
  assert.equal(result.skipped.unsupportedState, 1);
  assert.equal(result.skipped.invalidTime, 1);
  assert.throws(() => buildTrainingDataset([state], [{ ...pregame[0], recordedAt: 1100 }], settlements), /before tipoff/);
});
