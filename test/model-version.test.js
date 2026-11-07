import test from 'node:test';
import assert from 'node:assert/strict';
import { predict, train } from '../src/model.js';

const row = { homeScore: 80, awayScore: 75, secondsRemaining: 600, pregameHomeProbability: 0.55 };

test('version 1 models keep their original four features', () => {
  const p = predict({ version: 1, weights: [0, 1, 0, 0] }, row);
  assert.equal(p, 1 / (1 + Math.exp(-5 / Math.sqrt(11))));
  assert.throws(() => predict({ version: 1, weights: [0, 1, 0, 0, 0] }, row), /Invalid model/);
});

test('training produces a version 2 model whose leads favor the leader', () => {
  const rows = [];
  for (let g = 0; g < 40; g++) for (let m = 0; m < 4; m++) {
    const homeWon = g % 3 ? 1 : 0;
    const lead = (homeWon ? 1 : -1) * (m + 1) * 3 + (g % 5) - 2;
    rows.push({ gameId: 'g' + g, observedAt: g * 10 + m, resolvedAt: g * 10 + 9, homeWon,
      homeScore: 50 + Math.max(lead, 0), awayScore: 50 + Math.max(-lead, 0),
      secondsRemaining: 2400 - m * 600, pregameHomeProbability: 0.4 + (g % 4) * 0.05 });
  }
  const { model } = train(rows, 300);
  assert.equal(model.version, 2);
  assert.equal(model.weights.length, 5);
  assert.ok(predict(model, { ...row, homeScore: 90 }) > predict(model, { ...row, homeScore: 70 }));
});
