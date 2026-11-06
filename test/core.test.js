import test from 'node:test';
import assert from 'node:assert/strict';
import { train, predict } from '../src/model.js';
import { sportsbookSignal, decimalOdds } from '../src/odds.js';
import { replay } from '../src/replay.js';

const config = { signal: 'sportsbook', initialCash: 100, orderBudget: 10, maxExposure: 10,
  minEdge: 0.04, feePerShare: 0.02, delayMs: 3000, maxAgeMs: 2000 };
function row(gameId, at, ask = 0.4) {
  return { gameId, observedAt: at, resolvedAt: 100000, homeScore: 60, awayScore: 50,
    secondsRemaining: 1200, pregameHomeProbability: 0.5, homeWon: 1,
    quote: { gameId, assetId: 'asset-' + gameId, sourceAt: at, receivedAt: at,
      ask, askSize: 100, outcome: 'home', marketType: 'moneyline', includesOvertime: true,
      acceptingOrders: true, secondsDelay: 3 },
    sportsbook: { gameId, sourceAt: at, receivedAt: at, homeOdds: 1.5, awayOdds: 3,
      marketType: 'moneyline', includesOvertime: true, suspended: false } };
}

test('American odds and proportional margin removal', () => {
  assert.equal(decimalOdds(-200, 'american'), 1.5);
  assert.equal(decimalOdds(200, 'american'), 3);
  const signal = sportsbookSignal(row('a', 1000).sportsbook, 1000, 100);
  assert.ok(Math.abs(signal.homeProbability - 2 / 3) < 1e-10);
  assert.throws(() => sportsbookSignal(row('a', 1000).sportsbook, 4000, 100));
  assert.throws(() => sportsbookSignal({ ...row('a', 1000).sportsbook, suspended: true }, 1000, 100));
});

test('later executable quote fills once and includes costs', () => {
  const result = replay([row('a', 1000), row('a', 4000), row('a', 5000)], null, config);
  assert.equal(result.fills, 1);
  assert.equal(result.decisions[1].shares, 23);
  assert.ok(Math.abs(result.finalCash - (100 - 23 * 0.42 + 23)) < 1e-9);
});

test('stale apparent edge cannot fill after price moves', () => {
  assert.equal(replay([row('a', 1000), row('a', 4000, 0.8)], null, config).fills, 0);
  assert.equal(replay([row('a', 1000), row('a', 2000)], null, config).fills, 0);
  assert.equal(replay([row('a', 1000), row('a', 9000)], null, config).fills, 0);
});

test('reject mismatched assets, future quotes, and invalid monetary configuration', () => {
  const changed = row('a', 4000);
  changed.quote.assetId = 'different-contract';
  assert.equal(replay([row('a', 1000), changed], null, config).fills, 0);
  const future = row('a', 1000);
  future.sportsbook.receivedAt = 2000;
  assert.equal(replay([future, row('a', 4000)], null, config).fills, 0);
  assert.throws(() => replay([], null, { ...config, initialCash: NaN }));
});

test('global exposure caps simultaneous games', () => {
  const result = replay([row('a', 1000), row('b', 1000), row('a', 4000), row('b', 4000)], null, config);
  assert.equal(result.fills, 1);
});

test('training isolates future games and produces finite predictions', () => {
  const rows = [];
  for (let i = 0; i < 6; i++) {
    rows.push({ ...row(String(i), 1000 + i * 1000), homeWon: i % 2,
      homeScore: i % 2 ? 70 : 30, resolvedAt: 1500 + i * 1000 });
  }
  const { model, evaluation } = train(rows, 4000);
  assert.deepEqual(model.trainingGames, ['0', '1', '2']);
  assert.equal(evaluation.games, 3);
  assert.ok(predict(model, rows[1]) > predict(model, rows[0]));
  assert.throws(() => replay(rows, model, { ...config, signal: 'model' }), /overlaps/);
  assert.throws(() => train([{ ...rows[0], homeScore: NaN }], 4000));
});

test('pending proposals reserve exposure before matching', () => {
  const result = replay([row('a', 1000), row('b', 1000), row('a', 4000), row('b', 4000)], null, config);
  assert.equal(result.decisions.filter(decision => decision.status === 'proposed').length, 1);
  assert.equal(result.unresolvedProposals, 0);
});

test('partial fills use observed depth and price improvement preserves requested quantity', () => {
  const partial = row('a', 4000);
  partial.quote.askSize = 5;
  const partialResult = replay([row('a', 1000), partial], null, config);
  assert.equal(partialResult.decisions[1].shares, 5);
  const improved = replay([row('a', 1000), row('a', 4000, 0.3)], null, config);
  assert.equal(improved.decisions[1].shares, improved.decisions[0].shares);
});

test('venue matching delay takes precedence over configured delay', () => {
  const proposal = row('a', 1000);
  proposal.quote.secondsDelay = 10;
  assert.equal(replay([proposal, row('a', 4000)], null, config).fills, 0);
  assert.equal(replay([proposal, row('a', 11000)], null, config).fills, 1);
});

test('a gap or changed trading terms cancel a pending proposal before it can fill', () => {
  const proposal = row('a', 1000);
  proposal.quote.termsEpoch = 500;
  const executable = row('a', 4000);
  executable.quote.termsEpoch = 500;
  const gap = row('a', 2000);
  gap.quote.invalidated = true;
  assert.equal(replay([proposal, executable], null, config).fills, 1);
  const afterGap = replay([proposal, gap, executable], null, config);
  assert.equal(afterGap.fills, 0);
  assert.equal(afterGap.unresolvedProposals, 0);
  executable.quote.termsEpoch = 4000;
  assert.equal(replay([proposal, executable], null, config).fills, 0);
});

test('invalid model metadata and duplicate observations fail before replay', () => {
  assert.throws(() => replay([row('a', 1000)], null, { ...config, signal: 'model' }), /trained model/);
  assert.throws(() => replay([row('a', 1000), row('a', 1000)], null, config), /Duplicate/);
});

test('canceled contracts can settle at half value without becoming binary training labels', () => {
  const rows = [row('a', 1000), row('a', 4000)].map(observation => ({
    ...observation, homeWon: null, settlementPayout: 0.5
  }));
  const result = replay(rows, null, config);
  assert.ok(Math.abs(result.finalCash - (100 - 23 * 0.42 + 23 * 0.5)) < 1e-9);
  assert.throws(() => train(rows, 200000), /training games/);
});

test('market fee schedules override fixed assumptions and enforce venue minimums', () => {
  const rows = [row('a', 1000), row('a', 4000)];
  for (const observation of rows) {
    observation.quote.feesEnabled = true;
    observation.quote.feeSchedule = { rate: 0.05, exponent: 1 };
    observation.quote.minOrderSize = 5;
  }
  const result = replay(rows, null, { ...config, feeMode: 'market' });
  assert.equal(result.positions[0].shares, 24);
  assert.equal(result.feesPaid, 0.288);
  assert.equal(replay(rows, null, { ...config, orderBudget: 1, feeMode: 'market' }).fills, 0);
});
